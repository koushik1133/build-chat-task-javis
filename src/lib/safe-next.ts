/**
 * True for a same-origin app path that is safe to redirect to.
 * Rejects protocol-relative `//host`, backslashes and control characters
 * (browsers normalise `/\host` and `/<tab>/host` to `//host`).
 */
export function isSafeRelativePath(path: unknown): path is string {
  if (typeof path !== "string" || path.length === 0 || path.length > 2000) return false;
  if (!path.startsWith("/") || path.startsWith("//")) return false;
  return !/[\\\u0000-\u001f\u007f]/.test(path);
}
