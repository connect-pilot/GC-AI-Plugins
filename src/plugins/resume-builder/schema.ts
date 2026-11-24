/**
 * The structured presentation-resume JSON — the same schema the original GoldCoast Resume Builder
 * agent produced (see prompts.ts). Lenient on input (nulls, missing fields, plain-string
 * certifications) and normalized into one clean shape for the PDF/DOCX renderers and the dashboard.
 */
import { z } from "zod";

const str = (max: number) => z.union([z.string().max(max), z.number().transform(String)]).nullish();
const list = <T extends z.ZodTypeAny>(item: T, max: number) => z.array(item).max(max).nullish();

export const SECTION_IDS = ["summary", "skills", "certifications", "work", "projects", "education"] as const;
export type SectionId = (typeof SECTION_IDS)[number];
export const DEFAULT_SECTION_ORDER: SectionId[] = ["summary", "skills", "certifications", "work", "projects", "education"];

const roleIn = z.object({
  title: str(300),
  title_suffix: str(300),
  start_date: str(80),
  end_date: str(80),
  bullets: list(z.string().max(2000), 80),
});

export const resumeDataInput = z
  .object({
    candidate_name: str(200),
    nickname: str(100),
    position_applied: str(300),
    summary_header: str(80),
    professional_summary: str(6000),
    section_order: list(z.string().max(40), 12),
    education: list(
      z.object({
        institution: str(300),
        degree_type: str(200),
        field: str(300),
        gpa: str(20),
        year: str(40),
        description: str(1500),
      }),
      30,
    ),
    work_header: str(80),
    professional_history: list(z.object({ company: str(300), roles: list(roleIn, 30) }), 60),
    project_experience: list(z.string().max(1000), 200),
    skills: list(z.string().max(300), 200),
    certifications: list(z.union([z.string().max(400), z.object({ name: str(400), dates: str(120) })]), 100),
    separate_certifications: z.boolean().nullish(),
  })
  .passthrough();

export type ResumeDataInput = z.infer<typeof resumeDataInput>;

export interface Role {
  title: string;
  title_suffix: string | null;
  start_date: string;
  end_date: string;
  bullets: string[];
}
export interface Education {
  institution: string;
  degree_type: string;
  field: string;
  gpa: string;
  year: string;
  description: string;
}
export interface Certification {
  name: string;
  dates: string | null;
}
export interface ResumeData {
  candidate_name: string;
  nickname: string | null;
  position_applied: string | null;
  summary_header: string;
  professional_summary: string;
  section_order: SectionId[];
  education: Education[];
  work_header: string;
  professional_history: { company: string; roles: Role[] }[];
  project_experience: string[];
  skills: string[];
  certifications: Certification[];
  separate_certifications: boolean;
}

const t = (v: string | null | undefined) => (v ?? "").toString().replace(/\s+/g, " ").trim();
const opt = (v: string | null | undefined) => t(v) || null;
const strs = (v: (string | null | undefined)[] | null | undefined) => (v ?? []).map(t).filter(Boolean);

/** Normalizes model (or dashboard) input into the renderer's shape. */
export function normalizeResume(input: ResumeDataInput): ResumeData {
  const order = (input.section_order ?? []).map((s) => t(s).toLowerCase()).filter((s): s is SectionId => (SECTION_IDS as readonly string[]).includes(s));
  return {
    candidate_name: t(input.candidate_name) || "CANDIDATE",
    nickname: opt(input.nickname),
    position_applied: opt(input.position_applied),
    summary_header: t(input.summary_header) || "PROFESSIONAL SUMMARY",
    professional_summary: t(input.professional_summary),
    section_order: order.length ? [...new Set(order)] : [...DEFAULT_SECTION_ORDER],
    education: (input.education ?? []).map((e) => ({
      institution: t(e.institution),
      degree_type: t(e.degree_type),
      field: t(e.field),
      gpa: t(e.gpa),
      year: t(e.year),
      description: t(e.description),
    })),
    work_header: t(input.work_header) || "PROFESSIONAL EXPERIENCE",
    professional_history: (input.professional_history ?? []).map((c) => ({
      company: t(c.company),
      roles: (c.roles ?? []).map((r) => ({
        title: t(r.title),
        title_suffix: opt(r.title_suffix),
        start_date: t(r.start_date),
        end_date: t(r.end_date),
        bullets: strs(r.bullets),
      })),
    })),
    project_experience: strs(input.project_experience),
    skills: strs(input.skills),
    certifications: (input.certifications ?? [])
      .map((c) => (typeof c === "string" ? { name: t(c), dates: null } : { name: t(c.name), dates: opt(c.dates) }))
      .filter((c) => c.name),
    separate_certifications: Boolean(input.separate_certifications),
  };
}

/** "Name | dates" — how both renderers print a certification. */
export const certText = (c: Certification) => (c.dates ? `${c.name} | ${c.dates}` : c.name);

/** "Aaron E. Ezrilov" → "Ezrilov, Aaron" (first word + last word), as the original file names. */
export function formatCandidateFilename(candidateName: string): string {
  const cleaned = (candidateName ?? "").replace(/[^\p{L}\p{N} -]/gu, "").trim();
  const parts = cleaned.split(/\s+/).filter(Boolean);
  if (!parts.length) return "Candidate";
  if (parts.length === 1) return parts[0]!;
  return `${parts[parts.length - 1]}, ${parts[0]}`;
}

/** FIRST “NICK” LAST when a nickname is set. */
export function displayName(d: Pick<ResumeData, "candidate_name" | "nickname">): string {
  if (!d.nickname) return d.candidate_name;
  const parts = d.candidate_name.split(/\s+/);
  return `${parts[0] ?? d.candidate_name} “${d.nickname}” ${parts.slice(1).join(" ")}`.trim();
}

// ---------------------------------------------------------------------------
// What travels with a build besides the resume itself (all optional in chat).
// ---------------------------------------------------------------------------

export const clientEmailInput = z.object({
  subject: z.string().max(500),
  body: z.string().max(20_000),
});
export type ClientEmail = z.infer<typeof clientEmailInput>;

export const contentReviewInput = z.object({
  included: z.array(z.string().max(500)).max(60).optional(),
  omitted: z.array(z.string().max(500)).max(80).optional(),
  enhanced: z.array(z.string().max(500)).max(80).optional(),
  flags: z.array(z.string().max(500)).max(40).optional().describe("Substantive content dropped that the recruiter may want back"),
});
export type ContentReview = z.infer<typeof contentReviewInput>;

export const intakeInput = z.object({
  compensation_recent: z.string().max(500).optional(),
  compensation_requested: z.string().max(500).optional(),
  internal_references: z.array(z.string().max(200)).max(30).optional(),
  notes: z.string().max(5000).optional(),
  candidate_email: z.string().max(200).optional().describe("From the ORIGINAL resume (for the client email only)"),
  candidate_phone: z.string().max(60).optional().describe("From the ORIGINAL resume (for the client email only)"),
  candidate_location: z.string().max(200).optional().describe("City, State from the ORIGINAL resume"),
});
export type Intake = z.infer<typeof intakeInput>;
