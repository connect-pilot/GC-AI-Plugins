/**
 * The Resume Builder dashboard (an MCP App): one self-contained HTML page (ui/resume-builder,
 * built by vite into dist/ui/resume-builder/index.html) plus app-only tools it calls through the
 * host. The model never sees these tools; extracted resume text and edits reach Claude only
 * through messages the user sends (e.g. "Build with Claude").
 */
import { readFile } from "node:fs/promises";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { registerAppResource, registerAppTool, RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import type { PluginContext } from "../../core/plugin.js";
import { getGmail, GmailError, GmailNotConnected } from "../../google/gmail.js";
import { letterheadSuggestions, loadBranding } from "./branding.js";
import { ExtractError, extractResume, guessName, MAX_RESUME_BYTES } from "./extract.js";
import { downloadUrl, fileName, MIME, renderBuild, type Format } from "./files.js";
import { clientEmailInput, intakeInput, normalizeResume, resumeDataInput } from "./schema.js";
import { BUILD_ID_RE, letterheadOf, type Build, type BuildStore } from "./store.js";
import { holdUpload, UPLOAD_TTL_MS } from "./uploads.js";

export const DASHBOARD_URI = "ui://gc-resume-builder/v1.html";

/** Single-file UI built by `npm run build` into dist/ui/<name>/index.html. */
export async function loadUiHtml(name: "resume-builder"): Promise<string> {
  const candidates = [new URL(`../../ui/${name}/index.html`, import.meta.url), new URL(`../../../dist/ui/${name}/index.html`, import.meta.url)];
  for (const file of candidates) {
    try {
      return await readFile(file, "utf8");
    } catch {
      // try the next location
    }
  }
  throw new Error(`The ${name} UI has not been built. Run \`npm run build\`.`);
}

function view(data: { status: string } & Record<string, unknown>, isError = false): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data) }], structuredContent: data, ...(isError && { isError: true }) };
}
const ok = (data: Record<string, unknown> = {}) => view({ status: "success", ...data });
const failure = (status: string, message: string) => view({ status, message }, true);

const appOnly = {
  ui: { resourceUri: DASHBOARD_URI, visibility: ["app" as const] },
  "openai/visibility": "private",
  "openai/widgetAccessible": true,
};

export function buildSummary(b: Build) {
  return {
    id: b.id,
    candidate: b.resume.candidate_name,
    position: b.resume.position_applied,
    consultant_email: b.consultant_email,
    letterhead: letterheadOf(b),
    created_at: b.created_at,
    updated_at: b.updated_at,
    version: b.version,
    source_file: b.source.file_name ?? null,
    upload_id: b.source.upload_id ?? null,
    gmail_drafts: b.gmail_drafts.length,
    last_draft_url: b.gmail_drafts[0]?.url ?? null,
  };
}

const EMAILS = z.array(z.string().trim().email().max(200)).max(20);

export function registerResumeDashboard(server: McpServer, ctx: PluginContext, store: BuildStore) {
  const owner = ctx.user.sub;
  const gmail = getGmail(ctx.env, ctx.log);

  const fullBuild = (b: Build) => ({
    ...b,
    summary: buildSummary(b),
    pdf_url: downloadUrl(ctx.env, b, "pdf"),
    docx_url: downloadUrl(ctx.env, b, "docx"),
    file_names: { pdf: fileName(b, "pdf", ctx.env.raw), docx: fileName(b, "docx", ctx.env.raw) },
  });

  registerAppResource(server, "gc-resume-builder", DASHBOARD_URI, { mimeType: RESOURCE_MIME_TYPE }, async () => ({
    contents: [
      {
        uri: DASHBOARD_URI,
        mimeType: RESOURCE_MIME_TYPE,
        text: await loadUiHtml("resume-builder"),
        _meta: { ui: { prefersBorder: false, csp: { resourceDomains: ["https://fonts.googleapis.com", "https://fonts.gstatic.com"] } } },
      },
    ],
  }));

  registerAppTool(
    server,
    "resume_dashboard_data",
    {
      title: "Resume Builder data",
      description: "Dashboard only: branding, consultant emails, Gmail status and this recruiter's saved builds.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
      _meta: appOnly,
    },
    async () => {
      const b = loadBranding(ctx.env.raw);
      return ok({
        user: { email: ctx.user.email, name: ctx.user.name ?? null },
        branding: { company_name: b.company_name },
        letterhead: letterheadSuggestions(store.recentLetterheads(owner), ctx.user.email),
        gmail: gmail.status(ctx.user),
        persistent: store.persistent,
        max_upload_mb: MAX_RESUME_BYTES / 1024 / 1024,
        builds: store.list(owner).map(buildSummary),
      });
    },
  );

  registerAppTool(
    server,
    "resume_dashboard_upload",
    {
      title: "Upload a resume",
      description: "Dashboard only: read an uploaded resume (PDF, DOCX or TXT) and hold its text for Claude for 2 hours.",
      inputSchema: { file_name: z.string().trim().min(1).max(200), data_base64: z.string().max(Math.ceil((MAX_RESUME_BYTES * 4) / 3) + 8) },
      annotations: { readOnlyHint: false, openWorldHint: false },
      _meta: appOnly,
    },
    async ({ file_name, data_base64 }) => {
      try {
        const bytes = Buffer.from(data_base64, "base64");
        const extracted = await extractResume(file_name, bytes);
        const u = holdUpload(owner, file_name, extracted, guessName(extracted.text));
        ctx.log.info("resume_uploaded", { kind: extracted.kind, pages: extracted.pages });
        return ok({
          upload_id: u.id,
          file_name,
          kind: extracted.kind,
          pages: extracted.pages,
          words: extracted.text.split(/\s+/).filter(Boolean).length,
          scanned: extracted.images.length > 0,
          candidate_guess: u.candidateGuess,
          expires_in_minutes: UPLOAD_TTL_MS / 60_000,
        });
      } catch (err) {
        if (err instanceof ExtractError) return failure("invalid_file", err.message);
        ctx.log.error("resume_upload_failed", { error: (err as Error).name });
        return failure("error", "The resume couldn't be read. Try again, or attach it in the chat instead.");
      }
    },
  );

  registerAppTool(
    server,
    "resume_dashboard_build",
    {
      title: "Open a build",
      description: "Dashboard only: a saved build with its download links.",
      inputSchema: { id: z.string().regex(BUILD_ID_RE) },
      annotations: { readOnlyHint: true, openWorldHint: false },
      _meta: appOnly,
    },
    async ({ id }) => {
      const b = store.get(id, owner);
      return b ? ok({ build: fullBuild(b) }) : failure("not_found", "That resume wasn't found. It may have been deleted.");
    },
  );

  registerAppTool(
    server,
    "resume_dashboard_save",
    {
      title: "Save edits to a build",
      description: "Dashboard only: save the recruiter's edits (resume content, letterhead email, client email, intake).",
      inputSchema: {
        id: z.string().regex(BUILD_ID_RE),
        version: z.number().int().optional().describe("The version the edits were made on"),
        resume_data: resumeDataInput.optional(),
        consultant_email: z.string().trim().min(3).max(200).optional(),
        letterhead_phone: z.string().trim().max(60).optional(),
        letterhead_website: z.string().trim().max(200).optional(),
        client_email: clientEmailInput.optional(),
        intake: intakeInput.optional(),
      },
      annotations: { readOnlyHint: false, openWorldHint: false },
      _meta: appOnly,
    },
    async ({ id, version, resume_data, consultant_email, letterhead_phone, letterhead_website, client_email, intake }) => {
      const prev = store.get(id, owner);
      if (!prev) return failure("not_found", "That resume wasn't found. It may have been deleted.");
      if (version !== undefined && version !== prev.version) {
        return failure("conflict", "This resume changed since you opened it (Claude may have revised it). Reload it, then make your edits again.");
      }
      const b = store.update(id, owner, {
        ...(resume_data ? { resume: normalizeResume(resume_data) } : {}),
        ...(consultant_email ? { consultant_email } : {}),
        ...(letterhead_phone !== undefined ? { letterhead_phone } : {}),
        ...(letterhead_website !== undefined ? { letterhead_website } : {}),
        ...(client_email ? { client_email } : {}),
        ...(intake ? { intake: { ...prev.intake, ...intake } } : {}),
      });
      return ok({ build: fullBuild(b!) });
    },
  );

  registerAppTool(
    server,
    "resume_dashboard_file",
    {
      title: "Get a resume file",
      description: "Dashboard only: the rendered PDF or DOCX (base64) for download or preview.",
      inputSchema: { id: z.string().regex(BUILD_ID_RE), format: z.enum(["pdf", "docx"]) },
      annotations: { readOnlyHint: true, openWorldHint: false },
      _meta: appOnly,
    },
    async ({ id, format }) => {
      const b = store.get(id, owner);
      if (!b) return failure("not_found", "That resume wasn't found.");
      try {
        const bytes = await renderBuild(b, format as Format, ctx.env.raw);
        return ok({ file_name: fileName(b, format as Format, ctx.env.raw), mime_type: MIME[format as Format], data_base64: bytes.toString("base64"), url: downloadUrl(ctx.env, b, format as Format) });
      } catch (err) {
        ctx.log.error("resume_render_failed", { error: (err as Error).name });
        return failure("error", "The file couldn't be generated. Try again.");
      }
    },
  );

  registerAppTool(
    server,
    "resume_dashboard_delete",
    {
      title: "Delete a build",
      description: "Dashboard only: delete a saved presentation resume. Its download links stop working.",
      inputSchema: { id: z.string().regex(BUILD_ID_RE) },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
      _meta: appOnly,
    },
    async ({ id }) => {
      if (!store.get(id, owner)) return failure("not_found", "That resume wasn't found.");
      store.delete(id);
      return ok();
    },
  );

  registerAppTool(
    server,
    "resume_dashboard_gmail_draft",
    {
      title: "Create a Gmail draft",
      description: "Dashboard only: save the client email as a draft in the recruiter's own Gmail with the resume attached. Never sends.",
      inputSchema: {
        id: z.string().regex(BUILD_ID_RE),
        to: EMAILS.optional(),
        cc: EMAILS.optional(),
        subject: z.string().max(500),
        body: z.string().max(20_000),
        attach: z.array(z.enum(["pdf", "docx"])).max(2).optional(),
      },
      annotations: { readOnlyHint: false, openWorldHint: true },
      _meta: appOnly,
    },
    async ({ id, to, cc, subject, body, attach }) => {
      const b = store.get(id, owner);
      if (!b) return failure("not_found", "That resume wasn't found.");
      try {
        const formats = (attach ?? ["pdf"]) as Format[];
        const attachments = await Promise.all(
          [...new Set(formats)].map(async (f) => ({ fileName: fileName(b, f, ctx.env.raw), mimeType: MIME[f], bytes: await renderBuild(b, f, ctx.env.raw) })),
        );
        const r = await gmail.createDraft(ctx.user, { subject, body, to, cc, attachments });
        store.recordDraft(b.id, owner, { at: new Date().toISOString(), url: r.gmailUrl, to: to ?? [] });
        // Keep the edited email with the build.
        store.update(b.id, owner, { client_email: { subject, body } });
        return ok({ gmail_url: r.gmailUrl, account: r.account, build: fullBuild(store.get(b.id, owner)!) });
      } catch (err) {
        if (err instanceof GmailNotConnected) return view({ status: "gmail_not_connected", message: err.message, connect_url: err.connectUrl }, true);
        if (err instanceof GmailError) return failure("gmail_error", err.message);
        ctx.log.error("gmail_draft_failed", { error: (err as Error).name });
        return failure("error", "The Gmail draft couldn't be created. Try again.");
      }
    },
  );

  registerAppTool(
    server,
    "resume_dashboard_gmail_disconnect",
    {
      title: "Disconnect Gmail",
      description: "Dashboard only: forget the Gmail account connected with Connect Gmail (shared-key mode).",
      inputSchema: {},
      annotations: { readOnlyHint: false, openWorldHint: false },
      _meta: appOnly,
    },
    async () => {
      gmail.disconnect(ctx.user);
      return ok({ gmail: gmail.status(ctx.user) });
    },
  );
}
