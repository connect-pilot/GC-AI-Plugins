/**
 * Rendering builds to PDF/DOCX, and signed download links for them.
 *
 * A download link carries a sealed (encrypted, expiring) token naming the build and its owner, so
 * it works from a chat message or the dashboard without a sign-in, and only for that build. The
 * file is rendered on request from the saved build; nothing but the build JSON is stored.
 */
import type { Express, RequestHandler } from "express";
import type { Env } from "../../core/env.js";
import type { Logger } from "../../core/logger.js";
import { Sealer } from "../../auth/seal.js";
import { loadBranding, loadLogo } from "./branding.js";
import { renderResumeDocx } from "./docx.js";
import { renderResumePdf } from "./pdf.js";
import { formatCandidateFilename } from "./schema.js";
import type { Build, BuildStore } from "./store.js";

export type Format = "pdf" | "docx";
export const MIME: Record<Format, string> = {
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
};
const LINK_TTL_S = 30 * 86_400;
const FILES_PATH = "/resume/files";

export function fileName(build: Build, format: Format, env: NodeJS.ProcessEnv): string {
  return `${loadBranding(env).file_prefix} - ${formatCandidateFilename(build.resume.candidate_name)}.${format}`;
}

/** Small cache so a dashboard preview + download + Gmail attach render once per version. */
const cache = new Map<string, Buffer>();
export async function renderBuild(build: Build, format: Format, env: NodeJS.ProcessEnv): Promise<Buffer> {
  const key = `${build.id}:${build.version}:${format}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const branding = loadBranding(env);
  const logo = loadLogo(env);
  const bytes = format === "pdf" ? await renderResumePdf(build.resume, build.consultant_email, branding, logo) : await renderResumeDocx(build.resume, build.consultant_email, branding, logo);
  cache.set(key, bytes);
  while (cache.size > 40) cache.delete(cache.keys().next().value!);
  return bytes;
}

export function downloadUrl(env: Env, build: Build, format: Format): string {
  const token = new Sealer(env.sealSecret).seal("file", { b: build.id, o: build.owner, f: format }, LINK_TTL_S);
  return `${env.publicUrl}${FILES_PATH}/${token}/${encodeURIComponent(fileName(build, format, env.raw))}`;
}

export function fileRoutes(app: Express, env: Env, store: BuildStore, limiter: RequestHandler, log: Logger) {
  const sealer = new Sealer(env.sealSecret);
  app.get(`${FILES_PATH}/:token{/:name}`, limiter, async (req, res) => {
    const t = sealer.open<{ b: string; o: string; f: Format }>("file", String(req.params.token));
    const build = t ? store.getById(t.b) : null;
    if (!t || !build || build.owner !== t.o || !(t.f in MIME)) {
      res.status(404).type("text/plain").send("This download link has expired or the resume was deleted. Open the resume in the Resume Builder for a new link.");
      return;
    }
    try {
      const bytes = await renderBuild(build, t.f, env.raw);
      const name = fileName(build, t.f, env.raw);
      res.setHeader("Content-Type", MIME[t.f]);
      res.setHeader("Content-Disposition", `attachment; filename="${name.replace(/[^\x20-\x7e]|"/g, "_")}"; filename*=UTF-8''${encodeURIComponent(name)}`);
      res.setHeader("Cache-Control", "private, no-store");
      res.send(bytes);
      log.info("resume_downloaded", { format: t.f });
    } catch (err) {
      log.error("resume_render_failed", { error: (err as Error).name });
      res.status(500).type("text/plain").send("The file couldn't be generated. Try again.");
    }
  });
}
