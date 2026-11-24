import express, { type Express } from "express";
import { rateLimit } from "express-rate-limit";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { mcpAuthRouter } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { loadAllowlist } from "./auth/allowlist.js";
import { GoogleOAuthProvider } from "./auth/google.js";
import { authMiddleware } from "./auth/index.js";
import type { Env } from "./core/env.js";
import { logger } from "./core/logger.js";
import { publicPages } from "./core/public-pages.js";
import type { AuthedUser, GcPlugin } from "./core/plugin.js";

const SERVER_NAME = "gc-ai-plugins";
const SERVER_VERSION = "0.1.0";

export function buildMcpServer(plugins: GcPlugin[], user: AuthedUser, env: Env): McpServer {
  const instructions = [
    "GoldCoast Search Group company tools for recruiters. Use them when the user asks about GoldCoast recruiting tasks: presentation resumes, client emails and Gmail drafts.",
    ...plugins.filter((p) => p.instructions).map((p) => `## ${p.name}\n${p.instructions}`),
  ].join("\n\n");
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION }, { instructions });
  for (const p of plugins) p.register(server, { user, env, log: logger });
  return server;
}

export interface AppOptions {
  /** Replaces fetch() for calls to Google (tests). */
  oauthFetch?: typeof fetch;
}

export function createApp(env: Env, plugins: GcPlugin[], opts: AppOptions = {}): Express {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", 1); // Render terminates TLS in front of us; use the real client IP

  // Caps damage from a leaked credential.
  const limiter = rateLimit({
    windowMs: 60_000,
    limit: env.rateLimitPerMin,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    message: { jsonrpc: "2.0", error: { code: -32000, message: "Rate limit exceeded, try again shortly" }, id: null },
    handler: (req, res, _next, options) => {
      logger.error("rate_limited", { ip: req.ip });
      res.status(options.statusCode).json(options.message);
    },
  });
  // 16mb: the Resume Builder dashboard uploads resumes (up to 10 MB, base64-encoded) inside a tool call.
  app.use(express.json({ limit: "16mb" }));

  publicPages(app); // home, privacy policy and terms (linked from Google's consent screen)

  app.get("/healthz", (_req, res) => {
    // commit: which build is live (Render sets RENDER_GIT_COMMIT); null when running locally.
    res.json({ ok: true, plugins: plugins.map((p) => p.id), signIn: env.oauth ? "google" : env.accessKey ? "access-key" : "none", commit: env.raw.RENDER_GIT_COMMIT?.slice(0, 7) ?? null });
  });

  for (const p of plugins) p.routes?.(app, { env, log: logger, limiter });

  // Google sign-in: OAuth endpoints (/authorize, /token, /register, metadata) +
  // Google's redirect back. Stateless — every artifact is a sealed token.
  let oauth: GoogleOAuthProvider | undefined;
  if (env.oauth && !env.authDisabled) {
    oauth = new GoogleOAuthProvider(
      { ...env.oauth, publicUrl: env.publicUrl },
      env.oauth.secret,
      loadAllowlist(env.raw),
      logger,
      opts.oauthFetch,
    );
    app.use(
      mcpAuthRouter({
        provider: oauth,
        issuerUrl: new URL(env.publicUrl),
        resourceServerUrl: new URL(oauth.defaultResource),
        scopesSupported: ["mcp"],
        resourceName: "GoldCoast AI Plugins",
        clientRegistrationOptions: { clientSecretExpirySeconds: 0 }, // client ids are sealed; no expiry to track
      }),
    );
    app.use(oauth.callbackRouter());
  }

  // Stateless MCP endpoint: a fresh server + transport per request, nothing stored.
  app.post(["/mcp", "/mcp/:key"], limiter, authMiddleware(env, oauth), async (req, res) => {
    const started = Date.now();
    const body = req.body as { method?: string; params?: { name?: string } } | undefined;
    const server = buildMcpServer(plugins, req.user!, env);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => {
      void transport.close();
      void server.close();
      // Metadata only — never log arguments or results.
      logger.info("mcp_request", {
        user: req.user?.email,
        method: body?.method,
        tool: body?.method === "tools/call" ? body.params?.name : undefined,
        status: res.statusCode,
        ms: Date.now() - started,
      });
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      logger.error("mcp_error", { method: body?.method, error: (err as Error).name });
      if (!res.headersSent) {
        res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null });
      }
    }
  });

  const notAllowed: express.RequestHandler = (_req, res) => {
    res.status(405).json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed (stateless server)" }, id: null });
  };
  app.get(["/mcp", "/mcp/:key"], notAllowed);
  app.delete(["/mcp", "/mcp/:key"], notAllowed);

  return app;
}
