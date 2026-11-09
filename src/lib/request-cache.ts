import * as React from "react";

/**
 * Per-request memoisation for server-side lookups.
 *
 * `React.cache()` dedupes calls with identical arguments for the lifetime of
 * one server render / route-handler invocation and is a no-op across
 * requests, so wrapping a DB read in it can never leak data between tenants.
 * The React build pinned in package.json (18.x) does not export `cache`; the
 * React that Next bundles for the App Router does. `requestMemo` therefore
 * uses `React.cache` when present and otherwise falls back to the plain
 * function, so unit tests and non-React callers behave identically.
 *
 * Only wrap reads that are safe to serve twice within one request (settings,
 * branding, nav, membership lookups). Never wrap writes or reads whose result
 * must reflect a write performed later in the same request.
 */
type AnyFn = (...args: never[]) => unknown;

type CacheImpl = <F extends AnyFn>(fn: F) => F;

const reactCache: CacheImpl | null = (() => {
  const c = (React as unknown as { cache?: unknown }).cache;
  return typeof c === "function" ? (c as CacheImpl) : null;
})();

export function requestMemo<F extends AnyFn>(fn: F, impl: CacheImpl | null = reactCache): F {
  return impl ? impl(fn) : fn;
}

/** True when the runtime React exposes `cache` (i.e. per-request dedupe is active). */
export const REQUEST_MEMO_ACTIVE = reactCache !== null;

/**
 * Minimal `cache()` stand-in keyed by JSON-serialised arguments. Used by unit
 * tests to prove a wrapped loader hits the database once per key, and by
 * nothing in production (React's own implementation is request-scoped).
 */
export function mapCacheImpl(): CacheImpl {
  const store = new Map<string, unknown>();
  return <F extends AnyFn>(fn: F): F =>
    ((...args: never[]) => {
      const key = JSON.stringify(args);
      if (store.has(key)) return store.get(key);
      const v = fn(...args);
      store.set(key, v);
      return v;
    }) as F;
}
