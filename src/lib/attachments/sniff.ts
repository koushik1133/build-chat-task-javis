/**
 * Content sniffing for non-image attachments (client-safe, pure).
 *
 * The declared MIME type and extension are attacker-controlled; the bytes are
 * not. Office formats are recognised by their container signatures:
 *
 *   docx / xlsx  ZIP local-file header `PK\x03\x04` + a `[Content_Types].xml`
 *                entry, then `word/` vs `xl/` part names decide which.
 *   doc / xls    OLE2 compound file header `D0 CF 11 E0 A1 B1 1A E1`.
 *   pdf          `%PDF-` at offset 0.
 *
 * Text types (csv/txt) must not start with a binary signature either.
 */

export type OfficeKind = "docx" | "xlsx" | "ooxml" | "ole" | "pdf" | "zip" | null;

const ZIP = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
const OLE = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
const SCAN_LIMIT = 4 * 1024 * 1024;

function startsWith(bytes: Uint8Array, sig: Buffer): boolean {
  if (bytes.length < sig.length) return false;
  for (let i = 0; i < sig.length; i++) if (bytes[i] !== sig[i]) return false;
  return true;
}

/** Latin-1 view of the first few MB: ZIP entry names and the central directory live in plain bytes. */
function textView(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, Math.min(bytes.length, SCAN_LIMIT)).toString("latin1");
}

export function sniffOffice(bytes: Uint8Array): OfficeKind {
  if (bytes.length >= 5 && Buffer.from(bytes.buffer, bytes.byteOffset, 5).toString("latin1") === "%PDF-") return "pdf";
  if (startsWith(bytes, OLE)) return "ole";
  if (startsWith(bytes, ZIP)) {
    const text = textView(bytes);
    if (!text.includes("[Content_Types].xml")) return "zip";
    if (text.includes("word/")) return "docx";
    if (text.includes("xl/")) return "xlsx";
    return "ooxml";
  }
  return null;
}

const OOXML_FOR: Record<string, "docx" | "xlsx"> = {
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
};
const OLE_TYPES = new Set(["application/msword", "application/vnd.ms-excel"]);

/**
 * Null when `bytes` are consistent with the resolved `mime`, else a reason.
 * Images are handled separately by `sniffImage`.
 */
export function verifyDeclaredType(mime: string, bytes: Uint8Array): string | null {
  const kind = sniffOffice(bytes);
  if (mime === "application/pdf") return kind === "pdf" ? null : "File is not a valid PDF";
  const want = OOXML_FOR[mime];
  if (want) {
    if (kind === want || kind === "ooxml") return null;
    return kind === "ole" ? `File is a legacy Office document; save it as .${want}` : `File is not a valid ${want.toUpperCase()} document`;
  }
  if (OLE_TYPES.has(mime)) {
    if (kind === "ole") return null;
    return kind === "docx" || kind === "xlsx" || kind === "ooxml" ? "File is an Office Open XML document; upload it as .docx/.xlsx" : "File is not a valid legacy Office document";
  }
  if (mime === "text/csv" || mime === "text/plain") {
    if (kind !== null) return "Text files must not contain a PDF, ZIP or Office container";
    for (let i = 0; i < Math.min(bytes.length, 512); i++) if (bytes[i] === 0) return "Text files must not contain binary data";
    return null;
  }
  return null;
}
