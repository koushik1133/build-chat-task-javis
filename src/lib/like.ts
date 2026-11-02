/**
 * Helpers for building LIKE / ILIKE patterns from user text.
 *
 * Parameterising the pattern stops SQL injection, but `%`, `_` and `\` are
 * still pattern metacharacters: an unescaped needle lets a caller turn a
 * "contains" search into "match everything" (or into an expensive scan).
 * Postgres treats `\` as the escape character by default, so no ESCAPE
 * clause is required when these helpers are used.
 */

/** Escape `%`, `_` and `\` so `s` is matched literally inside a pattern. */
export function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/** `%needle%` with the needle escaped. */
export function likeContains(needle: string): string {
  return `%${escapeLike(needle)}%`;
}
