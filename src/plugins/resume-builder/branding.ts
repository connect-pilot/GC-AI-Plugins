/**
 * Company branding for the letterhead, footer and client email — the original agent's
 * get_company_branding(), configured with env vars instead of the workspace's settings table.
 */
import { readFileSync } from "node:fs";

export interface Branding {
  company_name: string;
  company_phone: string;
  company_website: string;
  consultant_emails: string[];
  /** File names start with this, e.g. "GoldCoast - Ezrilov, Aaron.pdf". */
  file_prefix: string;
}

const list = (v?: string) =>
  (v ?? "")
    .split(/[,\n]/)
    .map((s) => s.trim())
    .filter(Boolean);

export function loadBranding(env: NodeJS.ProcessEnv): Branding {
  return {
    company_name: env.COMPANY_NAME?.trim() || "GoldCoast Search Group",
    company_phone: env.COMPANY_PHONE?.trim() ?? "",
    company_website: env.COMPANY_WEBSITE?.trim() ?? "",
    consultant_emails: list(env.CONSULTANT_EMAILS),
    file_prefix: env.RESUME_FILE_PREFIX?.trim() || "GoldCoast",
  };
}

/** Consultant emails with the signed-in recruiter's own first (when it's on the list). */
export function consultantEmailsFor(b: Branding, userEmail: string | undefined): string[] {
  const me = userEmail?.toLowerCase();
  const own = b.consultant_emails.filter((e) => e.toLowerCase() === me);
  return [...own, ...b.consultant_emails.filter((e) => e.toLowerCase() !== me)];
}

let logo: { bytes: Buffer; path: string } | null = null;
/** The letterhead logo: COMPANY_LOGO_PATH, else the bundled GoldCoast logo (assets/gc-logo.png). */
export function loadLogo(env: NodeJS.ProcessEnv): Buffer | null {
  const custom = env.COMPANY_LOGO_PATH?.trim();
  const candidates = custom
    ? [custom]
    : [new URL("../../../assets/gc-logo.png", import.meta.url), new URL("../../../../assets/gc-logo.png", import.meta.url)];
  for (const c of candidates) {
    const key = String(c);
    if (logo?.path === key) return logo.bytes;
    try {
      const bytes = readFileSync(c);
      logo = { bytes, path: key };
      return bytes;
    } catch {
      // try the next location
    }
  }
  return null;
}

/** PNG/JPEG pixel size (for keeping the logo's aspect ratio in the DOCX). */
export function imageSize(bytes: Buffer): { width: number; height: number } | null {
  if (bytes.length > 24 && bytes.readUInt32BE(0) === 0x89504e47) return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    let i = 2;
    while (i + 9 < bytes.length) {
      if (bytes[i] !== 0xff) return null;
      const marker = bytes[i + 1]!;
      const len = bytes.readUInt16BE(i + 2);
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
        return { height: bytes.readUInt16BE(i + 5), width: bytes.readUInt16BE(i + 7) };
      }
      i += 2 + len;
    }
  }
  return null;
}
