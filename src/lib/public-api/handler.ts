import type { z, ZodTypeAny } from "zod";
import { requireApiKey, rateLimitHeaders, type ApiPrincipal } from "./auth";
import { ApiError, errorToResponse, ok, type Meta } from "./envelope";
import { IDEMPOTENCY_HEADER, isValidIdempotencyKey, requestHash, withIdempotency } from "./idempotency";
import { parseListParams, type ListParams } from "./pagination";
import type { RouteDef } from "./registry";

/**
 * Builds a Next.js route handler from a registry entry.
 *
 *   export const GET = op(ROUTES.listContacts, async ({ principal, query, list }) => { … });
 *
 * The wrapper authenticates (API key + scope + rate limit), validates params /
 * query / body with the registry's zod schemas, applies `Idempotency-Key` on
 * POST, wraps the result in the standard envelope and maps thrown errors.
 */

const MAX_BODY_BYTES = 1_000_000;

type Infer<T> = T extends ZodTypeAny ? z.infer<T> : Record<string, never>;

export interface OpContext<Q, P, B> {
  req: Request;
  url: URL;
  /** Null only for public routes (`scope: null`). */
  principal: ApiPrincipal;
  query: Q;
  params: P;
  body: B;
  /** limit / cursor / q parsed from the URL (cursor already decoded). */
  list: ListParams;
}

export interface OpResult<T = unknown> {
  data: T;
  meta?: Meta;
  status?: number;
  headers?: Record<string, string>;
}

type RouteContext = { params: Promise<Record<string, string | string[] | undefined>> };

export function op<Q extends ZodTypeAny, P extends ZodTypeAny, B extends ZodTypeAny>(
  def: RouteDef<Q, P, B>,
  impl: (ctx: OpContext<Infer<Q>, Infer<P>, Infer<B>>) => Promise<OpResult>
): (req: Request, context: RouteContext) => Promise<Response> {
  return async function handler(req: Request, context: RouteContext): Promise<Response> {
    let rlHeaders: Record<string, string> = {};
    try {
      const url = new URL(req.url);
      const principal = def.scope === null ? PUBLIC_PRINCIPAL : await requireApiKey(req, def.scope);
      if (def.scope !== null) rlHeaders = rateLimitHeaders(principal.rate);

      const rawParams = (await context?.params) ?? {};
      const params = def.params ? parseOrThrow(def.params, rawParams, "params") : ({} as Infer<P>);

      const rawQuery: Record<string, string> = {};
      url.searchParams.forEach((v, k) => {
        if (!(k in rawQuery)) rawQuery[k] = v;
      });
      const query = def.query ? parseOrThrow(def.query, rawQuery, "query") : ({} as Infer<Q>);

      const list = parseListParams(url);
      if (list.badCursor) throw ApiError.badRequest("Invalid cursor");

      let rawBody = "";
      let body = {} as Infer<B>;
      if (def.body) {
        rawBody = await readBody(req);
        let json: unknown = {};
        if (rawBody.trim()) {
          try {
            json = JSON.parse(rawBody);
          } catch {
            throw ApiError.badRequest("Body must be valid JSON");
          }
        }
        body = parseOrThrow(def.body, json, "body");
      }

      const ctx: OpContext<Infer<Q>, Infer<P>, Infer<B>> = { req, url, principal, query, params, body, list };

      const run = async () => {
        const r = await impl(ctx);
        return r;
      };

      const idemKey = req.method === "POST" && def.scope !== null ? req.headers.get(IDEMPOTENCY_HEADER) : null;
      if (idemKey !== null) {
        if (!isValidIdempotencyKey(idemKey)) throw ApiError.badRequest("Idempotency-Key must be 1–255 characters without whitespace");
        const hash = requestHash(req.method, url.pathname, rawBody);
        const stored = await withIdempotency(principal.userId, idemKey, hash, async () => {
          const r = await run();
          return { status: r.status ?? def.status ?? 200, body: { data: r.data, meta: r.meta ?? {} } };
        });
        const envelope = stored.body as { data: unknown; meta: Meta };
        return ok(envelope.data, envelope.meta, {
          status: stored.status,
          headers: { ...rlHeaders, "Idempotent-Replay": stored.replayed ? "true" : "false" },
        });
      }

      const result = await run();
      return ok(result.data, result.meta ?? {}, { status: result.status ?? def.status ?? 200, headers: { ...rlHeaders, ...result.headers } });
    } catch (err) {
      return errorToResponse(err, rlHeaders);
    }
  };
}

const PUBLIC_PRINCIPAL: ApiPrincipal = { userId: "", dataId: "", keyId: "", scopes: [], rate: { limit: 0, remaining: 0, resetAt: 0 } };

function parseOrThrow<T extends ZodTypeAny>(schema: T, value: unknown, where: "params" | "query" | "body"): z.infer<T> {
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  throw ApiError.validation(
    parsed.error.issues.map((i) => ({ in: where, path: i.path.join("."), message: i.message })),
    `Invalid ${where}`
  );
}

async function readBody(req: Request): Promise<string> {
  const declared = Number(req.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) throw new ApiError(413, "bad_request", "Request body too large");
  const text = await req.text();
  if (Buffer.byteLength(text, "utf8") > MAX_BODY_BYTES) throw new ApiError(413, "bad_request", "Request body too large");
  return text;
}

/** Shared helper: 404 unless the row exists. */
export function mustFind<T>(row: T | null | undefined, what: string): T {
  if (row === null || row === undefined) throw ApiError.notFound(what);
  return row;
}
