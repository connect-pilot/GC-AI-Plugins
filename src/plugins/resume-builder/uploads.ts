/**
 * Resumes uploaded in the dashboard, held in memory until Claude reads them in the chat
 * (resume_read_upload). Never written to disk; dropped after UPLOAD_TTL_MS. Lives in this
 * process's memory (the service runs one instance).
 */
import { randomBytes } from "node:crypto";
import type { Extracted } from "./extract.js";

export const UPLOAD_TTL_MS = 2 * 60 * 60_000;
const MAX_UPLOADS = 100;

export interface Upload {
  id: string;
  owner: string;
  fileName: string;
  extracted: Extracted;
  candidateGuess: string | null;
  createdAt: number;
  expiresAt: number;
}

const uploads = new Map<string, Upload>();

function purge(now = Date.now()) {
  for (const [id, u] of uploads) if (u.expiresAt <= now) uploads.delete(id);
  while (uploads.size > MAX_UPLOADS) uploads.delete(uploads.keys().next().value!);
}

export function holdUpload(owner: string, fileName: string, extracted: Extracted, candidateGuess: string | null): Upload {
  purge();
  const now = Date.now();
  const u: Upload = { id: randomBytes(12).toString("hex"), owner, fileName, extracted, candidateGuess, createdAt: now, expiresAt: now + UPLOAD_TTL_MS };
  uploads.set(u.id, u);
  return u;
}

/** The upload, if it exists, hasn't expired, and belongs to this user. */
export function getUpload(id: string, owner: string): Upload | null {
  purge();
  const u = uploads.get(id);
  return u && u.owner === owner ? u : null;
}

/** This user's uploads, newest first (the original list_uploaded_documents). */
export function listUploads(owner: string): Upload[] {
  purge();
  return [...uploads.values()].filter((u) => u.owner === owner).sort((a, b) => b.createdAt - a.createdAt);
}

export const UPLOAD_ID_RE = /^[a-f0-9]{24}$/;
