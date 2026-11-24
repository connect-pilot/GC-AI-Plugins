/**
 * Google sign-in for the MCP server — stateless. (Same design as the J.L. Thomas server's
 * Microsoft sign-in, pointed at Google.)
 *
 * This server is the OAuth 2.1 authorization server the AI app (Claude, ChatGPT…)
 * talks to: dynamic client registration, PKCE, auth codes, access + refresh tokens
 * (endpoints from the MCP SDK's mcpAuthRouter). The actual sign-in is delegated to
 * Google: /authorize redirects to Google, and /oauth/callback turns Google's answer
 * into our own auth code.
 *
 * The same sign-in grants Gmail compose + read, so the Gmail tools can save drafts (with the
 * presentation resume attached) in the signed-in recruiter's own mailbox. The Google refresh
 * token travels sealed inside the tokens the AI app holds; nothing is stored here.
 *
 * Only emails that pass the allowlist (ALLOWED_EMAIL_DOMAINS / ALLOWED_EMAILS) get in, checked at
 * sign-in, on every refresh (which re-asks Google, so a removed account loses access within the
 * access-token lifetime) and on every request.
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import express, { type Response, type Router } from "express";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import { InvalidGrantError, InvalidTokenError, ServerError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type { AuthorizationParams, OAuthServerProvider } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type { OAuthClientInformationFull, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import type { Logger } from "../core/logger.js";
import { isAllowed, type Allowlist } from "./allowlist.js";
import { Sealer } from "./seal.js";

export interface GoogleConfig {
  clientId: string;
  clientSecret: string;
  /** Public base URL of this server, e.g. https://gc-ai-plugins.onrender.com */
  publicUrl: string;
  /** Sign-in state + code lifetimes are fixed; these are tunable. */
  accessTokenSeconds: number;
  refreshTokenSeconds: number;
}

export const CALLBACK_PATH = "/oauth/callback";
const STATE_TTL_S = 10 * 60; // time a person has to finish Google sign-in
const CODE_TTL_S = 5 * 60;
const GOOGLE_AUTH = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN = "https://oauth2.googleapis.com/token";
/** Same Gmail scopes as the original GoldCoast Gmail agent: compose (drafts) and read. */
export const GMAIL_SCOPES = ["https://www.googleapis.com/auth/gmail.compose", "https://www.googleapis.com/auth/gmail.readonly"];
const SIGN_IN_SCOPES = ["openid", "email", "profile", ...GMAIL_SCOPES].join(" ");

interface ClientPayload {
  redirect_uris: string[];
  token_endpoint_auth_method?: string;
  grant_types?: string[];
  response_types?: string[];
  client_name?: string;
  scope?: string;
  client_secret?: string;
  client_secret_expires_at?: number;
  iat: number;
}

interface StatePayload {
  cid: string; // our client_id
  ru: string; // client's redirect_uri
  st?: string; // client's state
  cc: string; // client's PKCE code_challenge
  sc: string[];
  res: string;
  gv: string; // our PKCE verifier toward Google
}

interface Identity {
  email: string;
  sub: string;
  name?: string;
}

interface CodePayload extends Identity {
  jti: string;
  cid: string;
  ru: string;
  cc: string;
  sc: string[];
  res: string;
  grt?: string; // Google refresh token
}

interface AccessPayload extends Identity {
  cid: string;
  sc: string[];
  res: string;
  /** Google refresh token (sealed with the rest), so tools can act as this user in Gmail. */
  grt?: string;
}

interface RefreshPayload extends AccessPayload {
  grt: string;
}

type FetchFn = typeof fetch;

export class GoogleOAuthProvider implements OAuthServerProvider {
  private readonly sealer: Sealer;
  /** Auth codes already redeemed (one-time use); in memory, entries expire with the codes. */
  private readonly usedCodes = new Map<string, number>();
  readonly defaultResource: string;

  constructor(
    private readonly cfg: GoogleConfig,
    oauthSecret: string,
    private readonly allow: Allowlist,
    private readonly log: Logger,
    private readonly fetchFn: FetchFn = fetch,
  ) {
    this.sealer = new Sealer(oauthSecret);
    this.defaultResource = `${cfg.publicUrl}/mcp`;
  }

  // -------------------------------------------------------------------------
  // Clients: the client_id IS the sealed registration (nothing stored).
  // -------------------------------------------------------------------------

  readonly clientsStore: OAuthRegisteredClientsStore = {
    getClient: (clientId: string) => {
      const p = this.sealer.open<ClientPayload>("client", clientId);
      if (!p) return undefined;
      const { iat, ...meta } = p;
      return { ...meta, client_id: clientId, client_id_issued_at: iat } as OAuthClientInformationFull;
    },
    registerClient: (client) => {
      const payload: ClientPayload = {
        redirect_uris: client.redirect_uris.map(String),
        token_endpoint_auth_method: client.token_endpoint_auth_method,
        grant_types: client.grant_types,
        response_types: client.response_types,
        client_name: client.client_name?.slice(0, 100),
        scope: client.scope,
        client_secret: client.client_secret,
        client_secret_expires_at: client.client_secret_expires_at,
        iat: Math.floor(Date.now() / 1000),
      };
      const clientId = this.sealer.seal("client", payload);
      const { iat, ...meta } = payload;
      return { ...meta, client_id: clientId, client_id_issued_at: iat } as OAuthClientInformationFull;
    },
  };

  // -------------------------------------------------------------------------
  // Authorize: hand off to Google.
  // -------------------------------------------------------------------------

  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response): Promise<void> {
    const verifier = randomBytes(32).toString("base64url");
    const state = this.sealer.seal(
      "state",
      {
        cid: client.client_id,
        ru: params.redirectUri,
        st: params.state,
        cc: params.codeChallenge,
        sc: params.scopes?.length ? params.scopes : ["mcp"],
        res: params.resource?.href ?? this.defaultResource,
        gv: verifier,
      } satisfies StatePayload,
      STATE_TTL_S,
    );
    const url = new URL(GOOGLE_AUTH);
    const q: Record<string, string> = {
      client_id: this.cfg.clientId,
      response_type: "code",
      redirect_uri: this.cfg.publicUrl + CALLBACK_PATH,
      scope: SIGN_IN_SCOPES,
      state,
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
      code_challenge_method: "S256",
      access_type: "offline", // a refresh token, so Gmail keeps working after the first hour
      prompt: "consent select_account", // Google only returns a refresh token on consent
      include_granted_scopes: "true",
    };
    // One allowed domain: Google shows only that Workspace's accounts.
    if (this.allow.domains.length === 1 && !this.allow.emails.length) q.hd = this.allow.domains[0]!;
    url.search = new URLSearchParams(q).toString();
    res.redirect(302, url.href);
  }

  /** Express router for Google's redirect back to us. Mount at the app root. */
  callbackRouter(): Router {
    const router = express.Router();
    router.get(CALLBACK_PATH, async (req, res) => {
      const q = req.query as Record<string, string | undefined>;
      const state = q.state ? this.sealer.open<StatePayload>("state", q.state) : null;
      if (!state) {
        res.status(400).type("text/plain").send("This sign-in link has expired or is invalid. Start the connection again from your AI app.");
        return;
      }
      const back = (params: Record<string, string>) => {
        const u = new URL(state.ru);
        for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
        if (state.st) u.searchParams.set("state", state.st);
        res.redirect(302, u.href);
      };
      if (q.error || !q.code) {
        back({ error: "access_denied", error_description: q.error_description?.slice(0, 200) || "Google sign-in was cancelled" });
        return;
      }
      try {
        const g = await this.googleToken({
          grant_type: "authorization_code",
          code: q.code,
          redirect_uri: this.cfg.publicUrl + CALLBACK_PATH,
          code_verifier: state.gv,
        });
        const who = this.identityFrom(g.id_token);
        if (!who) {
          this.log.error("signin_rejected", { reason: "not_allowed" });
          back({
            error: "access_denied",
            error_description: "Only GoldCoast Search Group Google accounts can use this connector.",
          });
          return;
        }
        const code = this.sealer.seal(
          "code",
          {
            ...who,
            jti: randomUUID(),
            cid: state.cid,
            ru: state.ru,
            cc: state.cc,
            sc: state.sc,
            res: state.res,
            grt: g.refresh_token,
          } satisfies CodePayload,
          CODE_TTL_S,
        );
        this.log.info("signin_ok", { user: who.email });
        back({ code });
      } catch (err) {
        this.log.error("signin_failed", { error: (err as Error).message.slice(0, 200) });
        back({ error: "server_error", error_description: "Google sign-in could not be completed. Try again." });
      }
    });
    return router;
  }

  // -------------------------------------------------------------------------
  // Codes and tokens
  // -------------------------------------------------------------------------

  private openCode(client: OAuthClientInformationFull, code: string): CodePayload & { exp?: number } {
    const p = this.sealer.open<CodePayload>("code", code);
    if (!p || p.cid !== client.client_id) throw new InvalidGrantError("Invalid or expired authorization code");
    return p;
  }

  async challengeForAuthorizationCode(client: OAuthClientInformationFull, code: string): Promise<string> {
    return this.openCode(client, code).cc;
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    code: string,
    _verifier?: string,
    redirectUri?: string,
    resource?: URL,
  ): Promise<OAuthTokens> {
    const p = this.openCode(client, code);
    if (redirectUri && redirectUri !== p.ru) throw new InvalidGrantError("redirect_uri does not match");
    if (resource && !sameResource(resource.href, p.res)) throw new InvalidGrantError("resource does not match");
    this.pruneUsedCodes();
    if (this.usedCodes.has(p.jti)) throw new InvalidGrantError("Authorization code already used");
    this.usedCodes.set(p.jti, p.exp ?? 0);
    if (!p.grt) throw new InvalidGrantError("Google did not return a refresh token");
    return this.issue({ email: p.email, sub: p.sub, name: p.name, cid: p.cid, sc: p.sc, res: p.res }, p.grt);
  }

  async exchangeRefreshToken(
    client: OAuthClientInformationFull,
    refreshToken: string,
    scopes?: string[],
    resource?: URL,
  ): Promise<OAuthTokens> {
    const p = this.sealer.open<RefreshPayload>("refresh", refreshToken);
    if (!p || p.cid !== client.client_id) throw new InvalidGrantError("Invalid or expired refresh token");
    if (resource && !sameResource(resource.href, p.res)) throw new InvalidGrantError("resource does not match");
    // Re-ask Google: a removed / revoked account fails here.
    let g: GoogleTokens;
    try {
      g = await this.googleToken({ grant_type: "refresh_token", refresh_token: p.grt });
    } catch {
      this.log.info("refresh_rejected", { user: p.email, reason: "google" });
      throw new InvalidGrantError("Google session ended — sign in again");
    }
    const who = g.id_token ? this.identityFrom(g.id_token) : { email: p.email, sub: p.sub, name: p.name };
    if (!who || who.sub !== p.sub || !isAllowed(who.email, this.allow)) {
      throw new InvalidGrantError("This account is no longer allowed");
    }
    const sc = scopes?.length ? scopes.filter((s) => p.sc.includes(s)) : p.sc;
    return this.issue({ ...who, cid: p.cid, sc, res: p.res }, g.refresh_token ?? p.grt);
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const p = this.sealer.open<AccessPayload>("access", token);
    if (!p) throw new InvalidTokenError("Invalid or expired access token");
    if (!isAllowed(p.email, this.allow)) throw new InvalidTokenError("This account is not allowed");
    return {
      token,
      clientId: p.cid,
      scopes: p.sc,
      expiresAt: p.exp,
      resource: new URL(p.res),
      extra: { email: p.email, sub: p.sub, name: p.name, ...(p.grt ? { grt: p.grt } : {}) },
    };
  }

  private issue(a: AccessPayload, googleRefresh: string): OAuthTokens {
    return {
      access_token: this.sealer.seal("access", { ...a, grt: googleRefresh } satisfies AccessPayload, this.cfg.accessTokenSeconds),
      token_type: "bearer",
      expires_in: this.cfg.accessTokenSeconds,
      scope: a.sc.join(" "),
      refresh_token: this.sealer.seal("refresh", { ...a, grt: googleRefresh } satisfies RefreshPayload, this.cfg.refreshTokenSeconds),
    };
  }

  private pruneUsedCodes() {
    const now = Date.now() / 1000;
    for (const [jti, exp] of this.usedCodes) if (exp < now) this.usedCodes.delete(jti);
  }

  // -------------------------------------------------------------------------
  // Google
  // -------------------------------------------------------------------------

  private async googleToken(params: Record<string, string>): Promise<GoogleTokens> {
    const res = await this.fetchFn(GOOGLE_TOKEN, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: this.cfg.clientId, client_secret: this.cfg.clientSecret, ...params }),
    });
    const body = (await res.json().catch(() => ({}))) as GoogleTokens & { error?: string };
    if (!res.ok || body.error) throw new ServerError(`Google token endpoint: ${body.error ?? res.status}`);
    return body;
  }

  /**
   * The signed-in user from Google's id_token, or null if not allowed.
   * The token comes straight from Google's token endpoint over TLS in exchange for our client
   * secret, so its claims are trusted without re-checking the signature (OIDC Core 3.1.3.7);
   * audience, issuer and email verification are still checked.
   */
  private identityFrom(idToken: string | undefined): Identity | null {
    if (!idToken) return null;
    let c: Record<string, unknown>;
    try {
      c = JSON.parse(Buffer.from(idToken.split(".")[1] ?? "", "base64url").toString("utf8"));
    } catch {
      return null;
    }
    if (c.aud !== this.cfg.clientId) return null;
    if (c.iss !== "https://accounts.google.com" && c.iss !== "accounts.google.com") return null;
    if (c.email_verified !== true && c.email_verified !== "true") return null;
    const email = String(c.email ?? "").toLowerCase();
    if (!isAllowed(email, this.allow)) return null;
    return { email, sub: String(c.sub ?? ""), name: typeof c.name === "string" ? c.name : undefined };
  }
}

interface GoogleTokens {
  id_token?: string;
  refresh_token?: string;
  access_token?: string;
}

function sameResource(a: string, b: string) {
  const clean = (s: string) => s.split("#")[0]!.replace(/\/$/, "");
  return clean(a) === clean(b);
}
