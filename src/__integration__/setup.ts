/**
 * Integration-test harness: runs the real Next.js route handlers against the
 * local Postgres (src/lib/dsql.ts with DSQL_ENDPOINT=127.0.0.1).
 *
 * Gate: every suite is wrapped in `describeDb(...)`, which is
 * `describe.skipIf(process.env.DB_INTEGRATION !== "1")`, so the default
 * `vitest run` stays hermetic. Run with `npm run test:integration` or
 * `DB_INTEGRATION=1 npx vitest run src/__integration__`.
 *
 * Auth: test files mock `@/lib/auth/scope` and `@/lib/supabase/server` via
 * `scopeMockFactory` / `supabaseMockFactory` below. The synthetic scope is
 * controlled per test with `setScope()`; `emitEvent` stays real so the
 * `events` table can be asserted.
 */
import { existsSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { describe, expect } from "vitest";
import { NextRequest } from "next/server";
import type { QueryResultRow } from "pg";
import type { Area, AreaPermission, Role } from "@/lib/auth/roles";
import { DEFAULT_MATRIX } from "@/lib/auth/roles";

// ─── env ─────────────────────────────────────────────────────────────────────

export const INTEGRATION = process.env.DB_INTEGRATION === "1";

function loadEnvLocal(): void {
  const file = join(process.cwd(), ".env.local");
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq === -1) continue;
    const key = t.slice(0, eq).trim();
    let val = t.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
    if (!process.env[key]) process.env[key] = val;
  }
}

if (INTEGRATION) {
  loadEnvLocal();
  // Never let the integration suite reach a remote cluster.
  const ep = process.env.DSQL_ENDPOINT;
  if (ep !== "localhost" && ep !== "127.0.0.1") process.env.DSQL_ENDPOINT = "127.0.0.1";
  process.env.DB_USER = process.env.DB_USER || "postgres";
  process.env.DB_NAME = process.env.DB_NAME || "postgres";
  process.env.CRON_SECRET = process.env.CRON_SECRET || "integration-cron-secret";
  process.env.NEXT_PUBLIC_APP_URL = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3001";
  process.env.WEBHOOKS_ALLOW_INSECURE = "1";
  delete process.env.PAYMENTS_PROVIDER;
}

/** `describe` that is skipped unless DB_INTEGRATION=1. */
export const describeDb = describe.skipIf(!INTEGRATION);

// ─── db access (lazy so hermetic runs never import pg) ───────────────────────

type Db = typeof import("@/lib/dsql");
let dbMod: Db | null = null;
export async function db(): Promise<Db> {
  if (!dbMod) dbMod = await import("@/lib/dsql");
  return dbMod;
}
export async function sql<T extends QueryResultRow = QueryResultRow>(text: string, params: unknown[] = []): Promise<T[]> {
  const { query } = await db();
  return query<T>(text, params);
}
export async function sqlOne<T extends QueryResultRow = QueryResultRow>(text: string, params: unknown[] = []): Promise<T | null> {
  const { queryOne } = await db();
  return queryOne<T>(text, params);
}
export async function tableExists(name: string): Promise<boolean> {
  const r = await sqlOne<{ n: string }>(`SELECT table_name AS n FROM information_schema.tables WHERE table_schema = 'public' AND table_name = $1`, [name]);
  return Boolean(r);
}

// ─── test org lifecycle ───────────────────────────────────────────────────────

export interface TestOrg {
  /** org owner id == dataId (all module tables key on this). */
  dataId: string;
  orgId: string;
  userId: string;
  email: string;
  slug: string;
  name: string;
}

export function newTestId(prefix = "itest"): string {
  return `${prefix}-${randomUUID()}`;
}

/** Create an organization + owner membership keyed by a fresh synthetic user id. */
export async function createTestOrg(label = "it"): Promise<TestOrg> {
  const userId = newTestId("itest-user");
  const orgId = newTestId("itest-org");
  const slug = `it-${randomUUID().slice(0, 8)}`;
  const name = `Integration ${label} ${slug}`;
  const email = `${slug}@example.test`;
  await sql(`INSERT INTO organizations (id, name, slug, owner_user_id, settings) VALUES ($1, $2, $3, $4, NULL)`, [orgId, name, slug, userId]);
  await sql(
    `INSERT INTO memberships (id, org_id, user_id, role, status, accepted_at) VALUES ($1, $2, $3, 'owner', 'active', NOW())`,
    [randomUUID(), orgId, userId]
  );
  return { dataId: userId, orgId, userId, email, slug, name };
}

/**
 * Remove every row that belongs to the given data ids. Tables are discovered
 * at runtime through information_schema (any table with a `user_id` column),
 * then child tables without `user_id` are cleaned through their parent.
 */
export async function cleanupDataIds(dataIds: string[]): Promise<void> {
  if (dataIds.length === 0) return;
  const tables = await sql<{ t: string }>(
    `SELECT table_name AS t FROM information_schema.columns WHERE table_schema = 'public' AND column_name = 'user_id'`
  );
  // Child tables keyed through a parent.
  const children: Array<[string, string]> = [
    ["quote_versions", "quote_id IN (SELECT id FROM quotes WHERE user_id = ANY($1))"],
    ["quote_acceptances", "quote_id IN (SELECT id FROM quotes WHERE user_id = ANY($1))"],
    ["invoice_payments", "invoice_id IN (SELECT id FROM invoices WHERE user_id = ANY($1))"],
    ["role_area_overrides", "org_id IN (SELECT id FROM organizations WHERE owner_user_id = ANY($1))"],
    ["availability_rules", "calendar_id IN (SELECT id FROM calendars WHERE user_id = ANY($1))"],
    ["calendar_blocks", "calendar_id IN (SELECT id FROM calendars WHERE user_id = ANY($1))"],
  ];
  for (const [t, where] of children) {
    if (!(await tableExists(t))) continue;
    await sql(`DELETE FROM ${t} WHERE ${where}`, [dataIds]).catch(() => undefined);
  }
  for (const { t } of tables) {
    await sql(`DELETE FROM ${t} WHERE user_id = ANY($1)`, [dataIds]).catch((err: unknown) => {
      console.warn(`[integration cleanup] ${t}:`, err instanceof Error ? err.message : err);
    });
  }
  // Orgs (incl. agency child orgs whose id doubles as their data key) and their memberships.
  await sql(`DELETE FROM memberships WHERE org_id IN (SELECT id FROM organizations WHERE owner_user_id = ANY($1) OR id = ANY($1))`, [dataIds]).catch(() => undefined);
  await sql(`DELETE FROM organizations WHERE owner_user_id = ANY($1) OR id = ANY($1)`, [dataIds]).catch(() => undefined);
}

// ─── scope mock ───────────────────────────────────────────────────────────────

export interface ScopeState {
  dataId: string | null;
  userId: string;
  email: string | null;
  orgId: string;
  orgName: string;
  orgSlug: string;
  role: Role;
  /** Optional override; defaults to DEFAULT_MATRIX[role]. */
  can?: (area: Area, edit?: boolean) => boolean;
}

export const scopeState: ScopeState = {
  dataId: null,
  userId: "itest-nobody",
  email: null,
  orgId: "itest-no-org",
  orgName: "No org",
  orgSlug: "no-org",
  role: "owner",
};

/** Point the mocked requireScope() at a test org, optionally as a non-owner role/actor. */
export function setScope(org: TestOrg | null, opts: { role?: Role; userId?: string; email?: string; can?: ScopeState["can"] } = {}): void {
  scopeState.dataId = org?.dataId ?? null;
  scopeState.orgId = org?.orgId ?? "itest-no-org";
  scopeState.orgName = org?.name ?? "No org";
  scopeState.orgSlug = org?.slug ?? "no-org";
  scopeState.userId = opts.userId ?? org?.userId ?? "itest-nobody";
  scopeState.email = opts.email ?? org?.email ?? null;
  scopeState.role = opts.role ?? "owner";
  scopeState.can = opts.can;
}

type ScopeModule = typeof import("@/lib/auth/scope");

/**
 * vi.mock factory for "@/lib/auth/scope". Usage in a test file:
 *   vi.mock("@/lib/auth/scope", () => import("./setup").then((m) => m.scopeMockFactory()));
 */
export async function scopeMockFactory(): Promise<ScopeModule> {
  const { vi } = await import("vitest");
  const actual = await vi.importActual<ScopeModule>("@/lib/auth/scope");
  const requireScope: ScopeModule["requireScope"] = async (opts = {}) => {
    const s = scopeState;
    if (!s.dataId) throw new actual.ScopeError("UNAUTHORIZED");
    const matrix: Record<Area, AreaPermission> = { ...DEFAULT_MATRIX[s.role] };
    const can = s.can ?? ((area: Area, edit = false) => {
      const p = matrix[area];
      return Boolean(p && p.view && (!edit || p.edit));
    });
    if (opts.area && !can(opts.area, opts.edit)) {
      throw new actual.ScopeError("FORBIDDEN", `Your role (${s.role}) cannot ${opts.edit ? "edit" : "view"} ${opts.area}.`);
    }
    return {
      userId: s.userId,
      email: s.email,
      orgId: s.orgId,
      orgName: s.orgName,
      orgSlug: s.orgSlug,
      dataId: s.dataId,
      role: s.role,
      isOwner: s.role === "owner",
      can,
      permissions: matrix,
    };
  };
  return { ...actual, requireScope };
}

type SupabaseServerModule = typeof import("@/lib/supabase/server");

/** vi.mock factory for "@/lib/supabase/server": requireUser() returns the current scope actor. */
export async function supabaseMockFactory(): Promise<SupabaseServerModule> {
  const requireUser = (async () => {
    if (!scopeState.dataId) throw new Error("UNAUTHORIZED");
    return {
      user: { id: scopeState.userId, email: scopeState.email ?? undefined },
      get supabase() {
        throw new Error("admin client not available in integration tests");
      },
    };
  }) as unknown as SupabaseServerModule["requireUser"];
  const getServerSession = (async () => {
    if (!scopeState.dataId) return null;
    return { user: { id: scopeState.userId, email: scopeState.email ?? undefined } };
  }) as unknown as SupabaseServerModule["getServerSession"];
  const createClient = (async () => {
    throw new Error("supabase client not available in integration tests");
  }) as unknown as SupabaseServerModule["createClient"];
  const createAdminClient = (() => {
    throw new Error("supabase admin client not available in integration tests");
  }) as unknown as SupabaseServerModule["createAdminClient"];
  return { requireUser, getServerSession, createClient, createAdminClient };
}

// ─── request helpers ──────────────────────────────────────────────────────────

export const BASE = "http://localhost:3001";

export interface ReqInit {
  method?: string;
  json?: unknown;
  text?: string;
  headers?: Record<string, string>;
  query?: Record<string, string | number | boolean | undefined>;
}

/** Build a NextRequest for a route handler. */
export function req(path: string, init: ReqInit = {}): NextRequest {
  const url = new URL(path, BASE);
  for (const [k, v] of Object.entries(init.query ?? {})) if (v !== undefined) url.searchParams.set(k, String(v));
  const headers = new Headers(init.headers ?? {});
  let body: string | undefined;
  if (init.json !== undefined) {
    body = JSON.stringify(init.json);
    if (!headers.has("content-type")) headers.set("content-type", "application/json");
  } else if (init.text !== undefined) {
    body = init.text;
  }
  const method = init.method ?? (body !== undefined ? "POST" : "GET");
  return new NextRequest(url, { method, headers, body });
}

/** Next 15 route context. */
export function ctx<T extends Record<string, string>>(params: T): { params: Promise<T> } {
  return { params: Promise.resolve(params) };
}

/**
 * Any Next.js route handler. `ctx: never` makes every concrete handler
 * signature assignable (GET(), GET(req), GET(req, ctx) with typed params);
 * `call()` supplies the real `{ params }` object.
 */
export type Handler = (req: NextRequest, ctx: never) => Promise<Response | undefined> | Response | undefined;

/**
 * Call a handler and parse the response. On an unexpected status the body is
 * included in the assertion message so failures are diagnosable.
 */
export async function call<T = unknown>(
  handler: Handler,
  request: NextRequest,
  params: Record<string, string> = {},
  expectStatus?: number | number[]
): Promise<{ status: number; body: T; res: Response; text: string }> {
  const res = await (handler as unknown as (req: NextRequest, ctx: { params: Promise<Record<string, string>> }) => Promise<Response | undefined> | Response | undefined)(request, ctx(params));
  if (!res) expect.fail(`${request.method} ${new URL(request.url).pathname} returned no Response`);
  const text = await res.clone().text();
  let body: T;
  try {
    body = JSON.parse(text) as T;
  } catch {
    body = text as unknown as T;
  }
  if (expectStatus !== undefined) {
    const wanted = Array.isArray(expectStatus) ? expectStatus : [expectStatus];
    if (!wanted.includes(res.status)) {
      expect.fail(`${request.method} ${new URL(request.url).pathname} → ${res.status} (wanted ${wanted.join("/")}): ${text.slice(0, 2000)}`);
    }
  }
  return { status: res.status, body, res, text };
}

/** Shorthand: JSON call with expected status. */
export async function api<T = Record<string, unknown>>(
  handler: Handler,
  path: string,
  init: ReqInit & { params?: Record<string, string>; expect?: number | number[] } = {}
): Promise<{ status: number; body: T; res: Response }> {
  const { params, expect: wanted, ...rest } = init;
  const out = await call<T>(handler, req(path, rest), params ?? {}, wanted);
  return { status: out.status, body: out.body, res: out.res };
}

// ─── event assertions ─────────────────────────────────────────────────────────

export interface EventRow {
  id: string;
  user_id: string;
  type: string;
  entity: string;
  entity_id: string;
  data: string | null;
  created_at: string;
}

export async function eventsFor(dataId: string, type?: string, entityId?: string): Promise<EventRow[]> {
  const params: unknown[] = [dataId];
  let where = `user_id = $1`;
  if (type) {
    params.push(type);
    where += ` AND type = $${params.length}`;
  }
  if (entityId) {
    params.push(entityId);
    where += ` AND entity_id = $${params.length}`;
  }
  return sql<EventRow>(`SELECT * FROM events WHERE ${where} ORDER BY created_at ASC`, params);
}

/** `emitEvent` is fire-and-forget in some paths (`void emitEvent(...)`); poll briefly. */
export async function expectEvent(dataId: string, type: string, entityId?: string, timeoutMs = 3000): Promise<EventRow> {
  const start = Date.now();
  for (;;) {
    const rows = await eventsFor(dataId, type, entityId);
    if (rows.length > 0) return rows[0];
    if (Date.now() - start > timeoutMs) {
      const all = await eventsFor(dataId);
      expect.fail(`event ${type}${entityId ? ` for ${entityId}` : ""} not found; present: ${all.map((e) => `${e.type}:${e.entity_id}`).join(", ") || "(none)"}`);
    }
    await new Promise((r) => setTimeout(r, 50));
  }
}

/**
 * Poll a query until it returns at least `min` rows (audit writes and some
 * event emits are fire-and-forget, so they can land a few ms after the response).
 */
export async function waitForRows<T extends QueryResultRow = QueryResultRow>(text: string, params: unknown[] = [], min = 1, timeoutMs = 3000): Promise<T[]> {
  const start = Date.now();
  for (;;) {
    const rows = await sql<T>(text, params);
    if (rows.length >= min) return rows;
    if (Date.now() - start > timeoutMs) expect.fail(`expected ≥${min} rows for: ${text.replace(/\s+/g, " ").slice(0, 160)} (got ${rows.length})`);
    await sleep(40);
  }
}

export function parseJson<T = Record<string, unknown>>(raw: string | null | undefined): T | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export async function sleep(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}
