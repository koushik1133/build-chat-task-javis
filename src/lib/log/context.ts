import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";

/**
 * Per-request context (request id, route, hashed org) carried through async
 * calls with AsyncLocalStorage so log lines and metrics can be correlated
 * without threading arguments. Node runtime only (route handlers).
 */

export interface RequestContext {
  reqId: string;
  route: string;
  /** Hashed org/data id (never the raw id). */
  org: string | null;
  startedAt: number;
}

const storage = new AsyncLocalStorage<RequestContext>();

export const REQUEST_ID_HEADER = "x-request-id";
const VALID_ID = /^[A-Za-z0-9._-]{8,64}$/;

/** Accept a caller-supplied id only when it is short and boring; otherwise mint one. */
export function normaliseRequestId(raw: string | null | undefined): string {
  const v = (raw ?? "").trim();
  return VALID_ID.test(v) ? v : randomUUID();
}

export function hashOrg(id: string | null | undefined): string | null {
  if (!id) return null;
  return createHash("sha256").update(id, "utf8").digest("hex").slice(0, 12);
}

export function getRequestContext(): RequestContext | undefined {
  return storage.getStore();
}

export function setRequestOrg(dataId: string | null | undefined): void {
  const ctx = storage.getStore();
  if (ctx) ctx.org = hashOrg(dataId);
}

export function runWithContext<T>(ctx: Omit<RequestContext, "startedAt"> & { startedAt?: number }, fn: () => T): T {
  return storage.run({ ...ctx, startedAt: ctx.startedAt ?? Date.now() }, fn);
}

/** Pure: group a path into a low-cardinality label for metrics. */
export function routeGroup(path: string): string {
  const p = path.split("?")[0] ?? "";
  if (p.startsWith("/api/v1/")) return "api_v1";
  if (p.startsWith("/api/cron/")) return "cron";
  if (p.startsWith("/api/webhooks/") || p.startsWith("/api/payments/webhook")) return "webhook";
  if (p.startsWith("/api/shop")) return "shop";
  if (p.startsWith("/api/widget")) return "widget";
  if (p.startsWith("/api/p/")) return "portal";
  if (p.startsWith("/api/")) return "api";
  return "page";
}

type RouteHandler<R extends Request, A extends unknown[]> = (req: R, ...rest: A) => Promise<Response> | Response;

/**
 * Wrap a route handler: establishes the request context (id from the
 * middleware's `x-request-id` header), echoes the id on the response, records
 * request count/latency metrics and logs 5xx / thrown errors. Never changes
 * the handler's behaviour (errors are re-thrown).
 */
export function withRequestContext<R extends Request, A extends unknown[]>(handler: RouteHandler<R, A>, opts: { route?: string } = {}): (req: R, ...rest: A) => Promise<Response> {
  return async (req: R, ...rest: A): Promise<Response> => {
    const url = new URL(req.url);
    const reqId = normaliseRequestId(req.headers.get(REQUEST_ID_HEADER));
    const route = opts.route ?? url.pathname;
    const group = routeGroup(route);
    return runWithContext({ reqId, route, org: null }, async () => {
      const started = Date.now();
      let status = 500;
      try {
        const res = await handler(req, ...rest);
        status = res.status;
        try { res.headers.set(REQUEST_ID_HEADER, reqId); } catch { /* immutable headers (redirect/fetch response) */ }
        return res;
      } catch (err) {
        const { logger } = await import("./logger");
        logger.error("unhandled route error", { err, ms: Date.now() - started });
        throw err;
      } finally {
        const ms = Date.now() - started;
        const { recordRequest } = await import("@/lib/metrics/registry");
        recordRequest(group, status, ms);
        if (status >= 500) {
          const { logger } = await import("./logger");
          logger.warn("request failed", { status, ms });
        }
      }
    });
  };
}
