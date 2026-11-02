/** URL-safe slug for knowledge-base articles and categories. Pure. */
export function slugify(input: string, maxLength = 80): string {
  const s = input
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "") // strip diacritics
    .toLowerCase()
    .replace(/['’"]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const trimmed = s.slice(0, maxLength).replace(/-+$/g, "");
  return trimmed || "article";
}

export function isValidSlug(s: string): boolean {
  return /^[a-z0-9](?:[a-z0-9-]{0,118}[a-z0-9])?$/.test(s);
}

/** Append -2, -3 … until `taken` says the slug is free. */
export function uniqueSlug(base: string, taken: (candidate: string) => boolean): string {
  if (!taken(base)) return base;
  for (let i = 2; i < 10_000; i++) {
    const candidate = `${base.slice(0, 80 - String(i).length - 1)}-${i}`;
    if (!taken(candidate)) return candidate;
  }
  return `${base}-${Date.now().toString(36)}`;
}

/** First ~200 chars of plain text from markdown, for excerpts. */
export function excerptFromMarkdown(md: string, max = 200): string {
  const text = md
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`[^`]*`/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/[*_>~]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(" "), max - 20))}…`;
}
