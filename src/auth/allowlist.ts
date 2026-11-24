export interface Allowlist {
  domains: string[];
  emails: string[];
}

const list = (v?: string) =>
  (v ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

export function loadAllowlist(env: NodeJS.ProcessEnv): Allowlist {
  return { domains: list(env.ALLOWED_EMAIL_DOMAINS), emails: list(env.ALLOWED_EMAILS) };
}

export function isAllowed(email: string | undefined, allow: Allowlist): boolean {
  if (!email) return false;
  const e = email.trim().toLowerCase();
  const at = e.lastIndexOf("@");
  if (at < 1 || at === e.length - 1) return false;
  if (allow.emails.includes(e)) return true;
  return allow.domains.includes(e.slice(at + 1));
}
