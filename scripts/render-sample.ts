// Renders the fictional sample candidate to samples/ (PDF + DOCX) to eyeball the layout.
import { mkdirSync, writeFileSync } from "node:fs";
import { loadBranding, loadLogo } from "../src/plugins/resume-builder/branding.js";
import { renderResumeDocx } from "../src/plugins/resume-builder/docx.js";
import { renderResumePdf } from "../src/plugins/resume-builder/pdf.js";
import { normalizeResume, resumeDataInput } from "../src/plugins/resume-builder/schema.js";
import { SAMPLE_RESUME } from "../test/fixtures/sample-resume.js";

const env = { COMPANY_PHONE: "(555) 010-0100", COMPANY_WEBSITE: "www.example.com", ...process.env };
const branding = loadBranding(env);
const data = normalizeResume(resumeDataInput.parse(SAMPLE_RESUME));
mkdirSync("samples", { recursive: true });
writeFileSync("samples/sample.pdf", await renderResumePdf(data, "recruiter@example.com", branding, loadLogo(env)));
writeFileSync("samples/sample.docx", await renderResumeDocx(data, "recruiter@example.com", branding, loadLogo(env)));
console.log("Wrote samples/sample.pdf and samples/sample.docx");
