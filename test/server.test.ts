import { describe, expect, it } from "vitest";
import { buildMime } from "../src/google/gmail.js";
import { loadEnv } from "../src/core/env.js";
import { createApp } from "../src/server.js";
import { allPlugins } from "../src/plugins/index.js";

describe("env", () => {
  it("refuses production without sign-in or access key", () => {
    expect(() => loadEnv({ NODE_ENV: "production" })).toThrow();
  });
  it("turns Google sign-in on and the access key off", () => {
    const env = loadEnv({ GOOGLE_CLIENT_ID: "id", GOOGLE_CLIENT_SECRET: "s", OAUTH_SECRET: "x".repeat(32), ALLOWED_EMAIL_DOMAINS: "example.com", PUBLIC_URL: "https://x", MCP_ACCESS_KEY: "a".repeat(32) });
    expect(env.oauth).not.toBeNull();
    expect(env.accessKey).toBeNull();
  });
  it("GOOGLE_SIGN_IN=false keeps the access key", () => {
    const env = loadEnv({ GOOGLE_CLIENT_ID: "id", GOOGLE_CLIENT_SECRET: "s", GOOGLE_SIGN_IN: "false", MCP_ACCESS_KEY: "a".repeat(32) });
    expect(env.oauth).toBeNull();
    expect(env.accessKey).toBe("a".repeat(32));
  });
});

describe("gmail MIME", () => {
  it("builds a multipart message with the attachment", () => {
    const raw = Buffer.from(buildMime({ subject: "GoldCoast Search Group | PM | Pat", body: "Hi", to: ["c@x.com"], attachments: [{ fileName: "GoldCoast - Smith, Pat.pdf", mimeType: "application/pdf", bytes: Buffer.from("%PDF") }] }), "base64url").toString();
    expect(raw).toContain("Subject: GoldCoast Search Group | PM | Pat");
    expect(raw).toContain("To: c@x.com");
    expect(raw).toContain('filename="GoldCoast - Smith, Pat.pdf"');
  });
});

describe("server", () => {
  it("requires the access key on /mcp", async () => {
    const env = loadEnv({ MCP_ACCESS_KEY: "a".repeat(32) });
    const server = createApp(env, allPlugins).listen(0);
    const port = (server.address() as { port: number }).port;
    const res = await fetch(`http://127.0.0.1:${port}/mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    const health = await fetch(`http://127.0.0.1:${port}/healthz`).then((r) => r.json());
    server.close();
    expect(res.status).toBe(401);
    expect(health.plugins).toEqual(["ping", "resume-builder", "gmail"]);
  });
});
