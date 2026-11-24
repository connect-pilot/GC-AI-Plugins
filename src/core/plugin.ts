import type { Express, RequestHandler } from "express";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Env } from "./env.js";
import type { Logger } from "./logger.js";

export interface AuthedUser {
  email: string;
  sub: string;
  name?: string;
  /**
   * With Google sign-in: this user's Google refresh token (it travels sealed inside their access
   * token; never stored). Lets a tool act as them in Gmail, e.g. save a draft with a resume attached.
   */
  googleRefreshToken?: string;
}

export interface PluginContext {
  user: AuthedUser;
  env: Env;
  log: Logger;
}

export interface RouteContext {
  env: Env;
  log: Logger;
  /** Per-IP rate limit for public routes. */
  limiter: RequestHandler;
}

/**
 * A GoldCoast plugin: a self-contained set of MCP tools (plus optional resources/routes).
 * Vendor-neutral — anything registered here works in Claude, ChatGPT or any MCP client.
 * Tool names are prefixed with the plugin's short prefix, e.g. `resume_generate`.
 */
export interface GcPlugin {
  id: string;
  name: string;
  description: string;
  /** Usage guidance merged into the server's MCP `instructions`. */
  instructions?: string;
  /** Env vars this plugin needs; the server refuses to start without them (when enabled). */
  requiredEnv?: string[];
  /** One-time startup work, before the HTTP server listens. */
  init?(env: Env, log: Logger): Promise<void>;
  register(server: McpServer, ctx: PluginContext): void;
  /**
   * Optional plain HTTP routes (not MCP). They are NOT behind MCP sign-in, so each route must
   * authorize requests itself (e.g. a signed, expiring token the plugin issued through a tool).
   */
  routes?(app: Express, ctx: RouteContext): void;
}
