/**
 * Content sniffing for uploaded brand images. The browser-declared MIME type
 * and the file extension are both attacker-controlled; the bytes are not.
 *
 * SVG is XML and can carry scripts, event handlers and external references,
 * so an SVG is only accepted when it is free of those (a logo never needs
 * them). Everything else is matched on its magic bytes.
 */

export type SniffedImage = { mime: "image/png" | "image/jpeg" | "image/webp" | "image/x-icon" | "image/svg+xml"; ext: "png" | "jpg" | "webp" | "ico" | "svg" };

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** `<svg` as the first element (after an optional XML prolog, comments and DOCTYPE). */
const SVG_START = /^\s*(?:<\?xml[^>]*\?>\s*)?(?:<!--[\s\S]*?-->\s*)*(?:<!DOCTYPE[^>]*>\s*)?<svg[\s>]/i;

/**
 * Active or external content an SVG logo must not contain:
 * script / foreignObject / iframe / embed / object elements, inline event
 * handlers, javascript: URLs, DTD entities and CSS imports.
 */
const SVG_UNSAFE = [
  /<\s*(?:script|foreignObject|iframe|embed|object|animate|set|handler)\b/i,
  /\son[a-z]+\s*=/i,
  /javascript\s*:/i,
  /<!ENTITY/i,
  /@import/i,
];

/** Every href / xlink:href attribute value and every CSS url(...) argument. */
const SVG_REFS = [
  /\b(?:xlink:)?href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi,
  /\burl\s*\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*))\)/gi,
];

/** A reference is only acceptable when it points inside the document (`#id`). */
function hasExternalReference(text: string): boolean {
  for (const re of SVG_REFS) {
    re.lastIndex = 0;
    for (let m = re.exec(text); m; m = re.exec(text)) {
      const value = (m[1] ?? m[2] ?? m[3] ?? "").trim();
      if (!value.startsWith("#")) return true;
    }
  }
  return false;
}

export function isSafeSvg(text: string): boolean {
  if (!SVG_START.test(text)) return false;
  if (SVG_UNSAFE.some((re) => re.test(text))) return false;
  return !hasExternalReference(text);
}

/** Identify a PNG / JPEG / WebP / ICO by magic bytes, or a safe SVG by content. Null when unrecognised or unsafe. */
export function sniffImage(buf: Buffer, declaredType?: string | null): SniffedImage | null {
  if (buf.length >= 8 && buf.subarray(0, 8).equals(PNG)) return { mime: "image/png", ext: "png" };
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { mime: "image/jpeg", ext: "jpg" };
  if (buf.length >= 12 && buf.subarray(0, 4).toString("ascii") === "RIFF" && buf.subarray(8, 12).toString("ascii") === "WEBP") {
    return { mime: "image/webp", ext: "webp" };
  }
  if (buf.length >= 6 && buf[0] === 0 && buf[1] === 0 && buf[2] === 1 && buf[3] === 0) return { mime: "image/x-icon", ext: "ico" };
  // SVG only when the uploader said so; a text file that merely starts with "<svg" is otherwise rejected.
  if (declaredType === "image/svg+xml" && isSafeSvg(buf.toString("utf8"))) return { mime: "image/svg+xml", ext: "svg" };
  return null;
}
