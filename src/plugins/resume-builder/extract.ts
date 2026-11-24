/**
 * Resume text extraction (the original agent's extract_resume_text): PDF via MuPDF, DOCX via
 * mammoth, plain text as is. Scanned PDFs (little or no text layer) also get page images so
 * Claude can read them. Everything happens in memory; nothing is written to disk.
 */
import mammoth from "mammoth";
import * as mupdf from "mupdf";

export class ExtractError extends Error {
  override name = "ExtractError";
}

export const MAX_RESUME_BYTES = 10 * 1024 * 1024;
const MAX_IMAGE_PAGES = 4;
/** Below this many characters per page a PDF is treated as a scan. */
const SCAN_CHARS_PER_PAGE = 120;

export interface Extracted {
  kind: "pdf" | "docx" | "text";
  pages: number;
  /** "--- Page N ---" separated text, like the original tool returned. */
  text: string;
  /** JPEG (base64) page images for scans, so Claude can read them. */
  images: string[];
}

const extOf = (name: string) => (name.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? "");

export function detectKind(fileName: string, bytes: Uint8Array): Extracted["kind"] {
  if (bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46) return "pdf"; // %PDF
  if (bytes[0] === 0x50 && bytes[1] === 0x4b) {
    if (extOf(fileName) === "docx" || extOf(fileName) === "") return "docx"; // zip container
  }
  const ext = extOf(fileName);
  if (ext === "doc") throw new ExtractError("Old Word .doc files can't be read. Save it as .docx or PDF and upload it again.");
  if (["txt", "md", "text", "rtf"].includes(ext) || !bytes.subarray(0, 2000).some((b) => b === 0)) return "text";
  throw new ExtractError("Upload the resume as a PDF, Word (.docx) or text file.");
}

export async function extractResume(fileName: string, bytes: Uint8Array): Promise<Extracted> {
  if (!bytes.length) throw new ExtractError("That file is empty.");
  if (bytes.length > MAX_RESUME_BYTES) throw new ExtractError("That file is larger than 10 MB.");
  const kind = detectKind(fileName, bytes);

  if (kind === "text") {
    const text = Buffer.from(bytes).toString("utf8").replace(/\r\n?/g, "\n").trim();
    if (!text) throw new ExtractError("No text could be read from that file.");
    return { kind, pages: 1, text: `--- Page 1 ---\n${text}`, images: [] };
  }

  if (kind === "docx") {
    try {
      const r = await mammoth.extractRawText({ buffer: Buffer.from(bytes) });
      const text = r.value.replace(/\n{3,}/g, "\n\n").trim();
      if (!text) throw new ExtractError("No text could be read from that Word file.");
      return { kind, pages: 1, text: `--- Page 1 ---\n${text}`, images: [] };
    } catch (err) {
      if (err instanceof ExtractError) throw err;
      throw new ExtractError("That Word file couldn't be opened. Re-save it as .docx or PDF and try again.");
    }
  }

  let doc: mupdf.Document;
  try {
    doc = mupdf.Document.openDocument(bytes, "application/pdf");
  } catch {
    throw new ExtractError("That PDF couldn't be opened — it may be corrupt or password-protected.");
  }
  const pages = doc.countPages();
  const texts: string[] = [];
  for (let i = 0; i < pages; i++) {
    const t = doc.loadPage(i).toStructuredText("preserve-whitespace").asText().replace(/[ \t]+\n/g, "\n").trim();
    texts.push(`--- Page ${i + 1} ---\n${t}`);
  }
  const chars = texts.join("").replace(/--- Page \d+ ---|\s/g, "").length;
  const images: string[] = [];
  if (chars < SCAN_CHARS_PER_PAGE * Math.max(pages, 1)) {
    for (let i = 0; i < Math.min(pages, MAX_IMAGE_PAGES); i++) {
      const pix = doc.loadPage(i).toPixmap(mupdf.Matrix.scale(150 / 72, 150 / 72), mupdf.ColorSpace.DeviceRGB, false);
      images.push(Buffer.from(pix.asJPEG(80)).toString("base64"));
    }
  }
  return { kind, pages, text: texts.join("\n\n"), images };
}

/** A first guess at the candidate's name from the top of the resume (dashboard display only). */
export function guessName(text: string): string | null {
  for (const raw of text.split("\n").slice(0, 12)) {
    const line = raw.replace(/--- Page \d+ ---/, "").trim();
    if (!line || line.length > 40 || /[@\d|•:/]/.test(line) || /resume|curriculum|vitae|summary|profile/i.test(line)) continue;
    const words = line.split(/\s+/);
    if (words.length >= 2 && words.length <= 4 && words.every((w) => /^[\p{Lu}][\p{L}'.-]*$/u.test(w) || /^[\p{Lu}'.-]+$/u.test(w))) {
      return words.map((w) => (w === w.toUpperCase() && w.length > 2 ? w[0] + w.slice(1).toLowerCase() : w)).join(" ");
    }
  }
  return null;
}
