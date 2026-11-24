/**
 * GoldCoast Presentation Resume Builder — ported from the original GoldCoast workspace agent
 * (backend/agents/resume_builder). Same workflow, rules, JSON schema, PDF/DOCX layout and client
 * email; served over MCP so it works in Claude (and ChatGPT) chat, plus a dashboard (MCP App).
 *
 * The server never calls a model: the user's own Claude reads the resume and writes the JSON;
 * the server renders the branded PDF/DOCX, keeps the build, and saves Gmail drafts.
 *
 * Original tool → MCP tool:
 *   get_branding_info            → resume_get_branding (also returns the playbook)
 *   list_uploaded_documents      → resume_list_uploads
 *   extract_resume_text          → resume_read_upload
 *   generate_presentation_resume → resume_generate
 * New: resume_open_builder (dashboard), resume_get_build / resume_list_builds (revisions, history).
 */
import { z } from "zod";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { registerAppTool } from "@modelcontextprotocol/ext-apps/server";
import type { GcPlugin, PluginContext } from "../../core/plugin.js";
import { consultantEmailsFor, loadBranding } from "./branding.js";
import { DASHBOARD_URI, registerResumeDashboard, buildSummary } from "./dashboard.js";
import { downloadUrl, fileRoutes } from "./files.js";
import { INSTRUCTIONS, PLAYBOOK } from "./prompts.js";
import { clientEmailInput, contentReviewInput, intakeInput, normalizeResume, resumeDataInput } from "./schema.js";
import { BUILD_ID_RE, getStore, type Build } from "./store.js";
import { getUpload, listUploads, UPLOAD_ID_RE } from "./uploads.js";

const text = (data: unknown, isError = false): CallToolResult => ({
  content: [{ type: "text", text: typeof data === "string" ? data : JSON.stringify(data) }],
  ...(typeof data === "object" && data !== null && !Array.isArray(data) ? { structuredContent: data as Record<string, unknown> } : {}),
  ...(isError && { isError: true }),
});
const fail = (message: string) => text(message, true);

const uiMeta = {
  ui: { resourceUri: DASHBOARD_URI },
  "openai/outputTemplate": DASHBOARD_URI,
  "openai/widgetAccessible": true,
};

/** What resume_generate / resume_get_build hand back to the model. */
export function buildResult(ctx: PluginContext, b: Build) {
  return {
    build_id: b.id,
    version: b.version,
    candidate: b.resume.candidate_name,
    position_applied: b.resume.position_applied,
    consultant_email: b.consultant_email,
    pdf_url: downloadUrl(ctx.env, b, "pdf"),
    docx_url: downloadUrl(ctx.env, b, "docx"),
  };
}

export const resumeBuilderPlugin: GcPlugin = {
  id: "resume-builder",
  name: "Resume Builder",
  description: "Converts candidate resumes into GoldCoast-branded presentation resumes (PDF + DOCX) with a draft client email.",
  instructions: INSTRUCTIONS,

  async init(env, log) {
    const store = getStore(env.raw);
    log.info("resume_store_ready", { persistent: store.persistent });
  },

  routes(app, { env, log, limiter }) {
    fileRoutes(app, env, getStore(env.raw), limiter, log);
  },

  register(server, ctx) {
    const store = getStore(ctx.env.raw);
    const owner = ctx.user.sub;

    registerResumeDashboard(server, ctx, store);

    registerAppTool(
      server,
      "resume_open_builder",
      {
        title: "Open the Resume Builder",
        description:
          "Use when the user wants to start a presentation resume and hasn't attached the resume to the chat, or asks to open the Resume Builder / see past resumes. Opens the GoldCoast Resume Builder dashboard: upload a resume, fill in the intake, and see, edit, download and email finished presentation resumes.",
        inputSchema: { build_id: z.string().regex(BUILD_ID_RE).optional().describe("Open this build directly") },
        annotations: { readOnlyHint: true, openWorldHint: false },
        _meta: { ...uiMeta, "openai/toolInvocation/invoking": "Opening the Resume Builder…", "openai/toolInvocation/invoked": "Resume Builder ready" },
      },
      async ({ build_id }) => text({ opened: true, ...(build_id ? { build_id } : {}), note: "The Resume Builder dashboard is open. Don't repeat its contents." }),
    );

    server.registerTool(
      "resume_get_branding",
      {
        title: "Get branding and the Resume Builder playbook",
        description:
          "Call first, before building or revising any presentation resume. Returns company branding (company_name — copy it exactly into the client email subject; phone; website), the consultant emails for the letterhead (the signed-in recruiter's first when listed), and the Resume Builder playbook: the workflow, formatting rules, JSON schema and output format to follow.",
        inputSchema: {},
        annotations: { readOnlyHint: true, openWorldHint: false },
      },
      async () => {
        const b = loadBranding(ctx.env.raw);
        const result = {
          company_name: b.company_name,
          company_phone: b.company_phone,
          company_website: b.company_website,
          consultant_emails: consultantEmailsFor(b, ctx.user.email),
          signed_in_email: ctx.user.email,
          playbook: PLAYBOOK,
        };
        return { content: [{ type: "text", text: JSON.stringify(result) }] };
      },
    );

    server.registerTool(
      "resume_list_uploads",
      {
        title: "List uploaded resumes",
        description: "List resumes this user recently uploaded in the Resume Builder dashboard (kept for 2 hours). Use to find an upload_id when the user says they uploaded a resume.",
        inputSchema: {},
        annotations: { readOnlyHint: true, openWorldHint: false },
      },
      async () =>
        text({
          uploads: listUploads(owner).map((u) => ({
            upload_id: u.id,
            file_name: u.fileName,
            pages: u.extracted.pages,
            candidate_guess: u.candidateGuess,
            uploaded_at: new Date(u.createdAt).toISOString(),
          })),
        }),
    );

    server.registerTool(
      "resume_read_upload",
      {
        title: "Read an uploaded resume",
        description:
          "Get the full text of a resume uploaded in the Resume Builder dashboard (PDF, DOCX or TXT), by its upload_id. Scanned PDFs also come back as page images to read. (A resume attached directly to the chat doesn't need this — read it yourself.)",
        inputSchema: { upload_id: z.string().regex(UPLOAD_ID_RE).describe("upload_id from the dashboard message or resume_list_uploads") },
        annotations: { readOnlyHint: true, openWorldHint: false },
      },
      async ({ upload_id }) => {
        const u = getUpload(upload_id, owner);
        if (!u) return fail("That upload has expired or isn't yours (uploads are kept for 2 hours). Ask the user to upload the resume again or attach it to the chat.");
        const content: CallToolResult["content"] = [
          { type: "text", text: `Resume "${u.fileName}" (${u.extracted.kind.toUpperCase()}, ${u.extracted.pages} page(s)):\n\n${u.extracted.text}` },
        ];
        if (u.extracted.images.length) {
          content.push({ type: "text", text: "This looks like a scan with little or no text layer; read the page images below." });
          for (const data of u.extracted.images) content.push({ type: "image", data, mimeType: "image/jpeg" });
        }
        return { content };
      },
    );

    registerAppTool(
      server,
      "resume_generate",
      {
        title: "Generate the presentation resume",
        description:
          "Generate the branded GoldCoast presentation resume (PDF + DOCX) from the structured resume JSON defined in the playbook, and save it as a build. Returns build_id and the PDF and DOCX download links, and shows the result in the Resume Builder dashboard. To revise, call again with the same build_id. Also pass intake, client_email and content_review as the playbook describes.",
        inputSchema: {
          resume_data: resumeDataInput.describe("Structured resume JSON matching the playbook's schema"),
          consultant_email: z.string().trim().min(3).max(200).describe("The consultant email to display in the letterhead"),
          build_id: z.string().regex(BUILD_ID_RE).optional().describe("Update this existing build instead of creating a new one"),
          upload_id: z.string().regex(UPLOAD_ID_RE).optional().describe("The dashboard upload this resume came from"),
          source_file_name: z.string().max(200).optional().describe("The original resume's file name"),
          intake: intakeInput.optional(),
          client_email: clientEmailInput.optional().describe("Draft client email: subject = its first line; body = the rest, plain text"),
          content_review: contentReviewInput.optional(),
        },
        annotations: { readOnlyHint: false, openWorldHint: false, idempotentHint: false },
        _meta: { ...uiMeta, "openai/toolInvocation/invoking": "Building the presentation resume…", "openai/toolInvocation/invoked": "Presentation resume ready" },
      },
      async (args) => {
        const resume = normalizeResume(args.resume_data);
        const upload = args.upload_id ? getUpload(args.upload_id, owner) : null;
        const source = { file_name: args.source_file_name ?? upload?.fileName, upload_id: args.upload_id };
        let build: Build | null;
        if (args.build_id) {
          const prev = store.get(args.build_id, owner);
          if (!prev) return fail("That build wasn't found (or isn't yours). Call resume_generate without build_id to create a new one.");
          build = store.update(args.build_id, owner, {
            resume,
            consultant_email: args.consultant_email,
            intake: { ...prev.intake, ...args.intake },
            client_email: args.client_email ?? prev.client_email,
            content_review: args.content_review ?? prev.content_review,
            source: { ...prev.source, ...Object.fromEntries(Object.entries(source).filter(([, v]) => v)) },
          });
        } else {
          build = store.create(owner, {
            resume,
            consultant_email: args.consultant_email,
            intake: args.intake ?? {},
            client_email: args.client_email ?? null,
            content_review: args.content_review ?? null,
            source,
          });
        }
        ctx.log.info("resume_generated", { user: ctx.user.email, updated: Boolean(args.build_id) });
        const r = buildResult(ctx, build!);
        return {
          content: [
            {
              type: "text",
              text: `Both files generated successfully!\n\nPDF download: ${r.pdf_url}\n\nDOCX download: ${r.docx_url}\n\nCandidate: ${resume.candidate_name}\nbuild_id: ${r.build_id} (pass it to gmail_create_draft as resume_build_id, or to resume_generate to revise)`,
            },
          ],
          structuredContent: { ...r, view: "build", summary: buildSummary(build!) },
        };
      },
    );

    server.registerTool(
      "resume_get_build",
      {
        title: "Get a saved presentation resume",
        description: "Get a saved build's structured resume JSON, letterhead email, intake, client email and content review — use before revising it with resume_generate (same build_id).",
        inputSchema: { build_id: z.string().regex(BUILD_ID_RE) },
        annotations: { readOnlyHint: true, openWorldHint: false },
      },
      async ({ build_id }) => {
        const b = store.get(build_id, owner);
        if (!b) return fail("That build wasn't found (or isn't yours). Use resume_list_builds to find it.");
        return text({ ...buildResult(ctx, b), resume_data: b.resume, intake: b.intake, client_email: b.client_email, content_review: b.content_review, source: b.source });
      },
    );

    server.registerTool(
      "resume_list_builds",
      {
        title: "List presentation resumes",
        description: "List this recruiter's saved presentation resumes, newest first. Optional search by candidate name or position.",
        inputSchema: { query: z.string().max(100).optional(), limit: z.number().int().min(1).max(50).optional() },
        annotations: { readOnlyHint: true, openWorldHint: false },
      },
      async ({ query, limit }) => {
        const q = query?.toLowerCase().trim();
        const builds = store
          .list(owner)
          .filter((b) => !q || `${b.resume.candidate_name} ${b.resume.position_applied ?? ""}`.toLowerCase().includes(q))
          .slice(0, limit ?? 20);
        return text({ builds: builds.map((b) => ({ ...buildSummary(b), pdf_url: downloadUrl(ctx.env, b, "pdf") })) });
      },
    );
  },
};
