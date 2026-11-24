import { describe, expect, it } from "vitest";
import { letterheadSuggestions, loadBranding, loadLogo } from "../src/plugins/resume-builder/branding.js";
import { renderResumeDocx } from "../src/plugins/resume-builder/docx.js";
import { detectKind, extractResume, ExtractError } from "../src/plugins/resume-builder/extract.js";
import { pdfSafe, renderResumePdf } from "../src/plugins/resume-builder/pdf.js";
import { displayName, formatCandidateFilename, normalizeResume, resumeDataInput } from "../src/plugins/resume-builder/schema.js";
import { BuildStore } from "../src/plugins/resume-builder/store.js";
import { SAMPLE_RESUME } from "./fixtures/sample-resume.js";

const data = normalizeResume(resumeDataInput.parse(SAMPLE_RESUME));
const branding = loadBranding({});
const letterhead = { email: "recruiter@example.com", phone: "(555) 010-0100", website: "www.example.com" };

describe("schema", () => {
  it("formats file names like the original (Last, First)", () => {
    expect(formatCandidateFilename("Aaron E. Ezrilov")).toBe("Ezrilov, Aaron");
    expect(formatCandidateFilename("")).toBe("Candidate");
  });
  it("renders nicknames as FIRST “NICK” LAST", () => {
    expect(displayName({ candidate_name: "Jordan A. Example", nickname: "Jay" })).toBe("Jordan “Jay” A. Example");
  });
  it("is lenient: nulls, string certifications, unknown sections", () => {
    const d = normalizeResume(resumeDataInput.parse({ candidate_name: " Pat  Smith ", certifications: ["OSHA 10"], section_order: ["work", "bogus"], skills: null }));
    expect(d.candidate_name).toBe("Pat Smith");
    expect(d.certifications).toEqual([{ name: "OSHA 10", dates: null }]);
    expect(d.section_order).toEqual(["work"]);
    expect(d.skills).toEqual([]);
  });
  it("defaults branding to the exact company name", () => {
    expect(loadBranding({}).company_name).toBe("GoldCoast Search Group");
  });
});

describe("renderers", () => {
  it("renders a multi-page PDF whose text round-trips", async () => {
    const pdf = await renderResumePdf(data, letterhead, branding, loadLogo({}));
    expect(pdf.subarray(0, 4).toString()).toBe("%PDF");
    const back = await extractResume("x.pdf", pdf);
    expect(back.pages).toBe(2);
    expect(back.text).toContain("PROFESSIONAL EXPERIENCE");
    expect(back.text).toContain("August 2022 to Present");
    expect(back.text).toContain("Proprietary and Confidential © GoldCoast Search Group");
    expect(back.text).toContain("(555) 010-0100");
    expect(back.text).toContain("www.example.com");
  });
  it("renders a DOCX whose text round-trips", async () => {
    const docx = await renderResumeDocx(data, letterhead, branding, loadLogo({}));
    const back = await extractResume("x.docx", docx);
    expect(back.text).toContain("SKILLS");
    expect(back.text).toContain("Sunfield Energy Constructors");
  });
  it("keeps WinAnsi characters and approximates the rest", () => {
    expect(pdfSafe("Résumé – “Jay” → 5 ✓")).toBe("Résumé – “Jay” -> 5 ");
  });
});

describe("letterhead suggestions", () => {
  it("offers the signed-in email first, then recent ones, and prefills the last letterhead", () => {
    const recent = [
      { email: "b@gc.com", phone: "(555) 2", website: "gc.com" },
      { email: "a@gc.com", phone: "(555) 1", website: "gc.com" },
    ];
    const s = letterheadSuggestions(recent, "a@gc.com");
    expect(s.emails).toEqual(["a@gc.com", "b@gc.com"]);
    expect(s.websites).toEqual(["gc.com"]);
    expect(s.last?.phone).toBe("(555) 2");
    expect(letterheadSuggestions([], "local-dev@localhost").emails).toEqual([]);
  });
});

describe("extract", () => {
  it("rejects old .doc files with a helpful message", () => {
    expect(() => detectKind("resume.doc", new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0]))).toThrow(ExtractError);
  });
  it("reads plain text", async () => {
    const r = await extractResume("r.txt", Buffer.from("Pat Smith\nElectrician"));
    expect(r.text).toContain("Electrician");
  });
});

describe("store", () => {
  it("scopes builds to their owner and bumps versions", () => {
    const s = new BuildStore(null, 180);
    const b = s.create("alice", { resume: data, consultant_email: "a@x.com", intake: {}, client_email: null, content_review: null, source: {} });
    expect(s.get(b.id, "bob")).toBeNull();
    expect(s.update(b.id, "alice", { consultant_email: "b@x.com" })?.version).toBe(2);
    expect(s.list("alice")).toHaveLength(1);
    expect(s.list("bob")).toHaveLength(0);
  });
});
