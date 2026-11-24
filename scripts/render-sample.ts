// Renders the fictional sample candidate to samples/ (PDF + DOCX) to eyeball the layout.
import { mkdirSync, writeFileSync } from "node:fs";
import { loadBranding, loadLogo } from "../src/plugins/resume-builder/branding.js";
import { renderResumeDocx } from "../src/plugins/resume-builder/docx.js";
import { renderResumePdf } from "../src/plugins/resume-builder/pdf.js";
import { normalizeResume, resumeDataInput } from "../src/plugins/resume-builder/schema.js";
import { SAMPLE_RESUME } from "../test/fixtures/sample-resume.js";

const env = process.env;
const letterhead = { email: "recruiter@example.com", phone: "(555) 010-0100", website: "www.example.com" };
const branding = loadBranding(env);
const data = normalizeResume(resumeDataInput.parse(SAMPLE_RESUME));
mkdirSync("samples", { recursive: true });
writeFileSync("samples/sample.pdf", await renderResumePdf(data, letterhead, branding, loadLogo(env)));
writeFileSync("samples/sample.docx", await renderResumeDocx(data, letterhead, branding, loadLogo(env)));
console.log("Wrote samples/sample.pdf and samples/sample.docx");
