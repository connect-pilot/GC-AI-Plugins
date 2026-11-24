export interface Env {
  port: number;
  nodeEnv: string;
  publicUrl: string;
  authDisabled: boolean;
  /** Shared secret for /mcp (fallback when Google sign-in is off). */
  accessKey: string | null;
  /** Label used in logs/tools for access-key callers. */
  accessKeyUser: string;
  /** Google sign-in for the connector; when set, the shared access key is turned off. */
  oauth: OAuthEnv | null;
  /** Google OAuth client (sign-in and/or Gmail). Null when GOOGLE_CLIENT_ID / _SECRET are unset. */
  google: GoogleClientEnv | null;
  /** Seals tokens and signed links. OAUTH_SECRET, or derived from MCP_ACCESS_KEY in fallback mode. */
  sealSecret: string;
  /** Max /mcp requests per minute per client IP. */
  rateLimitPerMin: number;
  enabledPlugins: string[] | null; // null = all
  raw: NodeJS.ProcessEnv;
}

export interface GoogleClientEnv {
  clientId: string;
  clientSecret: string;
}

export interface OAuthEnv extends GoogleClientEnv {
  /** Seals every OAuth artifact (nothing is stored server-side). Rotating it signs everyone out. */
  secret: string;
  accessTokenSeconds: number;
  refreshTokenSeconds: number;
}

const list = (v?: string) =>
  (v ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const nodeEnv = source.NODE_ENV ?? "development";
  const authDisabled = source.AUTH_DISABLED === "true";
  if (authDisabled && nodeEnv === "production") {
    throw new Error("AUTH_DISABLED=true is not allowed when NODE_ENV=production");
  }
  const accessKey = source.MCP_ACCESS_KEY?.trim() || null;
  if (accessKey && (accessKey.length < 32 || !/^[A-Za-z0-9_-]+$/.test(accessKey))) {
    throw new Error("MCP_ACCESS_KEY must be 32+ URL-safe characters (use: openssl rand -hex 32)");
  }
  const google = loadGoogle(source);
  const oauth = loadOAuth(source, google);
  if (nodeEnv === "production" && !accessKey && !oauth) {
    throw new Error("Production needs Google sign-in (GOOGLE_* + OAUTH_SECRET) or MCP_ACCESS_KEY");
  }
  const secret = source.OAUTH_SECRET?.trim() ?? "";
  const sealSecret = secret.length >= 32 ? secret : accessKey ? `derived:${accessKey}` : "local-development-only-secret-0123456789";
  if (nodeEnv === "production" && sealSecret.startsWith("local-")) throw new Error("Production needs OAUTH_SECRET");
  const enabled = list(source.ENABLED_PLUGINS).filter((id) => !["all", "*"].includes(id.toLowerCase()));
  const port = Number(source.PORT ?? 8787);
  return {
    port,
    nodeEnv,
    publicUrl: (source.PUBLIC_URL ?? `http://localhost:${port}`).replace(/\/$/, ""),
    authDisabled,
    // Google sign-in replaces the shared key, so only allowed accounts get in.
    accessKey: oauth ? null : accessKey,
    accessKeyUser: source.ACCESS_KEY_USER?.trim() || "joe@connectpilot.ai",
    oauth,
    google,
    sealSecret,
    rateLimitPerMin: Number(source.RATE_LIMIT_PER_MIN ?? 60),
    enabledPlugins: enabled.length ? enabled : null,
    raw: source,
  };
}

function loadGoogle(source: NodeJS.ProcessEnv): GoogleClientEnv | null {
  const clientId = source.GOOGLE_CLIENT_ID?.trim() ?? "";
  const clientSecret = source.GOOGLE_CLIENT_SECRET?.trim() ?? "";
  if (!clientId && !clientSecret) return null;
  if (!clientId || !clientSecret) throw new Error("Google needs both GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET");
  return { clientId, clientSecret };
}

/**
 * Google sign-in is on when the Google client is set and GOOGLE_SIGN_IN isn't "false".
 * With GOOGLE_SIGN_IN=false the Google client is only used for "Connect Gmail" (access-key mode).
 */
function loadOAuth(source: NodeJS.ProcessEnv, google: GoogleClientEnv | null): OAuthEnv | null {
  if (!google || source.GOOGLE_SIGN_IN?.trim().toLowerCase() === "false") return null;
  const secret = source.OAUTH_SECRET?.trim() ?? "";
  if (secret.length < 32) throw new Error("OAUTH_SECRET must be 32+ characters (openssl rand -hex 32)");
  if (!list(source.ALLOWED_EMAIL_DOMAINS).length && !list(source.ALLOWED_EMAILS).length) {
    throw new Error("Google sign-in needs ALLOWED_EMAIL_DOMAINS (e.g. goldcoastsearch.com) or ALLOWED_EMAILS");
  }
  if (!source.PUBLIC_URL?.trim()) throw new Error("Google sign-in needs PUBLIC_URL (this server's https address)");
  return {
    ...google,
    secret,
    accessTokenSeconds: Number(source.ACCESS_TOKEN_MINUTES ?? 60) * 60,
    refreshTokenSeconds: Number(source.REFRESH_TOKEN_DAYS ?? 30) * 86_400,
  };
}
