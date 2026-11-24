/**
 * Saved presentation-resume builds: the structured resume, letterhead email, intake answers,
 * client email draft and content review — enough to re-render the PDF/DOCX on demand and to
 * reopen a build in the dashboard. Each build belongs to the recruiter who made it.
 *
 * With RESUME_DATA_DIR set (a Render disk, e.g. /var/data/resumes) builds are saved as one JSON
 * file each and survive restarts; otherwise they live in memory until the next deploy. Builds
 * older than RESUME_RETENTION_DAYS (default 180) are deleted. Uploaded original resumes are never
 * stored here (see uploads.ts) — only what the presentation resume and client email contain.
 */
import { randomBytes } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ClientEmail, ContentReview, Intake, ResumeData } from "./schema.js";

export interface GmailDraftRecord {
  at: string;
  url: string;
  to: string[];
}

export interface Build {
  id: string;
  owner: string;
  created_at: string;
  updated_at: string;
  version: number;
  resume: ResumeData;
  consultant_email: string;
  /** Letterhead phone and website (top-right, around the consultant email). Older builds: "". */
  letterhead_phone?: string;
  letterhead_website?: string;
  intake: Intake;
  client_email: ClientEmail | null;
  content_review: ContentReview | null;
  source: { file_name?: string; upload_id?: string };
  gmail_drafts: GmailDraftRecord[];
}

export const BUILD_ID_RE = /^rb_[a-f0-9]{16}$/;
const MAX_BUILDS = 5000;

export class BuildStore {
  private readonly builds = new Map<string, Build>();
  private readonly dir: string | null;

  constructor(
    dir: string | null,
    private readonly retentionDays: number,
  ) {
    this.dir = dir;
    if (dir) {
      mkdirSync(dir, { recursive: true });
      for (const f of readdirSync(dir)) {
        if (!f.endsWith(".json")) continue;
        try {
          const b = JSON.parse(readFileSync(join(dir, f), "utf8")) as Build;
          if (BUILD_ID_RE.test(b.id)) this.builds.set(b.id, b);
        } catch {
          // skip unreadable files
        }
      }
    }
    this.purge();
  }

  get persistent() {
    return Boolean(this.dir);
  }

  private purge() {
    const cutoff = Date.now() - this.retentionDays * 86_400_000;
    for (const [id, b] of this.builds) if (Date.parse(b.updated_at) < cutoff) this.delete(id);
    if (this.builds.size > MAX_BUILDS) {
      const oldest = [...this.builds.values()].sort((a, b) => a.updated_at.localeCompare(b.updated_at));
      for (const b of oldest.slice(0, this.builds.size - MAX_BUILDS)) this.delete(b.id);
    }
  }

  private write(b: Build) {
    if (!this.dir) return;
    const file = join(this.dir, `${b.id}.json`);
    writeFileSync(`${file}.tmp`, JSON.stringify(b));
    renameSync(`${file}.tmp`, file);
  }

  create(owner: string, fields: Omit<Build, "id" | "owner" | "created_at" | "updated_at" | "version" | "gmail_drafts">): Build {
    this.purge();
    const now = new Date().toISOString();
    const b: Build = { ...fields, id: `rb_${randomBytes(8).toString("hex")}`, owner, created_at: now, updated_at: now, version: 1, gmail_drafts: [] };
    this.builds.set(b.id, b);
    this.write(b);
    return b;
  }

  /** The build, if it exists and belongs to this owner. */
  get(id: string, owner: string): Build | null {
    const b = this.builds.get(id);
    return b && b.owner === owner ? b : null;
  }

  /** For signed download links, which carry the owner inside the signature. */
  getById(id: string): Build | null {
    return this.builds.get(id) ?? null;
  }

  update(id: string, owner: string, patch: Partial<Pick<Build, "resume" | "consultant_email" | "letterhead_phone" | "letterhead_website" | "intake" | "client_email" | "content_review" | "source">>): Build | null {
    const b = this.get(id, owner);
    if (!b) return null;
    const next: Build = { ...b, ...patch, version: b.version + 1, updated_at: new Date().toISOString() };
    this.builds.set(id, next);
    this.write(next);
    return next;
  }

  recordDraft(id: string, owner: string, d: GmailDraftRecord) {
    const b = this.get(id, owner);
    if (!b) return;
    b.gmail_drafts = [d, ...b.gmail_drafts].slice(0, 20);
    this.write(b);
  }

  delete(id: string) {
    this.builds.delete(id);
    if (this.dir) rmSync(join(this.dir, `${id}.json`), { force: true });
  }

  /** Letterheads on this owner's recent builds, newest first (for suggestions). */
  recentLetterheads(owner: string) {
    return this.list(owner, 30).map(letterheadOf);
  }

  list(owner: string, limit = 200): Build[] {
    this.purge();
    return [...this.builds.values()]
      .filter((b) => b.owner === owner)
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
      .slice(0, limit);
  }
}

export const letterheadOf = (b: Build) => ({ email: b.consultant_email, phone: b.letterhead_phone ?? "", website: b.letterhead_website ?? "" });

let shared: BuildStore | null = null;
export function getStore(env: NodeJS.ProcessEnv): BuildStore {
  if (!shared) {
    const dir = env.RESUME_DATA_DIR?.trim() || (env.NODE_ENV === "production" ? null : ".data/resumes");
    shared = new BuildStore(dir, Number(env.RESUME_RETENTION_DAYS ?? 180) || 180);
  }
  return shared;
}
export function setStoreForTests(s: BuildStore | null) {
  shared = s;
}
