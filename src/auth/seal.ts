import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";

/**
 * Self-contained encrypted tokens (AES-256-GCM), so the server stores nothing:
 * OAuth client registrations, sign-in state, auth codes and access/refresh
 * tokens are all sealed payloads that the AI app holds and hands back.
 *
 * Each purpose gets its own key (HKDF from OAUTH_SECRET), so a token of one kind
 * can never be accepted as another. Payloads carry their own expiry.
 */
export type Purpose = "client" | "state" | "code" | "access" | "refresh" | "gmail-state" | "file";

export class Sealer {
  private readonly keys = new Map<Purpose, Buffer>();

  constructor(secret: string) {
    if (!secret || secret.length < 32) throw new Error("OAUTH_SECRET must be at least 32 characters (openssl rand -hex 32)");
    for (const p of ["client", "state", "code", "access", "refresh", "gmail-state", "file"] as Purpose[]) {
      this.keys.set(p, Buffer.from(hkdfSync("sha256", secret, "gc-ai-plugins", `oauth:${p}`, 32)));
    }
  }

  seal(purpose: Purpose, payload: object, ttlSeconds?: number): string {
    const body = ttlSeconds ? { ...payload, exp: Math.floor(Date.now() / 1000) + ttlSeconds } : payload;
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.keys.get(purpose)!, iv);
    const ct = Buffer.concat([cipher.update(JSON.stringify(body), "utf8"), cipher.final()]);
    return Buffer.concat([iv, ct, cipher.getAuthTag()]).toString("base64url");
  }

  /** The payload, or null if the token is forged, tampered with, of another purpose, or expired. */
  open<T extends object>(purpose: Purpose, token: string): (T & { exp?: number }) | null {
    try {
      const raw = Buffer.from(token, "base64url");
      if (raw.length < 12 + 16 + 2) return null;
      const decipher = createDecipheriv("aes-256-gcm", this.keys.get(purpose)!, raw.subarray(0, 12));
      decipher.setAuthTag(raw.subarray(raw.length - 16));
      const text = Buffer.concat([decipher.update(raw.subarray(12, raw.length - 16)), decipher.final()]).toString("utf8");
      const payload = JSON.parse(text) as T & { exp?: number };
      if (payload.exp !== undefined && payload.exp < Date.now() / 1000) return null;
      return payload;
    } catch {
      return null;
    }
  }
}
