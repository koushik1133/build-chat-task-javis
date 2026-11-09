import { randomUUID } from "crypto";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { query, queryOne } from "@/lib/dsql";
import { requestMemo } from "@/lib/request-cache";
import { requireUser } from "@/lib/supabase/server";
import { AREAS, DEFAULT_MATRIX, isRole, type Area, type AreaPermission, type Role } from "@/lib/auth/roles";

/**
 * Org-aware authorization for API routes and server components.
 *
 * Scoping model (Phase 2): each organization has an `owner_user_id`. All
 * module tables stay keyed by `user_id`; an org's data is the rows where
 * `user_id = owner_user_id`. `requireScope()` therefore returns `dataId`,
 * which routes MUST use in place of `user.id` for every data query, plus the
 * caller's role and a `can()` check.
 *
 * Usage:
 *   const scope = await requireScope({ area: "crm", edit: true });
 *   await query("SELECT … WHERE user_id = $1", [scope.dataId]);
 *
 * Errors are thrown as ScopeError; convert with `scopeErrorResponse(err)`.
 *
 * Agency mode (Phase 4, src/lib/agency/orgs.ts): a client workspace is an
 * org whose `owner_user_id` is a SYNTHETIC data id (the child org's own id),
 * not a Supabase user. It is reachable only through an active membership, so
 * the membership join below resolves it like any other org and `dataId`
 * becomes that synthetic id. `ensurePersonalOrg()` looks up
 * `owner_user_id = <auth user id>`, which can never equal a child org id, so
 * it neither adopts nor duplicates a client workspace. Archiving a client
 * suspends its memberships, which drops it out of this resolver and the switcher.
 */

export const ORG_COOKIE = "kh_org";

export class ScopeError extends Error {
  /** For code "UNAVAILABLE": the underlying infrastructure error (database down, schema not migrated). */
  public readonly underlying?: Error;
  constructor(public readonly code: "UNAUTHORIZED" | "FORBIDDEN" | "NO_ORG" | "UNAVAILABLE", message?: string, underlying?: Error) {
    super(message ?? code);
    this.name = "ScopeError";
    this.underlying = underlying;
  }
}

export interface OrgRow {
  id: string;
  name: string;
  slug: string;
  owner_user_id: string;
  settings: string | null;
}

export interface Scope {
  /** Authenticated Supabase user id (the actor). */
  userId: string;
  email: string | null;
  orgId: string;
  orgName: string;
  orgSlug: string;
  /** The user_id key under which this org's data lives. Use this for ALL data queries. */
  dataId: string;
  role: Role;
  isOwner: boolean;
  can(area: Area, edit?: boolean): boolean;
  /** Full effective permission matrix for the caller (for UI gating). */
  permissions: Record<Area, AreaPermission>;
}

export interface RequireScopeOptions {
  area?: Area;
  edit?: boolean;
  /** Explicit org id (e.g. from a query param) instead of the cookie. */
  orgId?: string | null;
}

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "").slice(0, 40) || "workspace";
}

/** Create the personal org for a user on first use. Idempotent. */
export async function ensurePersonalOrg(userId: string, email: string | null): Promise<OrgRow> {
  const existing = await queryOne<OrgRow>(
    `SELECT id, name, slug, owner_user_id, settings FROM organizations WHERE owner_user_id = $1`,
    [userId]
  );
  if (existing) return existing;

  const id = randomUUID();
  const base = slugify(email?.split("@")[0] ?? "workspace");
  const slug = `${base}-${id.slice(0, 6)}`;
  const name = email ? `${email.split("@")[0]}'s workspace` : "My workspace";
  await query(
    `INSERT INTO organizations (id, name, slug, owner_user_id, settings) VALUES ($1, $2, $3, $4, NULL)`,
    [id, name, slug, userId]
  );
  await query(
    `INSERT INTO memberships (id, org_id, user_id, role, status, accepted_at) VALUES ($1, $2, $3, 'owner', 'active', NOW())`,
    [randomUUID(), id, userId]
  );
  return { id, name, slug, owner_user_id: userId, settings: null };
}

async function effectivePermissions(orgId: string, role: Role): Promise<Record<Area, AreaPermission>> {
  const base: Record<Area, AreaPermission> = { ...DEFAULT_MATRIX[role] };
  if (role === "owner") return base;
  const overrides = await query<{ area: string; can_view: boolean | null; can_edit: boolean | null }>(
    `SELECT area, can_view, can_edit FROM role_area_overrides WHERE org_id = $1 AND role = $2`,
    [orgId, role]
  ).catch(() => []);
  for (const o of overrides) {
    if ((AREAS as readonly string[]).includes(o.area)) {
      base[o.area as Area] = { view: o.can_view !== false, edit: o.can_edit === true };
    }
  }
  return base;
}

/**
 * Effective permission matrix for the org whose data lives under `dataId`
 * (its `owner_user_id`), evaluated as the owner. Background callers with no
 * request (agent tools, cron) use this to gate reads the same way a route
 * would; an unknown data id yields the viewer matrix so nothing widens.
 */
export async function effectivePermissionsForOwner(dataId: string): Promise<Record<Area, AreaPermission>> {
  const org = await queryOne<{ id: string }>(`SELECT id FROM organizations WHERE owner_user_id = $1 LIMIT 1`, [dataId]).catch(() => null);
  if (!org) return { ...DEFAULT_MATRIX.viewer };
  return effectivePermissions(org.id, "owner");
}

/** `can(area, edit)` closure over a permission matrix. */
export function canFromPermissions(permissions: Record<Area, AreaPermission>): (area: Area, edit?: boolean) => boolean {
  return (area, edit = false) => {
    const p = permissions[area];
    return Boolean(p && p.view && (!edit || p.edit));
  };
}

/** Uncached loader for `listUserOrgs` (exported for tests). */
export async function loadUserOrgs(userId: string): Promise<Array<OrgRow & { role: Role }>> {
  const rows = await query<OrgRow & { role: string }>(
    `SELECT o.id, o.name, o.slug, o.owner_user_id, o.settings, m.role
       FROM memberships m JOIN organizations o ON o.id = m.org_id
      WHERE m.user_id = $1 AND m.status = 'active'
      ORDER BY (m.role = 'owner') DESC, o.name ASC`,
    [userId]
  );
  return rows.map((r) => ({ ...r, role: isRole(r.role) ? r.role : "viewer" }));
}

/** Orgs the user belongs to (active memberships). Per-request memoised. */
export const listUserOrgs: (userId: string) => Promise<Array<OrgRow & { role: Role }>> = requestMemo(loadUserOrgs);

/**
 * Per-request memoised membership + permission lookups used by `requireScope()`.
 * Several route handlers and server components call `requireScope()` for the
 * same request (layout, page, nested data loaders); each previously re-ran the
 * personal-org SELECT, the membership JOIN and the overrides SELECT.
 */
const memoPersonalOrg = requestMemo((userId: string, email: string | null) => ensurePersonalOrg(userId, email));
const memoMembership = requestMemo((userId: string, orgId: string) =>
  queryOne<OrgRow & { role: string }>(
    `SELECT o.id, o.name, o.slug, o.owner_user_id, o.settings, m.role
       FROM memberships m JOIN organizations o ON o.id = m.org_id
      WHERE m.user_id = $1 AND m.org_id = $2 AND m.status = 'active'`,
    [userId, orgId]
  )
);
const memoPermissions = requestMemo((orgId: string, role: Role) => effectivePermissions(orgId, role));

/**
 * Resolve the caller's scope. Throws ScopeError("UNAUTHORIZED") when not
 * signed in and ScopeError("FORBIDDEN") when the area/edit check fails.
 */
export async function requireScope(opts: RequireScopeOptions = {}): Promise<Scope> {
  let user: { id: string; email?: string | null };
  try {
    ({ user } = await requireUser());
  } catch {
    throw new ScopeError("UNAUTHORIZED");
  }
  const email = user.email ?? null;

  // Personal org always exists so single-user flows keep working unchanged. A failure here is an
  // infrastructure fault (database unreachable, schema not migrated), not a sign-in problem, so it
  // is surfaced as UNAVAILABLE (HTTP 503 with an actionable message) instead of a misleading 401.
  let personal: OrgRow;
  try {
    personal = await memoPersonalOrg(user.id, email);
  } catch (err) {
    if (err instanceof ScopeError) throw err;
    throw new ScopeError("UNAVAILABLE", "database unavailable", err instanceof Error ? err : new Error(String(err)));
  }

  let wantedOrg = opts.orgId ?? null;
  if (!wantedOrg) {
    try {
      wantedOrg = (await cookies()).get(ORG_COOKIE)?.value ?? null;
    } catch {
      wantedOrg = null;
    }
  }

  let org: OrgRow = personal;
  let role: Role = "owner";
  if (wantedOrg && wantedOrg !== personal.id) {
    const m = await memoMembership(user.id, wantedOrg);
    if (m) {
      org = m;
      role = isRole(m.role) ? m.role : "viewer";
    }
    // Unknown/foreign org id silently falls back to the personal org.
  }

  const permissions = await memoPermissions(org.id, role);
  const can = (area: Area, edit = false) => {
    const p = permissions[area];
    return Boolean(p && p.view && (!edit || p.edit));
  };

  if (opts.area && !can(opts.area, opts.edit)) {
    throw new ScopeError("FORBIDDEN", `Your role (${role}) cannot ${opts.edit ? "edit" : "view"} ${opts.area}.`);
  }

  return {
    userId: user.id,
    email,
    orgId: org.id,
    orgName: org.name,
    orgSlug: org.slug,
    dataId: org.owner_user_id,
    role,
    isOwner: role === "owner",
    can,
    permissions,
  };
}

/** Map a thrown error to a JSON response, or null when it is not a scope error. */
export function scopeErrorResponse(err: unknown): NextResponse | null {
  if (err instanceof ScopeError) {
    if (err.code === "UNAVAILABLE") return infraErrorResponse(err.underlying ?? err);
    if (err.code === "UNAUTHORIZED") return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    if (err.code === "FORBIDDEN") return NextResponse.json({ error: "forbidden", detail: err.message }, { status: 403 });
    return NextResponse.json({ error: "no_organization" }, { status: 403 });
  }
  if (err instanceof Error && err.message === "UNAUTHORIZED") {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  return null;
}

/** 503 with an actionable message for database/schema faults (never leaks connection details). */
export function infraErrorResponse(err: Error): NextResponse {
  const cause = (err as { cause?: { message?: string; code?: string } }).cause;
  const text = `${err.message} ${cause?.message ?? ""}`;
  const code = (err as { code?: string }).code ?? cause?.code ?? "";
  console.error("[scope] infrastructure error:", text.slice(0, 300));
  if (code === "42P01" || code === "42703" || /relation .* does not exist|column .* does not exist/i.test(text)) {
    return NextResponse.json(
      { error: "The database schema is out of date. An administrator must run the database migrations.", code: "schema_outdated" },
      { status: 503 }
    );
  }
  if (/DSQL_ENDPOINT is not set/i.test(text)) {
    return NextResponse.json({ error: "The database is not configured (DSQL_ENDPOINT is missing).", code: "db_not_configured" }, { status: 503 });
  }
  return NextResponse.json({ error: "The database is temporarily unavailable. Please try again.", code: "database_unavailable" }, { status: 503 });
}
