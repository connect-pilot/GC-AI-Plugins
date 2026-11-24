/**
 * Gmail — ported from the original GoldCoast workspace Gmail agent (backend/agents/gmail).
 * Draft emails (optionally with a presentation resume attached), read and search the inbox.
 *
 * Deliberately left out: the original's send_email. Drafts land in the recruiter's own Gmail for
 * them to review and send themselves; nothing here can send mail.
 *
 * Original tool → MCP tool:
 *   check_gmail_connection → gmail_check_connection
 *   create_gmail_draft     → gmail_create_draft (documentId → resume_build_id + attach)
 *   list_recent_emails     → gmail_list_recent_emails
 *   get_email              → gmail_get_email
 *   search_emails          → gmail_search_emails
 */
import { z } from "zod";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { GcPlugin } from "../../core/plugin.js";
import { getGmail, GmailError, GmailNotConnected } from "../../google/gmail.js";
import { fileName, MIME, renderBuild, type Format } from "../resume-builder/files.js";
import { BUILD_ID_RE, getStore } from "../resume-builder/store.js";

const INSTRUCTIONS = `
Gmail for GoldCoast recruiters: draft emails (optionally with a presentation resume attached) in the recruiter's own Gmail, and read or search their inbox. Drafts only — nothing is ever sent; the recruiter reviews and sends from Gmail.
- Call gmail_check_connection first. If it isn't connected, show the connect link from its response and wait for the user to finish.
- To attach a presentation resume, pass resume_build_id (the build_id from resume_generate); the PDF is attached by default.
- After creating a draft, give the user the Gmail link: "[Open draft in Gmail](url)".
- When listing emails, show a clean numbered list (sender, subject, date, snippet), at most 10–15 at a time. Gmail search syntax works (from:, to:, subject:, has:attachment, before:, after:).
- Never fabricate email content or claim to have read or drafted an email without the tools.
`.trim();

const json = (data: unknown): CallToolResult => ({ content: [{ type: "text", text: JSON.stringify(data) }] });
const fail = (message: string): CallToolResult => ({ isError: true, content: [{ type: "text", text: message }] });

function gmailFailure(err: unknown, log: { error(m: string, f?: Record<string, string>): void }): CallToolResult {
  if (err instanceof GmailNotConnected) return { isError: true, content: [{ type: "text", text: JSON.stringify({ connected: false, message: err.message, connect_url: err.connectUrl }) }] };
  if (err instanceof GmailError) return fail(`Gmail error: ${err.message}`);
  log.error("gmail_failed", { error: (err as Error).name });
  return fail("The Gmail request could not be completed. Please try again.");
}

const recipients = z
  .string()
  .max(1000)
  .optional()
  .transform((s) =>
    (s ?? "")
      .split(/[,;]/)
      .map((x) => x.trim())
      .filter(Boolean),
  )
  .refine((list) => list.every((e) => z.string().email().safeParse(e).success), "Use valid email addresses, comma-separated");

export const gmailPlugin: GcPlugin = {
  id: "gmail",
  name: "Gmail",
  description: "Gmail drafts (with resume attachments), inbox reading and search, in each recruiter's own Gmail.",
  instructions: INSTRUCTIONS,

  routes(app, { env, log, limiter }) {
    if (env.google) getGmail(env, log).routes(app, limiter);
  },

  register(server, ctx) {
    const gmail = getGmail(ctx.env, ctx.log);

    server.registerTool(
      "gmail_check_connection",
      {
        title: "Check Gmail connection",
        description: "Check whether the user's Gmail is connected. Returns the connected account, or the link to connect Gmail if it isn't.",
        inputSchema: {},
        annotations: { readOnlyHint: true, openWorldHint: false },
      },
      async () => json(gmail.status(ctx.user)),
    );

    server.registerTool(
      "gmail_create_draft",
      {
        title: "Create a Gmail draft",
        description:
          "Create a draft in the user's Gmail (never sends). Optionally attach a presentation resume by its build_id. Returns a link to open the draft in Gmail.",
        inputSchema: {
          subject: z.string().max(500).describe("The email subject line"),
          body: z.string().max(20_000).describe("The email body (plain text)"),
          to: recipients.describe("Recipient email address(es), comma-separated (optional — can be filled in Gmail)"),
          cc: recipients.describe("Cc address(es), comma-separated (optional)"),
          resume_build_id: z.string().regex(BUILD_ID_RE).optional().describe("Attach this presentation resume (build_id from resume_generate)"),
          attach: z.enum(["pdf", "docx", "both"]).optional().describe("Which resume file(s) to attach (default pdf)"),
        },
        annotations: { readOnlyHint: false, openWorldHint: true },
      },
      async ({ subject, body, to, cc, resume_build_id, attach }) => {
        try {
          const attachments = [];
          const store = getStore(ctx.env.raw);
          const build = resume_build_id ? store.get(resume_build_id, ctx.user.sub) : null;
          if (resume_build_id && !build) return fail("That presentation resume wasn't found (or isn't yours). Check the build_id with resume_list_builds.");
          if (build) {
            const formats: Format[] = attach === "both" ? ["pdf", "docx"] : [attach ?? "pdf"];
            for (const f of formats) attachments.push({ fileName: fileName(build, f, ctx.env.raw), mimeType: MIME[f], bytes: await renderBuild(build, f, ctx.env.raw) });
          }
          const r = await gmail.createDraft(ctx.user, { subject, body, to, cc, attachments });
          if (build) store.recordDraft(build.id, ctx.user.sub, { at: new Date().toISOString(), url: r.gmailUrl, to });
          return json({ created: true, gmailUrl: r.gmailUrl, draftId: r.draftId, account: r.account, attached: attachments.map((a) => a.fileName) });
        } catch (err) {
          return gmailFailure(err, ctx.log);
        }
      },
    );

    server.registerTool(
      "gmail_list_recent_emails",
      {
        title: "List recent emails",
        description: "List recent emails in the user's Gmail inbox: subject, sender, date and a snippet for each.",
        inputSchema: {
          maxResults: z.number().int().min(1).max(50).optional().describe("Number of emails (default 10, max 50)"),
          query: z.string().max(500).optional().describe("Optional Gmail search query, e.g. from:client@example.com"),
        },
        annotations: { readOnlyHint: true, openWorldHint: true },
      },
      async ({ maxResults, query }) => {
        try {
          return json({ emails: await gmail.listEmails(ctx.user, { maxResults, query }) });
        } catch (err) {
          return gmailFailure(err, ctx.log);
        }
      },
    );

    server.registerTool(
      "gmail_get_email",
      {
        title: "Read an email",
        description: "Get the full content of one email by its ID: subject, sender, recipients, date, body text and attachment names.",
        inputSchema: { emailId: z.string().regex(/^[A-Za-z0-9_-]{6,64}$/).describe("The Gmail message ID") },
        annotations: { readOnlyHint: true, openWorldHint: true },
      },
      async ({ emailId }) => {
        try {
          return json(await gmail.getEmail(ctx.user, emailId));
        } catch (err) {
          return gmailFailure(err, ctx.log);
        }
      },
    );

    server.registerTool(
      "gmail_search_emails",
      {
        title: "Search emails",
        description: "Search the user's Gmail with Gmail search syntax (from:, to:, subject:, has:attachment, before:, after:, …).",
        inputSchema: {
          query: z.string().min(1).max(500).describe("Gmail search query"),
          maxResults: z.number().int().min(1).max(50).optional().describe("Number of results (default 10, max 50)"),
        },
        annotations: { readOnlyHint: true, openWorldHint: true },
      },
      async ({ query, maxResults }) => {
        try {
          return json({ emails: await gmail.listEmails(ctx.user, { maxResults, query }) });
        } catch (err) {
          return gmailFailure(err, ctx.log);
        }
      },
    );
  },
};
