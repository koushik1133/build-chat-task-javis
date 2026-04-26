// Word-window chunker with overlap. Good enough for code + prose; we don't
// need tiktoken precision because the embed model has its own tokenizer.

export function chunkText(text: string, size = 400, overlap = 50): string[] {
  const clean = text.replace(/\r/g, "").trim();
  if (!clean) return [];
  const words = clean.split(/\s+/);
  if (words.length <= size) return [clean];

  const step = Math.max(1, size - overlap);
  const out: string[] = [];
  for (let i = 0; i < words.length; i += step) {
    out.push(words.slice(i, i + size).join(" "));
    if (i + size >= words.length) break;
  }
  return out;
}

export async function extractText(file: File): Promise<string> {
  const name = file.name.toLowerCase();
  if (name.endsWith(".pdf")) {
    const buf = Buffer.from(await file.arrayBuffer());
    // Lazy import — pdf-parse touches fs at import-time on some setups.
    const pdfParse = (await import("pdf-parse")).default;
    const parsed = await pdfParse(buf);
    return parsed.text;
  }
  // Treat everything else as text (covers .md, .txt, source code).
  return await file.text();
}
