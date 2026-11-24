/**
 * Gmail for the GoldCoast plugins (ported from the original workspace's gmail_service.py).
 *
 * Whose mailbox:
 *  - With Google sign-in on the connector, the signed-in recruiter's own Gmail, using that same
 *    sign-in (the Google refresh token travels sealed inside the token the AI app holds). Only
 *    the hour-long Gmail access token is cached here, in memory.
 *  - Otherwise (shared access key, GOOGLE_SIGN_IN=false), whoever pressed "Connect Gmail". That
 *    connection lives in server memory only; a deploy forgets it.
 *
 * Drafts only: nothing here can send mail (gmail() refuses send calls before they leave the server).
 */
import { createHash, randomBytes } from "node:crypto";
import type { Express, RequestHandler } from "express";
import type { Env } from "../core/env.js";
import type { Logger } from "../core/logger.js";
import type { AuthedUser } from "../core/plugin.js";
import { isAllowed, loadAllowlist, type Allowlist } from "../auth/allowlist.js";
import { GMAIL_SCOPES } from "../auth/google.js";
import { Sealer } from "../auth/seal.js";

export const GMAIL_CALLBACK_PATH = "/gmail/callback";
const GOOGLE_AUTH = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN = "https://oauth2.googleapis.com/token";
const GMAIL = "https://gmail.googleapis.com/gmail/v1/users/me";
const CONNECT_TTL_S = 10 * 60;
const MAX_RAW_BYTES = 30 * 1024 * 1024;

export class GmailNotConnected extends Error {
  constructor(readonly connectUrl: string | null) {
    super(
      connectUrl
        ? "Gmail isn't connected yet. Open the connect link to authorize Gmail drafts, then try again."
        : "Gmail isn't available: the server has no Google client configured (GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET).",
    );
  }
}

export class GmailError extends Error {}

export interface Attachment {
  fileName: string;
  mimeType: string;
  bytes: Uint8Array;
}

export interface DraftInput {
  subject: string;
  body: string;
  to?: string[];
  cc?: string[];
  attachments?: Attachment[];
}

interface Connection {
  email: string;
  refresh: string;
  lastUsed: number;
}

export class Gmail {
  private readonly sealer: Sealer;
  private readonly allow: Allowlist;
  /** sha256(refresh token) → Gmail access token. */
  private readonly accessCache = new Map<string, { access: string; exp: number }>();
  /** Access-key mode only: user sub → the Google account connected with "Connect Gmail". */
  private readonly connections = new Map<string, Connection>();

  constructor(
    private readonly env: Env,
    private readonly log: Logger,
    private readonly http: typeof fetch = fetch,
  ) {
    this.sealer = new Sealer(env.sealSecret);
    this.allow = loadAllowlist(env.raw);
  }

  get configured() {
    return Boolean(this.env.google);
  }

  /** Whether this user's drafts go through the connector's Google sign-in (no Connect step). */
  private viaSignIn(user: AuthedUser) {
    return Boolean(user.googleRefreshToken);
  }

  status(user: AuthedUser): { configured: boolean; connected: boolean; email?: string; via?: "sign-in" | "connect"; connect_url?: string } {
    if (!this.configured) return { configured: false, connected: false };
    if (this.viaSignIn(user)) return { configured: true, connected: true, email: user.email, via: "sign-in" };
    const c = this.connections.get(user.sub);
    if (c) return { configured: true, connected: true, email: c.email, via: "connect" };
    return { configured: true, connected: false, connect_url: this.connectUrl(user) };
  }

  disconnect(user: AuthedUser) {
    this.connections.delete(user.sub);
  }

  /** Google consent link for "Connect Gmail" (access-key mode). */
  connectUrl(user: AuthedUser): string {
    const g = this.env.google!;
    const verifier = randomBytes(32).toString("base64url");
    const state = this.sealer.seal("gmail-state", { sub: user.sub, v: verifier }, CONNECT_TTL_S);
    const q = new URLSearchParams({
      client_id: g.clientId,
      response_type: "code",
      redirect_uri: this.env.publicUrl + GMAIL_CALLBACK_PATH,
      scope: ["openid", "email", ...GMAIL_SCOPES].join(" "),
      state,
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
      code_challenge_method: "S256",
      access_type: "offline",
      prompt: "consent select_account",
    });
    return `${GOOGLE_AUTH}?${q}`;
  }

  private async token(params: Record<string, string>) {
    const g = this.env.google!;
    const res = await this.http(GOOGLE_TOKEN, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: g.clientId, client_secret: g.clientSecret, ...params }),
    });
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok || typeof body.access_token !== "string") {
      throw new GmailError(String(body.error_description ?? body.error ?? `Google answered ${res.status}`));
    }
    return body as { access_token: string; refresh_token?: string; expires_in?: number; id_token?: string };
  }

  async finishConnect(state: string, code: string): Promise<{ ok: true; email: string } | { ok: false; error: string }> {
    const s = this.sealer.open<{ sub: string; v: string }>("gmail-state", state);
    if (!s) return { ok: false, error: "This link expired. Ask for a new Gmail connect link and try again." };
    try {
      const t = await this.token({ grant_type: "authorization_code", code, redirect_uri: this.env.publicUrl + GMAIL_CALLBACK_PATH, code_verifier: s.v });
      if (!t.refresh_token) return { ok: false, error: "Google didn't return a refresh token. Remove the app's access in your Google account and connect again." };
      let email = "";
      try {
        const c = JSON.parse(Buffer.from((t.id_token ?? "").split(".")[1] ?? "", "base64url").toString("utf8")) as { email?: string };
        email = String(c.email ?? "").toLowerCase();
      } catch {
        // checked below
      }
      const allowConfigured = this.allow.domains.length + this.allow.emails.length > 0;
      if (!email || (allowConfigured && !isAllowed(email, this.allow))) {
        this.log.info("gmail_connect_refused", {});
        return { ok: false, error: `${email || "This account"} isn't allowed here. Use your GoldCoast Google account.` };
      }
      this.connections.set(s.sub, { email, refresh: t.refresh_token, lastUsed: Date.now() });
      this.log.info("gmail_connected", {});
      return { ok: true, email };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  }

  private async accessToken(user: AuthedUser): Promise<{ token: string; email: string }> {
    if (!this.configured) throw new GmailNotConnected(null);
    const refresh = user.googleRefreshToken ?? this.connections.get(user.sub)?.refresh;
    const email = user.googleRefreshToken ? user.email : this.connections.get(user.sub)?.email ?? "";
    if (!refresh) throw new GmailNotConnected(this.connectUrl(user));
    const key = createHash("sha256").update(refresh).digest("base64url");
    const now = Date.now();
    for (const [k, v] of this.accessCache) if (v.exp <= now) this.accessCache.delete(k);
    const hit = this.accessCache.get(key);
    if (hit) return { token: hit.access, email };
    try {
      const t = await this.token({ grant_type: "refresh_token", refresh_token: refresh });
      this.accessCache.set(key, { access: t.access_token, exp: now + (t.expires_in ?? 3600) * 1000 - 120_000 });
      const c = this.connections.get(user.sub);
      if (c) c.lastUsed = now;
      return { token: t.access_token, email };
    } catch (err) {
      if (!user.googleRefreshToken) {
        this.connections.delete(user.sub);
        throw new GmailNotConnected(this.connectUrl(user));
      }
      throw new GmailError(`Google refused Gmail access (${(err as Error).message}). Disconnect and reconnect the connector to sign in again.`);
    }
  }

  /** Every Gmail call goes through here, and nothing here can send mail. */
  private async gmail(user: AuthedUser, method: string, path: string, body?: unknown) {
    if (/\/send\b/i.test(path)) throw new GmailError("Sending is not allowed");
    const { token, email } = await this.accessToken(user);
    const res = await this.http(`${GMAIL}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const out = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      const e = out.error as { message?: string } | undefined;
      throw new GmailError(e?.message ?? `Gmail answered ${res.status}`);
    }
    return { out, email };
  }

  /** Save a draft (optionally with attachments) in the user's Gmail Drafts. Never sends. */
  async createDraft(user: AuthedUser, d: DraftInput) {
    const raw = buildMime(d);
    if (raw.length > MAX_RAW_BYTES) throw new GmailError("The draft and its attachments are too large for Gmail.");
    const { out, email } = await this.gmail(user, "POST", "/drafts", { message: { raw } });
    const draftId = String(out.id ?? "");
    const messageId = String((out.message as { id?: string } | undefined)?.id ?? "");
    this.log.info("gmail_draft_created", { to: d.to?.length ?? 0, attachments: d.attachments?.length ?? 0 });
    const account = email ? `authuser=${encodeURIComponent(email)}` : "";
    return { draftId, messageId, gmailUrl: `https://mail.google.com/mail/?${account}#drafts?compose=${messageId}`, account: email };
  }

  async listEmails(user: AuthedUser, opts: { maxResults?: number; query?: string }) {
    const n = Math.min(Math.max(opts.maxResults ?? 10, 1), 50);
    const q = new URLSearchParams({ maxResults: String(n) });
    if (opts.query) q.set("q", opts.query);
    const { out } = await this.gmail(user, "GET", `/messages?${q}`);
    const ids = ((out.messages as { id: string }[] | undefined) ?? []).map((m) => m.id);
    const emails = await Promise.all(
      ids.map(async (id) => {
        const meta = new URLSearchParams({ format: "metadata" });
        for (const h of ["From", "To", "Subject", "Date"]) meta.append("metadataHeaders", h);
        const { out: m } = await this.gmail(user, "GET", `/messages/${encodeURIComponent(id)}?${meta}`);
        const h = headers(m);
        return { id, threadId: m.threadId, subject: h.subject ?? "", from: h.from ?? "", to: h.to ?? "", date: h.date ?? "", snippet: m.snippet ?? "" };
      }),
    );
    return emails;
  }

  async getEmail(user: AuthedUser, id: string) {
    const { out: m } = await this.gmail(user, "GET", `/messages/${encodeURIComponent(id)}?format=full`);
    const h = headers(m);
    const payload = (m.payload ?? {}) as Part;
    return {
      id,
      threadId: m.threadId,
      subject: h.subject ?? "",
      from: h.from ?? "",
      to: h.to ?? "",
      date: h.date ?? "",
      body: bodyText(payload).slice(0, 20_000),
      attachments: attachmentsOf(payload),
    };
  }

  /** "Connect Gmail" callback (access-key mode). */
  routes(app: Express, limiter: RequestHandler) {
    app.get(GMAIL_CALLBACK_PATH, limiter, async (req, res) => {
      const state = String(req.query.state ?? "");
      const code = String(req.query.code ?? "");
      if (req.query.error || !code) {
        return void res.status(400).type("html").send(page("Gmail wasn't connected", String(req.query.error_description ?? req.query.error ?? "No sign-in code came back.")));
      }
      const r = await this.finishConnect(state, code);
      if (!r.ok) return void res.status(400).type("html").send(page("Gmail wasn't connected", r.error));
      res.type("html").send(page("Gmail connected", `Drafts will be saved in ${r.email}. You can close this tab and go back to Claude.`));
    });
  }
}

// ---------------------------------------------------------------------------
// MIME (same shape as the original: text/plain body, attachments as base64 parts)
// ---------------------------------------------------------------------------

const b64 = (s: string | Uint8Array) => Buffer.from(s).toString("base64");
/** RFC 2047 encoded-word for non-ASCII header values. */
const headerText = (s: string) => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${b64(s)}?=`);
const wrap76 = (s: string) => s.replace(/.{1,76}/g, "$&\r\n").trimEnd();
const cleanHeader = (s: string) => s.replace(/[\r\n]+/g, " ").trim();

export function buildMime(d: DraftInput): string {
  const head: string[] = ["MIME-Version: 1.0", `Subject: ${headerText(cleanHeader(d.subject))}`];
  if (d.to?.length) head.push(`To: ${d.to.map(cleanHeader).join(", ")}`);
  if (d.cc?.length) head.push(`Cc: ${d.cc.map(cleanHeader).join(", ")}`);
  const textPart = ['Content-Type: text/plain; charset="UTF-8"', "Content-Transfer-Encoding: base64", "", wrap76(b64(d.body.replace(/\r?\n/g, "\r\n")))];
  let mime: string;
  if (!d.attachments?.length) {
    mime = [...head, ...textPart].join("\r\n");
  } else {
    const boundary = `gc_${randomBytes(12).toString("hex")}`;
    const parts = [textPart.join("\r\n")];
    for (const a of d.attachments) {
      const name = cleanHeader(a.fileName).replace(/"/g, "'");
      const enc = /^[\x20-\x7e]*$/.test(name) ? `filename="${name}"` : `filename*=UTF-8''${encodeURIComponent(name)}`;
      parts.push([`Content-Type: ${a.mimeType}; name="${name}"`, `Content-Disposition: attachment; ${enc}`, "Content-Transfer-Encoding: base64", "", wrap76(b64(a.bytes))].join("\r\n"));
    }
    mime = [...head, `Content-Type: multipart/mixed; boundary="${boundary}"`, "", ...parts.map((p) => `--${boundary}\r\n${p}`), `--${boundary}--`, ""].join("\r\n");
  }
  return Buffer.from(mime, "utf8").toString("base64url");
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

interface Part {
  mimeType?: string;
  filename?: string;
  body?: { data?: string; size?: number; attachmentId?: string };
  parts?: Part[];
  headers?: { name: string; value: string }[];
}

function headers(m: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const h of ((m.payload as Part | undefined)?.headers ?? [])) out[h.name.toLowerCase()] = h.value;
  return out;
}

const decode = (data?: string) => (data ? Buffer.from(data, "base64url").toString("utf8") : "");

function bodyText(p: Part): string {
  if (p.mimeType === "text/plain" && p.body?.data) return decode(p.body.data);
  for (const c of p.parts ?? []) {
    const t = bodyText(c);
    if (t) return t;
  }
  if (p.mimeType === "text/html" && p.body?.data) {
    return decode(p.body.data).replace(/<style[\s\S]*?<\/style>/gi, "").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
  }
  return "";
}

function attachmentsOf(p: Part, out: { filename: string; mimeType: string; size: number }[] = []) {
  if (p.filename) out.push({ filename: p.filename, mimeType: p.mimeType ?? "", size: p.body?.size ?? 0 });
  for (const c of p.parts ?? []) attachmentsOf(c, out);
  return out;
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const page = (title: string, body: string) =>
  `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>` +
  `<body style="font:15px/1.5 -apple-system,Segoe UI,sans-serif;max-width:560px;margin:48px auto;padding:0 16px;color:#111">` +
  `<h2 style="margin:0 0 8px">${esc(title)}</h2><p>${esc(body)}</p></body>`;

let shared: Gmail | null = null;
/** One Gmail client per process (it holds the access-token cache and Connect Gmail connections). */
export function getGmail(env: Env, log: Logger): Gmail {
  if (!shared) shared = new Gmail(env, log);
  return shared;
}
export function setGmailForTests(g: Gmail | null) {
  shared = g;
}
