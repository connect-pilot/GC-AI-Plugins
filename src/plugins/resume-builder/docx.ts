/**
 * Branded presentation resume as DOCX — a port of the original workspace's python-docx generator
 * (backend/services/resume_docx_generator.py), which mirrors the PDF so recruiters can edit in Word
 * and export with the same look: Arial 10pt with exact leading everywhere, zero table cell margins,
 * a right tab stop for dates, a page border 0.4in from the edge, and the letterhead/footer in the
 * page header/footer.
 */
import {
  AlignmentType,
  BorderStyle,
  Document,
  Footer,
  Header,
  ImageRun,
  LineRuleType,
  Packer,
  PageBorderOffsetFrom,
  Paragraph,
  Table,
  TableCell,
  TableLayoutType,
  TableRow,
  TabStopType,
  TextRun,
  VerticalAlign,
  WidthType,
  type IParagraphOptions,
  type ParagraphChild,
} from "docx";
import { imageSize, type Branding, type Letterhead } from "./branding.js";
import { certText, displayName, type ResumeData, type SectionId } from "./schema.js";

const FONT = "Arial";
const TWIP = 20; // per point
const IN = 1440; // twips per inch
const CONTENT_W = 7 * IN; // 8.5 - 0.75 - 0.75
const HALF_W = 3.5 * IN;
const DATE_TAB = 7 * IN;
const BULLET = "•  ";

const pt = (n: number) => Math.round(n * TWIP);
/** Half-points, as Word sizes fonts. */
const hp = (n: number) => n * 2;

/** Strips characters XML 1.0 can't hold (they'd corrupt the file). */
const xmlSafe = (s: string) => s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/g, "");

const run = (text: string, opts: { size?: number; bold?: boolean; color?: string } = {}) =>
  new TextRun({ text: xmlSafe(text), font: FONT, size: hp(opts.size ?? 10), bold: opts.bold ?? false, color: opts.color });

const exact = (leading: number, before = 0, after = 0) => ({ line: pt(leading), lineRule: LineRuleType.EXACT, before: pt(before), after: pt(after) });

function p(children: ParagraphChild[], opts: Omit<IParagraphOptions, "children"> = {}) {
  return new Paragraph({ ...opts, children });
}

/** _add_paragraph: one run, exact leading = size + 3. */
function textPara(text: string, o: { size?: number; bold?: boolean; align?: (typeof AlignmentType)[keyof typeof AlignmentType]; color?: string; before?: number; after?: number } = {}) {
  const size = o.size ?? 10;
  return p([run(text, { size, bold: o.bold, color: o.color })], { alignment: o.align, spacing: exact(size + 3, o.before, o.after) });
}

const bottomBorder = (sz: number) => ({ bottom: { style: BorderStyle.SINGLE, size: sz, space: 1, color: "000000" } });

function sectionHeader(title: string) {
  return p([run(title.toUpperCase(), { size: 11, bold: true })], { spacing: exact(14, 10, 2), border: bottomBorder(4) });
}

function bullet(text: string, left = Math.round(0.25 * IN)) {
  return p([run(BULLET + text)], { indent: { left, hanging: Math.round(0.17 * IN) }, spacing: exact(13, 0, 2) });
}

function leftRightLine(left: ParagraphChild[], date: string, after: number) {
  return p([...left, new TextRun({ text: "\t", font: FONT, size: hp(10) }), run(date, { bold: true })], {
    tabStops: [{ type: TabStopType.RIGHT, position: DATE_TAB }],
    spacing: exact(13, 0, after),
  });
}

const NO_BORDERS = {
  top: { style: BorderStyle.NONE, size: 0, color: "auto" },
  bottom: { style: BorderStyle.NONE, size: 0, color: "auto" },
  left: { style: BorderStyle.NONE, size: 0, color: "auto" },
  right: { style: BorderStyle.NONE, size: 0, color: "auto" },
  insideHorizontal: { style: BorderStyle.NONE, size: 0, color: "auto" },
  insideVertical: { style: BorderStyle.NONE, size: 0, color: "auto" },
};
const ZERO_MARGINS = { top: 0, bottom: 0, left: 0, right: 0 };

/** _add_two_col_bullets: column 1 gets the first half (rounded up). */
function twoColBullets(items: string[]) {
  const mid = Math.ceil(items.length / 2);
  const col1 = items.slice(0, mid);
  const col2 = items.slice(mid);
  const cell = (item: string | undefined) =>
    new TableCell({
      width: { size: HALF_W, type: WidthType.DXA },
      children: [p(item ? [run(BULLET + item)] : [], { spacing: exact(13, 1, 1), indent: { left: pt(6) } })],
    });
  return new Table({
    width: { size: CONTENT_W, type: WidthType.DXA },
    columnWidths: [HALF_W, HALF_W],
    layout: TableLayoutType.FIXED,
    alignment: AlignmentType.LEFT,
    borders: NO_BORDERS,
    margins: ZERO_MARGINS,
    rows: col1.map((a, i) => new TableRow({ children: [cell(a), cell(col2[i])] })),
  });
}

// ── Header / footer ──────────────────────────────────────────────────────
function buildHeader(letterhead: Letterhead, logo: Buffer | null) {
  const logoChildren: ParagraphChild[] = [];
  if (logo) {
    const dim = imageSize(logo);
    const type = logo[0] === 0x89 ? "png" : logo[0] === 0xff ? "jpg" : null;
    if (dim && type) {
      const width = 2 * 96; // 2.0in at 96 px/in
      logoChildren.push(new ImageRun({ type, data: logo, transformation: { width, height: Math.round((width * dim.height) / dim.width) } }));
    }
  }
  const contact: ParagraphChild[] = [];
  [letterhead.phone, letterhead.email, letterhead.website].forEach((line, i) => {
    contact.push(new TextRun({ text: xmlSafe(line ?? ""), font: FONT, size: hp(11), break: i > 0 ? 1 : undefined }));
  });
  const cell = (children: Paragraph[]) => new TableCell({ width: { size: HALF_W, type: WidthType.DXA }, verticalAlign: VerticalAlign.CENTER, children });
  return new Header({
    children: [
      p([new TextRun({ text: "", size: hp(6) })], { spacing: exact(6, 0, 8) }),
      new Table({
        width: { size: CONTENT_W, type: WidthType.DXA },
        columnWidths: [HALF_W, HALF_W],
        layout: TableLayoutType.FIXED,
        alignment: AlignmentType.LEFT,
        borders: NO_BORDERS,
        margins: ZERO_MARGINS,
        rows: [
          new TableRow({
            children: [
              cell([p(logoChildren, { alignment: AlignmentType.LEFT, spacing: { before: 0, after: 0 } })]),
              cell([p(contact, { alignment: AlignmentType.RIGHT, spacing: exact(16) })]),
            ],
          }),
        ],
      }),
      p([new TextRun({ text: "", size: hp(2) })], { spacing: exact(2, 8, 0), border: bottomBorder(6) }),
    ],
  });
}

function buildFooter(branding: Branding) {
  return new Footer({
    children: [p([run(`Proprietary and Confidential © ${branding.company_name}`, { size: 8 })], { alignment: AlignmentType.CENTER, spacing: exact(10) })],
  });
}

// ── Sections ─────────────────────────────────────────────────────────────
type Block = Paragraph | Table;

const builders: Record<SectionId, (d: ResumeData) => Block[]> = {
  summary(d) {
    if (!d.professional_summary) return [];
    return [sectionHeader(d.summary_header || "PROFESSIONAL SUMMARY"), textPara(d.professional_summary, { after: 6 })];
  },

  education(d) {
    if (!d.education.length) return [];
    const out: Block[] = [sectionHeader("EDUCATION")];
    if (d.education.length === 1) {
      const e = d.education[0]!;
      const parts: string[] = [];
      if (e.institution) parts.push(e.institution);
      if (e.degree_type && e.field) parts.push(`${e.degree_type} in ${e.field}`);
      else if (e.degree_type) parts.push(e.degree_type);
      else if (e.field) parts.push(e.field);
      if (e.gpa) parts.push(`(GPA: ${e.gpa})`);
      if (e.year) parts.push(e.year);
      out.push(textPara(parts.join(" | "), { after: 4 }));
      if (e.description) out.push(textPara(e.description, { after: 4 }));
      return out;
    }
    const detail = (text: string) => p([run(text)], { indent: { left: Math.round(0.42 * IN) }, spacing: exact(13, 0, 4) });
    for (const e of d.education) {
      let inst = e.institution;
      if (e.field && !e.degree_type) inst += " " + e.field;
      out.push(bullet(inst));
      if (e.degree_type || e.field) {
        const parts: string[] = [];
        if (e.degree_type) parts.push(e.degree_type);
        if (e.field && e.degree_type) parts.push("| " + e.field);
        if (e.gpa) parts.push(`(GPA: ${e.gpa})`);
        if (e.year) parts.push(e.year);
        out.push(detail(parts.join(" ")));
      }
      if (e.description) out.push(detail(e.description));
    }
    return out;
  },

  work(d) {
    if (!d.professional_history.length) return [];
    const out: Block[] = [sectionHeader(d.work_header || "PROFESSIONAL EXPERIENCE")];
    for (const entry of d.professional_history) {
      entry.roles.forEach((role, i) => {
        const date = role.start_date ? `${role.start_date} to ${role.end_date}` : role.end_date;
        const title = role.title_suffix ? `${role.title} | ${role.title_suffix}` : role.title;
        if (i === 0) {
          out.push(leftRightLine([run(entry.company, { bold: true })], date, 0));
          out.push(p([run(title, { bold: true })], { spacing: exact(13, 0, 2) }));
        } else {
          out.push(leftRightLine([run(title, { bold: true })], date, 2));
        }
        for (const b of role.bullets) out.push(bullet(b));
      });
      out.push(p([], { spacing: exact(1, 0, 12) })); // space between companies (PDF Spacer(1, 12))
    }
    return out;
  },

  projects(d) {
    if (!d.project_experience.length) return [];
    const out: Block[] = [sectionHeader("PROJECTS COMPLETED")];
    if (d.project_experience.length > 6) out.push(twoColBullets(d.project_experience));
    else for (const x of d.project_experience) out.push(bullet(x));
    return out;
  },

  skills(d) {
    if (!d.skills.length) return [];
    const combined = !d.separate_certifications && d.certifications.length > 0;
    const out: Block[] = [sectionHeader(combined ? "SKILLS & CERTIFICATIONS" : "SKILLS"), twoColBullets(d.skills)];
    if (combined) out.push(textPara("Certifications: " + d.certifications.map(certText).join(" | "), { after: 4 }));
    return out;
  },

  certifications(d) {
    if (!d.separate_certifications || !d.certifications.length) return [];
    const texts = d.certifications.map(certText);
    const out: Block[] = [sectionHeader("CERTIFICATIONS")];
    if (texts.length > 4) out.push(twoColBullets(texts));
    else for (const t of texts) out.push(bullet(t));
    return out;
  },
};

/** Renders the presentation resume DOCX. */
export async function renderResumeDocx(data: ResumeData, letterhead: Letterhead, branding: Branding, logo: Buffer | null): Promise<Buffer> {
  const children: Block[] = [textPara(displayName(data), { size: 18, bold: true, align: AlignmentType.CENTER, after: 2 })];
  if (data.position_applied) children.push(textPara(data.position_applied, { size: 11, align: AlignmentType.CENTER, color: "333333", after: 14 }));
  for (const s of data.section_order) children.push(...(builders[s]?.(data) ?? []));

  const pageBorder = { style: BorderStyle.SINGLE, size: 8, color: "000000", space: 29 };
  const doc = new Document({
    creator: branding.company_name,
    title: `Presentation Resume - ${data.candidate_name}`,
    styles: {
      default: {
        document: {
          run: { font: FONT, size: hp(10) },
          paragraph: { spacing: exact(13) },
        },
      },
    },
    sections: [
      {
        properties: {
          page: {
            size: { width: 8.5 * IN, height: 11 * IN },
            margin: { top: Math.round(1.85 * IN), bottom: Math.round(0.85 * IN), left: Math.round(0.75 * IN), right: Math.round(0.75 * IN), header: Math.round(0.45 * IN), footer: Math.round(0.35 * IN) },
            borders: {
              pageBorders: { offsetFrom: PageBorderOffsetFrom.PAGE },
              pageBorderTop: pageBorder,
              pageBorderBottom: pageBorder,
              pageBorderLeft: pageBorder,
              pageBorderRight: pageBorder,
            },
          },
        },
        headers: { default: buildHeader(letterhead, logo) },
        footers: { default: buildFooter(branding) },
        children,
      },
    ],
  });
  return Packer.toBuffer(doc);
}
