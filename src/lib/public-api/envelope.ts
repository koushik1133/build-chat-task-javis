/**
 * Response envelope for /api/v1 (client-safe, no DB).
 *
 *   success:  { data, meta: { next_cursor } }
 *   error:    { error: { code, message, details? } }
 */

export interface Meta {
  next_cursor?: string | null;
  [k: string]: unknown;
}

export interface Envelope<T> {
  data: T;
  meta: Meta;
}

export type ErrorCode =
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "validation_failed"
  | "bad_request"
  | "conflict"
  | "rate_limited"
  | "idempotency_mismatch"
  | "idempotency_in_progress"
  | "unprocessable"
  | "internal";

export interface ErrorBody {
  error: { code: ErrorCode; message: string; details?: unknown };
}

const JSON_HEADERS = { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" } as const;

/** Thrown inside handlers to produce a well-formed error response. */
export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: ErrorCode,
    message: string,
    public readonly details?: unknown,
    public readonly headers: Record<string, string> = {}
  ) {
    super(message);
    this.name = "ApiError";
  }

  static notFound(what = "Resource"): ApiError {
    return new ApiError(404, "not_found", `${what} not found`);
  }
  static badRequest(message: string, details?: unknown): ApiError {
    return new ApiError(400, "bad_request", message, details);
  }
  static validation(details: unknown, message = "Validation failed"): ApiError {
    return new ApiError(422, "validation_failed", message, details);
  }
  static unauthorized(message = "Missing or invalid API key"): ApiError {
    return new ApiError(401, "unauthorized", message, undefined, { "WWW-Authenticate": 'Bearer realm="api"' });
  }
  static forbidden(message: string): ApiError {
    return new ApiError(403, "forbidden", message);
  }
  static conflict(message: string): ApiError {
    return new ApiError(409, "conflict", message);
  }
}

export function ok<T>(data: T, meta: Meta = {}, init: { status?: number; headers?: Record<string, string> } = {}): Response {
  const body: Envelope<T> = { data, meta };
  return new Response(JSON.stringify(body), { status: init.status ?? 200, headers: { ...JSON_HEADERS, ...init.headers } });
}

export function fail(status: number, code: ErrorCode, message: string, details?: unknown, headers: Record<string, string> = {}): Response {
  const body: ErrorBody = { error: details === undefined ? { code, message } : { code, message, details } };
  return new Response(JSON.stringify(body), { status, headers: { ...JSON_HEADERS, ...headers } });
}

/**
 * Translate a thrown value into a response. Domain libs throw plain Errors with
 * human messages ("Quote not found", "Only draft quotes can be deleted"); map the
 * common shapes so callers get a sensible status instead of a 500.
 */
export function errorToResponse(err: unknown, extraHeaders: Record<string, string> = {}): Response {
  if (err instanceof ApiError) return fail(err.status, err.code, err.message, err.details, { ...extraHeaders, ...err.headers });
  if (err && typeof err === "object" && "issues" in err && Array.isArray((err as { issues: unknown }).issues)) {
    const issues = (err as { issues: Array<{ path: Array<string | number>; message: string }> }).issues;
    return fail(422, "validation_failed", "Validation failed", issues.map((i) => ({ path: i.path.join("."), message: i.message })), extraHeaders);
  }
  if (err instanceof Error) {
    const name = err.name;
    const msg = err.message;
    if (name === "RecordValidationError" || name === "BookingValidationError") return fail(422, "validation_failed", msg, (err as { errors?: unknown }).errors, extraHeaders);
    if (name === "BookingConflictError") return fail(409, "conflict", msg, undefined, extraHeaders);
    if (name === "InsufficientStockError") return fail(409, "conflict", msg, undefined, extraHeaders);
    if (/not found/i.test(msg)) return fail(404, "not_found", msg, undefined, extraHeaders);
    if (/already|cannot|must|required|invalid|unknown|at least|no recipient|mismatch|in use/i.test(msg)) {
      return fail(422, "unprocessable", msg, undefined, extraHeaders);
    }
  }
  console.error("[api/v1] unhandled:", err);
  return fail(500, "internal", "Internal server error", undefined, extraHeaders);
}
