/**
 * Parse JSON that a model produced.
 *
 * Models drift: they wrap output in ``` fences, add prose around it, or emit
 * something that isn't JSON at all. Returns null instead of throwing so callers
 * can answer with a clear error rather than a 500.
 */
export function parseModelJson<T = unknown>(raw: string | null | undefined): T | null {
  if (!raw) return null;

  const cleaned = raw.replace(/```json/gi, "").replace(/```/g, "").trim();
  if (!cleaned) return null;

  try {
    return JSON.parse(cleaned) as T;
  } catch {
    // Fall back to the outermost {...} or [...] block, which handles the
    // common case of the model adding a sentence before or after the JSON.
    const start = cleaned.search(/[{[]/);
    const end = Math.max(cleaned.lastIndexOf("}"), cleaned.lastIndexOf("]"));
    if (start === -1 || end <= start) return null;
    try {
      return JSON.parse(cleaned.slice(start, end + 1)) as T;
    } catch {
      return null;
    }
  }
}
