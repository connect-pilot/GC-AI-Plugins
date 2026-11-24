// End-to-end check against a running server (npm run dev): plays the part of Claude over MCP.
// Usage: npm run smoke [-- http://localhost:8787/mcp]   (AUTH_DISABLED=true locally, or set MCP_URL with /mcp/<key>)
import { readFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SAMPLE_RESUME } from "../test/fixtures/sample-resume.js";

const url = process.argv[2] ?? process.env.MCP_URL ?? "http://localhost:8787/mcp";
const client = new Client({ name: "gc-smoke", version: "1.0.0" });
await client.connect(new StreamableHTTPClientTransport(new URL(url)));

const tools = await client.listTools();
console.log("tools:", tools.tools.map((t) => t.name).join(", "));

const callJson = async (name: string, args: Record<string, unknown> = {}) => {
  const r = await client.callTool({ name, arguments: args });
  const text = (r.content as { type: string; text?: string }[]).find((c) => c.type === "text")?.text ?? "";
  return { r, data: (r.structuredContent as Record<string, unknown>) ?? (() => { try { return JSON.parse(text); } catch { return { text }; } })() };
};

const branding = (await callJson("resume_get_branding")).data as { company_name: string; consultant_emails: string[]; playbook: string };
console.log("branding:", branding.company_name, branding.consultant_emails, `playbook ${branding.playbook.length} chars`);

// Dashboard upload of a "raw resume" (any PDF works; use the sample render if present).
let uploadId: string | undefined;
try {
  const pdf = readFileSync("samples/sample.pdf");
  const up = (await callJson("resume_dashboard_upload", { file_name: "Jordan Example Resume.pdf", data_base64: pdf.toString("base64") })).data as { upload_id: string; pages: number; candidate_guess: string };
  uploadId = up.upload_id;
  console.log("upload:", up.upload_id, up.pages, "pages, guess:", up.candidate_guess);
  const read = await client.callTool({ name: "resume_read_upload", arguments: { upload_id: up.upload_id } });
  console.log("read_upload:", ((read.content as { text?: string }[])[0]?.text ?? "").slice(0, 120).replace(/\n/g, " ⏎ "), "…");
} catch {
  console.log("upload: skipped (run `npm run sample` first)");
}

const gen = await callJson("resume_generate", {
  resume_data: SAMPLE_RESUME,
  consultant_email: branding.consultant_emails[0] ?? "recruiter@example.com",
  ...(uploadId ? { upload_id: uploadId } : {}),
  intake: { compensation_recent: "$165k/yr + PD", compensation_requested: "$175–185k/yr + PD", internal_references: ["Pat Reference"], candidate_email: "jordan@example.com", candidate_phone: "(555) 010-0199", candidate_location: "Columbus, OH" },
  client_email: {
    subject: `${branding.company_name} | ${SAMPLE_RESUME.position_applied} | ${SAMPLE_RESUME.candidate_name}`,
    body: "Location: Columbus, OH\n\nEmail: jordan@example.com\nPhone: (555) 010-0199\n\nCompensation (recent): $165k/yr + PD\n\nCompensation (requested): $175–185k/yr + PD\n\nInternal References Provided:\n\nPat Reference\n\nNotes:\n\n- 14 years delivering utility-scale solar, substation and transmission projects.\n- Currently leads a 350 MW, $240M solar + storage build with 6 direct reports.",
  },
  content_review: { included: ["Professional Summary ✓", "3 companies, 4 roles (all jobs preserved) ✓", "16 skills ✓"], omitted: ["Personal email: jordan@example.com → moved to client email draft"], enhanced: ["Paragraph descriptions converted to bullet points"] },
});
const g = gen.data as { build_id: string; pdf_url: string; docx_url: string };
console.log("generate:", g.build_id, "\n  pdf:", g.pdf_url.slice(0, 90) + "…");

for (const [fmt, u] of [["pdf", g.pdf_url], ["docx", g.docx_url]] as const) {
  const res = await fetch(u);
  const buf = Buffer.from(await res.arrayBuffer());
  console.log(`download ${fmt}:`, res.status, res.headers.get("content-type"), `${buf.length} bytes`, res.headers.get("content-disposition"));
}

console.log("gmail:", JSON.stringify((await callJson("gmail_check_connection")).data));
console.log("list_builds:", ((await callJson("resume_list_builds")).data as { builds: unknown[] }).builds.length, "build(s)");
await client.close();
