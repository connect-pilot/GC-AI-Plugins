import { createHash, timingSafeEqual } from "node:crypto";
import type { RequestHandler } from "express";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { getOAuthProtectedResourceMetadataUrl } from "@modelcontextprotocol/sdk/server/auth/router.js";
import type { Env } from "../core/env.js";
import type { AuthedUser } from "../core/plugin.js";
import type { GoogleOAuthProvider } from "./google.js";

declare module "express-serve-static-core" {
  interface Request {
    user?: AuthedUser;
  }
}

const digest = (s: string) => createHash("sha256").update(s).digest();
const sameSecret = (a: string, b: string) => timingSafeEqual(digest(a), digest(b));

/**
 * Auth middleware for /mcp. In priority order:
 *
 * 1. Google sign-in (GOOGLE_* + OAUTH_SECRET set): the AI app runs OAuth against this
 *    server, which hands sign-in to Google. Requests carry our sealed bearer token; only
 *    allowlisted emails pass. The shared access key is turned off in this mode.
 * 2. Shared access key (MCP_ACCESS_KEY) — temporary mode, as either
 *    /mcp/<key> or Authorization: Bearer <key>.
 * 3. AUTH_DISABLED=true — local development only.
 */
export function authMiddleware(env: Env, oauth?: GoogleOAuthProvider): RequestHandler {
  if (env.authDisabled) {
    return (req, _res, next) => {
      req.user = { email: "local-dev@localhost", sub: "local-dev" };
      next();
    };
  }

  if (oauth) {
    const bearer = requireBearerAuth({
      verifier: oauth,
      resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(new URL(oauth.defaultResource)),
      expectedResource: new URL(oauth.defaultResource),
    });
    return (req, res, next) => {
      if (req.params?.key) {
        res.status(401).json({ error: "unauthorized", error_description: "Use the plain /mcp URL and sign in with Google" });
        return;
      }
      bearer(req, res, (err?: unknown) => {
        if (err) return next(err);
        const extra = (req.auth?.extra ?? {}) as { email?: string; sub?: string; name?: string; grt?: string };
        req.user = {
          email: extra.email ?? "unknown",
          sub: extra.sub ?? "unknown",
          ...(extra.name ? { name: extra.name } : {}),
          ...(extra.grt ? { googleRefreshToken: extra.grt } : {}),
        };
        next();
      });
    };
  }

  const key = env.accessKey;
  if (!key) {
    return (_req, res) => {
      res.status(401).json({ error: "unauthorized", error_description: "No auth method configured" });
    };
  }

  return (req, res, next) => {
    const fromPath = typeof req.params?.key === "string" ? req.params.key : undefined;
    const header = req.headers.authorization ?? "";
    const fromHeader = header.startsWith("Bearer ") ? header.slice(7).trim() : undefined;
    const presented = fromPath ?? fromHeader;
    if (!presented || !sameSecret(presented, key)) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    req.user = { email: env.accessKeyUser, sub: "access-key" };
    next();
  };
}
