/**
 * Company branding (footer, client email subject, file names, logo) — configured with env vars.
 *
 * The letterhead's contact lines (consultant email, phone, website) are NOT configured here: they
 * are asked for each resume (in chat or in the dashboard) and saved with the build. Suggestions
 * come from the recruiter's own recent builds, so they rarely need retyping.
 */
import { readFileSync } from "node:fs";

export interface Branding {
  company_name: string;
  /** File names start with this, e.g. "GoldCoast - Ezrilov, Aaron.pdf". */
  file_prefix: string;
}

export function loadBranding(env: NodeJS.ProcessEnv): Branding {
  return {
    company_name: env.COMPANY_NAME?.trim() || "GoldCoast Search Group",
    file_prefix: env.RESUME_FILE_PREFIX?.trim() || "GoldCoast",
  };
}

/** The letterhead's three contact lines (top-right of every page). */
export interface Letterhead {
  email: string;
  phone: string;
  website: string;
}

export interface LetterheadSuggestions {
  /** Consultant emails to offer: the signed-in recruiter's first, then ones used on recent builds. */
  emails: string[];
  phones: string[];
  websites: string[];
  /** The most recent build's letterhead, to prefill. */
  last: Letterhead | null;
}

const distinct = (xs: string[]) => {
  const seen = new Set<string>();
  return xs.filter((x) => x && !seen.has(x.toLowerCase()) && seen.add(x.toLowerCase()));
};

/** Suggestions from this recruiter's builds (newest first) and their signed-in email. */
export function letterheadSuggestions(recent: Letterhead[], userEmail: string | undefined): LetterheadSuggestions {
  const own = userEmail && /^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(userEmail) && !userEmail.endsWith("@localhost") ? [userEmail] : [];
  return {
    emails: distinct([...own, ...recent.map((l) => l.email)]).slice(0, 6),
    phones: distinct(recent.map((l) => l.phone)).slice(0, 4),
    websites: distinct(recent.map((l) => l.website)).slice(0, 4),
    last: recent[0] ?? null,
  };
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
