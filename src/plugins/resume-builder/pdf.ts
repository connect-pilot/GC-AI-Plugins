/**
 * Branded presentation resume as PDF — a port of the original workspace's ReportLab generator
 * (backend/services/resume_pdf_generator.py). Same page geometry, letterhead, border, footer,
 * fonts (Helvetica), sizes, leading, indents, column splits and section rules.
 *
 * ReportLab's flowable layout is reproduced with a small engine on top of PDFKit: paragraphs wrap
 * word by word with exact leading and may split across pages; table rows (the two-column grids and
 * the company/date rows) never split; spaceBefore is dropped at the top of a page, as in ReportLab.
 */
import PDFDocument from "pdfkit";
import { certText, displayName, type ResumeData, type SectionId } from "./schema.js";
import type { Branding, Letterhead } from "./branding.js";

// ── Page geometry (points; origin top-left, unlike ReportLab) ───────────
const INCH = 72;
const PAGE_W = 612;
const PAGE_H = 792;
const MARGIN_LR = 0.75 * INCH;
const MARGIN_TOP = 1.85 * INCH; // room for letterhead
const MARGIN_BOT = 0.85 * INCH; // room for footer
const FRAME_PAD = 6; // ReportLab SimpleDocTemplate frames pad 6pt on every side
const LOGO_W = 2.0 * INCH;
const LOGO_H = 1.05 * INCH;
const HEADER_LINE_Y = 1.75 * INCH; // divider below letterhead (from the top)
const BORDER_INSET = 0.4 * INCH;
/** The original computes table widths from the margins (not the padded frame). */
const AVAIL_W = PAGE_W - 2 * MARGIN_LR;

const FRAME_X = MARGIN_LR + FRAME_PAD;
const FRAME_W = PAGE_W - 2 * MARGIN_LR - 2 * FRAME_PAD;
const FRAME_TOP = MARGIN_TOP + FRAME_PAD;
const FRAME_BOTTOM = PAGE_H - MARGIN_BOT - FRAME_PAD;

const REGULAR = "Helvetica";
const BOLD = "Helvetica-Bold";

// ── Styles (same values as the original _styles()) ──────────────────────
interface Style {
  bold?: boolean;
  size: number;
  leading: number;
  align?: "left" | "center" | "right";
  leftIndent?: number;
  firstLineIndent?: number;
  spaceBefore?: number;
  spaceAfter?: number;
  color?: string;
}
const S = {
  name: { bold: true, size: 18, leading: 22, align: "center", spaceAfter: 2 },
  position_applied: { size: 11, leading: 14, align: "center", spaceAfter: 14, color: "#333333" },
  section_header: { bold: true, size: 11, leading: 14, spaceBefore: 10, spaceAfter: 2 },
  company: { bold: true, size: 10, leading: 13 },
  job_title: { bold: true, size: 10, leading: 13, spaceAfter: 2 },
  bullet: { size: 10, leading: 13, leftIndent: 18, firstLineIndent: -12, spaceAfter: 2 },
  body: { size: 10, leading: 13, spaceAfter: 4 },
  summary: { size: 10, leading: 13, spaceAfter: 6 },
  skill_cell: { size: 10, leading: 13, leftIndent: 12, firstLineIndent: -12 },
  date_right: { bold: true, size: 10, leading: 13, align: "right" },
  edu_institution: { size: 10, leading: 13, leftIndent: 18, firstLineIndent: -12 },
  edu_detail: { size: 10, leading: 13, leftIndent: 30, spaceAfter: 4 },
} satisfies Record<string, Style>;

const BULLET = "•  ";

// ── Text ─────────────────────────────────────────────────────────────────
/** A run of text in one weight ("<b>" in the original's Paragraph markup). */
type Run = { text: string; bold?: boolean };

/** Characters PDFKit's built-in Helvetica can draw (WinAnsi); anything else is approximated. */
const WIN_ANSI_EXTRA = "€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ";
const FALLBACKS: Record<string, string> = { "→": "->", "←": "<-", "≥": ">=", "≤": "<=", "✓": "", "✔": "", "‐": "-", "‑": "-", "‒": "-", "―": "—", "′": "'", "″": '"', "­": "" };
export function pdfSafe(s: string): string {
  let out = "";
  for (const ch of s.normalize("NFC")) {
    const c = ch.codePointAt(0)!;
    if ((c >= 32 && c <= 126) || (c >= 160 && c <= 255) || WIN_ANSI_EXTRA.includes(ch)) out += ch;
    else if (ch === "\t" || ch === "\n" || ch === "\r") out += " ";
    else if (FALLBACKS[ch] !== undefined) out += FALLBACKS[ch];
    else {
      const base = ch.normalize("NFKD").replace(/[̀-ͯ]/g, "");
      out += [...base].every((b) => b.charCodeAt(0) >= 32 && b.charCodeAt(0) <= 255) ? base : "?";
    }
  }
  return out;
}

type Doc = PDFKit.PDFDocument;

function measure(doc: Doc, text: string, bold: boolean | undefined, size: number) {
  return doc.font(bold ? BOLD : REGULAR).fontSize(size).widthOfString(text);
}

interface Word {
  text: string;
  bold: boolean;
  /** A space precedes this word on the line. */
  space: boolean;
}
type Line = { words: Word[]; width: number };

/** Greedy word wrap across runs (ReportLab collapses whitespace the same way). */
function wrap(doc: Doc, runs: Run[], style: Style, width: number): Line[] {
  const words: Word[] = [];
  let pendingSpace = false;
  for (const r of runs) {
    const text = pdfSafe(r.text);
    const parts = text.split(/( +)/);
    for (const p of parts) {
      if (!p) continue;
      if (/^ +$/.test(p)) {
        pendingSpace = words.length > 0;
        continue;
      }
      words.push({ text: p, bold: Boolean(r.bold ?? style.bold), space: pendingSpace });
      pendingSpace = false;
    }
  }
  const lines: Line[] = [];
  let cur: Line = { words: [], width: 0 };
  const lineWidth = (first: boolean) => width - (style.leftIndent ?? 0) - (first ? style.firstLineIndent ?? 0 : 0);
  for (const w of words) {
    const ww = measure(doc, w.text, w.bold, style.size);
    const sp = cur.words.length && w.space ? measure(doc, " ", w.bold, style.size) : 0;
    const avail = lineWidth(lines.length === 0);
    if (cur.words.length && cur.width + sp + ww > avail) {
      lines.push(cur);
      cur = { words: [], width: 0 };
    }
    if (!cur.words.length && ww > lineWidth(lines.length === 0)) {
      // A single word wider than the line: break it by characters.
      let chunk = "";
      for (const ch of w.text) {
        if (chunk && measure(doc, chunk + ch, w.bold, style.size) > lineWidth(lines.length === 0)) {
          lines.push({ words: [{ text: chunk, bold: w.bold, space: false }], width: measure(doc, chunk, w.bold, style.size) });
          chunk = "";
        }
        chunk += ch;
      }
      cur = { words: [{ text: chunk, bold: w.bold, space: false }], width: measure(doc, chunk, w.bold, style.size) };
      continue;
    }
    const space = cur.words.length > 0 && w.space;
    cur.words.push({ ...w, space });
    cur.width += (space ? measure(doc, " ", w.bold, style.size) : 0) + ww;
  }
  if (cur.words.length) lines.push(cur);
  return lines;
}

// ── Flowables ────────────────────────────────────────────────────────────
type Flowable =
  | { kind: "para"; runs: Run[]; style: Style }
  | { kind: "spacer"; height: number }
  | { kind: "rule"; thickness: number; spaceAfter: number }
  | { kind: "table"; colWidths: number[]; pad: { l: number; r: number; t: number; b: number }; rows: ({ runs: Run[]; style: Style } | null)[][] };

const para = (runs: Run[] | string, style: Style): Flowable => ({ kind: "para", runs: typeof runs === "string" ? [{ text: runs }] : runs, style });
const GRID_PAD = { l: 6, r: 4, t: 1, b: 1 };
const ROW_PAD = { l: 0, r: 0, t: 0, b: 0 };

class Layout {
  y = FRAME_TOP;
  atTop = true;
  constructor(
    private readonly doc: Doc,
    private readonly decorate: () => void,
  ) {
    decorate();
  }

  private newPage() {
    this.doc.addPage({ size: "LETTER", margin: 0 });
    this.decorate();
    this.y = FRAME_TOP;
    this.atTop = true;
  }

  /** Draws wrapped lines with their first baseline `size` below the line top (as ReportLab does). */
  private drawLines(lines: Line[], style: Style, x: number, width: number, top: number) {
    const doc = this.doc;
    lines.forEach((line, i) => {
      const indent = (style.leftIndent ?? 0) + (i === 0 ? style.firstLineIndent ?? 0 : 0);
      const avail = width - indent;
      let cx = x + indent;
      if (style.align === "center") cx += (avail - line.width) / 2;
      else if (style.align === "right") cx += avail - line.width;
      const baseline = top + i * style.leading + style.size;
      doc.fillColor(style.color ?? "#000000");
      for (const w of line.words) {
        if (w.space) cx += measure(doc, " ", w.bold, style.size);
        doc.font(w.bold ? BOLD : REGULAR).fontSize(style.size).text(w.text, cx, baseline, { lineBreak: false, baseline: "alphabetic" });
        cx += measure(doc, w.text, w.bold, style.size);
      }
    });
    doc.fillColor("#000000");
  }

  add(f: Flowable) {
    const doc = this.doc;
    if (f.kind === "spacer") {
      if (this.y + f.height > FRAME_BOTTOM) this.newPage();
      else this.y += f.height;
      this.atTop = false;
      return;
    }
    if (f.kind === "rule") {
      if (this.y + f.thickness > FRAME_BOTTOM) this.newPage();
      doc.save().lineWidth(f.thickness).strokeColor("#000000").moveTo(FRAME_X, this.y + f.thickness / 2).lineTo(FRAME_X + FRAME_W, this.y + f.thickness / 2).stroke().restore();
      this.y += f.thickness + f.spaceAfter;
      this.atTop = false;
      return;
    }
    if (f.kind === "para") {
      const st = f.style;
      if (!this.atTop) this.y += st.spaceBefore ?? 0;
      const lines = wrap(doc, f.runs, st, FRAME_W);
      if (!lines.length) {
        // An empty paragraph still takes no height in ReportLab; only its spacing applies.
        this.y += st.spaceAfter ?? 0;
        return;
      }
      let i = 0;
      while (i < lines.length) {
        const fit = Math.max(0, Math.floor((FRAME_BOTTOM - this.y) / st.leading + 1e-6));
        if (fit === 0) {
          this.newPage();
          continue;
        }
        const chunk = lines.slice(i, i + fit);
        // Keep the first line's indent only on the paragraph's real first line.
        const chunkStyle = i === 0 ? st : { ...st, firstLineIndent: 0 };
        this.drawLines(chunk, chunkStyle, FRAME_X, FRAME_W, this.y);
        this.y += chunk.length * st.leading;
        this.atTop = false;
        i += chunk.length;
        if (i < lines.length) this.newPage();
      }
      this.y += st.spaceAfter ?? 0;
      return;
    }
    // table
    for (const row of f.rows) {
      const cells = row.map((cell, c) => {
        if (!cell) return { lines: [] as Line[], style: S.skill_cell as Style, height: 0 };
        const w = f.colWidths[c]! - f.pad.l - f.pad.r;
        const lines = wrap(doc, cell.runs, cell.style, w);
        return { lines, style: cell.style, height: lines.length * cell.style.leading + (cell.style.spaceAfter ?? 0) };
      });
      const h = Math.max(...cells.map((c) => c.height)) + f.pad.t + f.pad.b;
      if (this.y + h > FRAME_BOTTOM && !this.atTop) this.newPage();
      let x = FRAME_X;
      cells.forEach((c, i) => {
        if (c.lines.length) this.drawLines(c.lines, c.style, x + f.pad.l, f.colWidths[i]! - f.pad.l - f.pad.r, this.y + f.pad.t);
        x += f.colWidths[i]!;
      });
      this.y += h;
      this.atTop = false;
    }
  }
}

// ── Letterhead, border and footer on every page ─────────────────────────
function pageDecorator(doc: Doc, letterhead: Letterhead, branding: Branding, logo: Buffer | null) {
  return () => {
    doc.save();
    doc.lineWidth(1).strokeColor("#000000").rect(BORDER_INSET, BORDER_INSET, PAGE_W - 2 * BORDER_INSET, PAGE_H - 2 * BORDER_INSET).stroke();
    if (logo) {
      try {
        // ReportLab: drawImage at y = PAGE_H - 1.5in, box 2.0in × 1.05in, preserveAspectRatio, anchor "nw".
        const boxTop = PAGE_H - (PAGE_H - 1.5 * INCH + LOGO_H);
        doc.image(logo, MARGIN_LR, boxTop, { fit: [LOGO_W, LOGO_H] }); // fit keeps the aspect ratio, anchored top-left
      } catch {
        // an unreadable logo never blocks the resume
      }
    }
    doc.fillColor("#000000").font(REGULAR).fontSize(11);
    const right = PAGE_W - MARGIN_LR;
    [letterhead.phone, letterhead.email, letterhead.website].forEach((line, i) => {
      const text = pdfSafe(line ?? "");
      if (!text) return;
      doc.text(text, right - doc.widthOfString(text), 0.75 * INCH + i * 16, { lineBreak: false, baseline: "alphabetic" });
    });
    doc.lineWidth(0.75).moveTo(MARGIN_LR, HEADER_LINE_Y).lineTo(PAGE_W - MARGIN_LR, HEADER_LINE_Y).stroke();
    doc.font(REGULAR).fontSize(8);
    const footer = pdfSafe(`Proprietary and Confidential © ${branding.company_name}`);
    doc.text(footer, PAGE_W / 2 - doc.widthOfString(footer) / 2, PAGE_H - 0.5 * INCH, { lineBreak: false, baseline: "alphabetic" });
    doc.restore();
  };
}

// ── Section builders (same rules as the original) ───────────────────────
const header = (title: string): Flowable[] => [para([{ text: title.toUpperCase(), bold: true }], S.section_header), { kind: "rule", thickness: 0.5, spaceAfter: 4 }];

function twoColumns(items: string[]): Flowable {
  const mid = Math.ceil(items.length / 2);
  const col1 = items.slice(0, mid);
  const col2 = items.slice(mid);
  return {
    kind: "table",
    colWidths: [AVAIL_W * 0.5, AVAIL_W * 0.5],
    pad: GRID_PAD,
    rows: col1.map((a, i) => [{ runs: [{ text: BULLET + a }], style: S.skill_cell }, col2[i] !== undefined ? { runs: [{ text: BULLET + col2[i] }], style: S.skill_cell } : null]),
  };
}

const builders: Record<SectionId, (d: ResumeData) => Flowable[]> = {
  summary(d) {
    if (!d.professional_summary) return [];
    return [...header(d.summary_header || "PROFESSIONAL SUMMARY"), para(d.professional_summary, S.summary)];
  },

  education(d) {
    if (!d.education.length) return [];
    const out = header("EDUCATION");
    if (d.education.length === 1) {
      const e = d.education[0]!;
      const parts: string[] = [];
      if (e.institution) parts.push(e.institution);
      if (e.degree_type && e.field) parts.push(`${e.degree_type} in ${e.field}`);
      else if (e.degree_type) parts.push(e.degree_type);
      else if (e.field) parts.push(e.field);
      if (e.gpa) parts.push(`(GPA: ${e.gpa})`);
      if (e.year) parts.push(e.year);
      out.push(para(parts.join(" | "), S.body));
      if (e.description) out.push(para(e.description, S.body));
      return out;
    }
    for (const e of d.education) {
      let inst = e.institution;
      if (e.field && !e.degree_type) inst += " " + e.field;
      out.push(para(BULLET + inst, S.edu_institution));
      if (e.degree_type || e.field) {
        const detail: string[] = [];
        if (e.degree_type) detail.push(e.degree_type);
        if (e.field && e.degree_type) detail.push("| " + e.field);
        if (e.gpa) detail.push(`(GPA: ${e.gpa})`);
        if (e.year) detail.push(e.year);
        out.push(para(detail.join(" "), S.edu_detail));
      }
      if (e.description) out.push(para(e.description, S.edu_detail));
    }
    return out;
  },

  work(d) {
    if (!d.professional_history.length) return [];
    const out = header(d.work_header || "PROFESSIONAL EXPERIENCE");
    const cols = [AVAIL_W * 0.62, AVAIL_W * 0.38];
    for (const entry of d.professional_history) {
      entry.roles.forEach((role, i) => {
        const date = role.start_date ? `${role.start_date} to ${role.end_date}` : role.end_date;
        const title: Run[] = [{ text: role.title, bold: true }, ...(role.title_suffix ? [{ text: ` | ${role.title_suffix}`, bold: false }] : [])];
        const dateCell = { runs: [{ text: date, bold: true }], style: S.date_right };
        if (i === 0) {
          out.push({ kind: "table", colWidths: cols, pad: ROW_PAD, rows: [[{ runs: [{ text: entry.company, bold: true }], style: S.company }, dateCell]] });
          out.push(para(title, S.job_title));
        } else {
          out.push({ kind: "table", colWidths: cols, pad: ROW_PAD, rows: [[{ runs: title, style: S.job_title }, dateCell]] });
        }
        for (const b of role.bullets) out.push(para(BULLET + b, S.bullet));
      });
      out.push({ kind: "spacer", height: 12 });
    }
    return out;
  },

  projects(d) {
    if (!d.project_experience.length) return [];
    const out = header("PROJECTS COMPLETED");
    if (d.project_experience.length > 6) out.push(twoColumns(d.project_experience));
    else for (const p of d.project_experience) out.push(para(BULLET + p, S.bullet));
    return out;
  },

  skills(d) {
    if (!d.skills.length) return [];
    const combined = !d.separate_certifications && d.certifications.length > 0;
    const out = header(combined ? "SKILLS & CERTIFICATIONS" : "SKILLS");
    // Always bulleted, two columns, filled row by row (as the original).
    const rows: ({ runs: Run[]; style: Style } | null)[][] = [];
    for (let i = 0; i < d.skills.length; i += 2) {
      rows.push([0, 1].map((j) => (d.skills[i + j] !== undefined ? { runs: [{ text: BULLET + d.skills[i + j] }], style: S.skill_cell } : null)));
    }
    out.push({ kind: "table", colWidths: [AVAIL_W / 2, AVAIL_W / 2], pad: GRID_PAD, rows });
    if (combined) out.push(para("Certifications: " + d.certifications.map(certText).join(" | "), S.body));
    return out;
  },

  certifications(d) {
    if (!d.separate_certifications || !d.certifications.length) return [];
    const out = header("CERTIFICATIONS");
    const texts = d.certifications.map(certText);
    if (texts.length > 4) out.push(twoColumns(texts));
    else for (const t of texts) out.push(para(BULLET + t, S.bullet));
    return out;
  },
};

/** Renders the presentation resume PDF. */
export function renderResumePdf(data: ResumeData, letterhead: Letterhead, branding: Branding, logo: Buffer | null): Promise<Buffer> {
  const doc = new PDFDocument({
    size: "LETTER",
    margin: 0,
    info: { Title: `Presentation Resume - ${pdfSafe(data.candidate_name)}`, Author: pdfSafe(branding.company_name), Creator: "GoldCoast Resume Builder" },
  });
  const chunks: Buffer[] = [];
  doc.on("data", (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });

  const layout = new Layout(doc, pageDecorator(doc, letterhead, branding, logo));
  layout.add(para(displayName(data), S.name));
  if (data.position_applied) layout.add(para(data.position_applied, S.position_applied));
  else layout.add({ kind: "spacer", height: 10 });
  for (const section of data.section_order) for (const f of builders[section]?.(data) ?? []) layout.add(f);

  doc.end();
  return done;
}
