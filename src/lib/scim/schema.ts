/**
 * SCIM 2.0 (RFC 7643/7644) — pure helpers shared by the routes, the settings
 * page and tests. No DB access here.
 *
 * Resource model: a SCIM User is a membership row of the org that owns the
 * bearer token (id = membership id, userName = email, roles = [{value: role}],
 * active = status ∈ {active, invited}). A SCIM Group is a role; its members are
 * the memberships holding that role.
 */

export const SCIM = {
  USER: "urn:ietf:params:scim:schemas:core:2.0:User",
  GROUP: "urn:ietf:params:scim:schemas:core:2.0:Group",
  LIST: "urn:ietf:params:scim:api:messages:2.0:ListResponse",
  ERROR: "urn:ietf:params:scim:api:messages:2.0:Error",
  PATCH: "urn:ietf:params:scim:api:messages:2.0:PatchOp",
  SPC: "urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig",
  RESOURCE_TYPE: "urn:ietf:params:scim:schemas:core:2.0:ResourceType",
  SCHEMA: "urn:ietf:params:scim:schemas:core:2.0:Schema",
} as const;

export const SCIM_CONTENT_TYPE = "application/scim+json";
export const SCIM_MAX_COUNT = 200;
export const SCIM_DEFAULT_COUNT = 50;

export type ScimType = "invalidFilter" | "tooMany" | "uniqueness" | "mutability" | "invalidSyntax" | "invalidPath" | "noTarget" | "invalidValue" | "invalidVers" | "sensitive";

export interface ScimErrorBody {
  schemas: [typeof SCIM.ERROR];
  status: string;
  detail: string;
  scimType?: ScimType;
}

export function scimError(status: number, detail: string, scimType?: ScimType): ScimErrorBody {
  return { schemas: [SCIM.ERROR], status: String(status), detail, ...(scimType ? { scimType } : {}) };
}

export interface ScimMeta {
  resourceType: "User" | "Group";
  created?: string;
  lastModified?: string;
  location?: string;
}

export interface ScimUser {
  schemas: string[];
  id: string;
  userName: string;
  active: boolean;
  displayName?: string;
  name?: { givenName?: string; familyName?: string; formatted?: string };
  emails: Array<{ value: string; primary?: boolean; type?: string }>;
  roles: Array<{ value: string; primary?: boolean }>;
  groups?: Array<{ value: string; display?: string }>;
  meta: ScimMeta;
}

export interface ScimGroup {
  schemas: string[];
  id: string;
  displayName: string;
  members: Array<{ value: string; display?: string }>;
  meta: ScimMeta;
}

export interface ListResponse<T> {
  schemas: [typeof SCIM.LIST];
  totalResults: number;
  startIndex: number;
  itemsPerPage: number;
  Resources: T[];
}

export function listResponse<T>(items: T[], total: number, startIndex: number): ListResponse<T> {
  return { schemas: [SCIM.LIST], totalResults: total, startIndex, itemsPerPage: items.length, Resources: items };
}

/** 1-based paging, clamped: startIndex ≥ 1, 1 ≤ count ≤ SCIM_MAX_COUNT. */
export function parsePaging(params: { startIndex?: string | null; count?: string | null }): { startIndex: number; count: number } {
  const si = Number.parseInt(params.startIndex ?? "", 10);
  const c = Number.parseInt(params.count ?? "", 10);
  return {
    startIndex: Number.isFinite(si) && si >= 1 ? si : 1,
    count: Number.isFinite(c) ? Math.min(Math.max(c, 1), SCIM_MAX_COUNT) : SCIM_DEFAULT_COUNT,
  };
}

// ── Filters ──────────────────────────────────────────────────────────────────

export type FilterOp = "eq" | "ne" | "co" | "sw" | "ew" | "pr";
export interface ScimFilter {
  /** Lower-cased attribute path, e.g. "username", "emails.value", "name.givenname". */
  attr: string;
  op: FilterOp;
  /** Absent for `pr`. */
  value: string | boolean | null;
}

const FILTER_RE = /^\s*([A-Za-z][A-Za-z0-9_.:$-]*)\s+(eq|ne|co|sw|ew|pr)(?:\s+(?:"((?:[^"\\]|\\.)*)"|(true|false|null)|(\d+)))?\s*$/i;

/**
 * Parse the subset of SCIM filters IdPs actually send for provisioning:
 * `attr op "value"`, `attr pr`, booleans and numbers. Anything else
 * (and/or/not, grouping, complex paths) returns null → 400 invalidFilter.
 */
export function parseFilter(raw: string | null | undefined): ScimFilter | null {
  if (!raw || !raw.trim()) return null;
  const m = FILTER_RE.exec(raw);
  if (!m) return null;
  const [, attr, opRaw, str, lit, num] = m;
  const op = opRaw.toLowerCase() as FilterOp;
  if (op === "pr") return { attr: attr.toLowerCase(), op, value: null };
  let value: string | boolean | null;
  if (str !== undefined) value = str.replace(/\\(["\\])/g, "$1");
  else if (lit !== undefined) value = lit === "null" ? null : lit === "true";
  else if (num !== undefined) value = num;
  else return null;
  return { attr: attr.toLowerCase(), op, value };
}

function readPath(obj: unknown, path: string): unknown[] {
  const parts = path.split(".");
  let cur: unknown[] = [obj];
  for (const p of parts) {
    const next: unknown[] = [];
    for (const c of cur) {
      if (Array.isArray(c)) {
        for (const item of c) if (item && typeof item === "object") next.push((item as Record<string, unknown>)[matchKey(item as Record<string, unknown>, p)]);
      } else if (c && typeof c === "object") {
        next.push((c as Record<string, unknown>)[matchKey(c as Record<string, unknown>, p)]);
      }
    }
    cur = next;
  }
  return cur.flatMap((v) => (Array.isArray(v) ? v : [v])).filter((v) => v !== undefined);
}

function matchKey(obj: Record<string, unknown>, key: string): string {
  const lower = key.toLowerCase();
  return Object.keys(obj).find((k) => k.toLowerCase() === lower) ?? key;
}

/** Evaluate a parsed filter against a resource (case-insensitive string compare, per RFC 7644 §3.4.2.2). */
export function matchesFilter(resource: unknown, f: ScimFilter): boolean {
  const values = readPath(resource, f.attr).map((v) => (v && typeof v === "object" && "value" in (v as object) ? (v as { value: unknown }).value : v));
  if (f.op === "pr") return values.some((v) => v !== null && v !== undefined && v !== "");
  const want = typeof f.value === "string" ? f.value.toLowerCase() : f.value;
  return values.some((v) => {
    if (typeof want === "boolean" || want === null) return f.op === "ne" ? v !== want : v === want;
    const s = String(v ?? "").toLowerCase();
    switch (f.op) {
      case "eq": return s === want;
      case "ne": return s !== want;
      case "co": return s.includes(want);
      case "sw": return s.startsWith(want);
      case "ew": return s.endsWith(want);
      default: return false;
    }
  });
}

// ── PATCH ────────────────────────────────────────────────────────────────────

export interface PatchOp {
  op: "add" | "replace" | "remove";
  path?: string;
  value?: unknown;
}

/** Normalise a raw PatchOp body (ops are case-insensitive; Azure sends "Replace"). */
export function parsePatchOps(body: unknown): PatchOp[] | null {
  if (!body || typeof body !== "object") return null;
  const ops = (body as { Operations?: unknown }).Operations;
  if (!Array.isArray(ops) || ops.length === 0 || ops.length > 100) return null;
  const out: PatchOp[] = [];
  for (const raw of ops) {
    if (!raw || typeof raw !== "object") return null;
    const r = raw as Record<string, unknown>;
    const op = String(r.op ?? "").toLowerCase();
    if (op !== "add" && op !== "replace" && op !== "remove") return null;
    const path = typeof r.path === "string" ? r.path : undefined;
    out.push({ op, path, value: r.value });
  }
  return out;
}

/** Azure/Okta send booleans as "True"/"False" strings in PATCH bodies. */
export function toBool(v: unknown): boolean | undefined {
  if (typeof v === "boolean") return v;
  if (typeof v === "string") {
    const s = v.trim().toLowerCase();
    if (s === "true") return true;
    if (s === "false") return false;
  }
  return undefined;
}

/** Strip a value filter from a path: `emails[type eq "work"].value` → `emails.value`. */
export function normalisePath(path: string): string {
  return path.replace(/\[[^\]]*\]/g, "").replace(/^urn:ietf:params:scim:schemas:core:2\.0:User:/i, "").toLowerCase();
}

export interface PatchableUser {
  userName: string;
  active: boolean;
  givenName?: string;
  familyName?: string;
  displayName?: string;
  role?: string;
}

/**
 * Pure: apply PATCH operations to a flattened user and return the new state.
 * Unknown attributes are ignored (IdPs send plenty we do not store). Throws
 * on an op shape that cannot be interpreted so the route can 400.
 */
export function applyUserPatch(current: PatchableUser, ops: PatchOp[]): PatchableUser {
  const next: PatchableUser = { ...current };
  const setAttr = (path: string, value: unknown) => {
    switch (path) {
      case "active": {
        const b = toBool(value);
        if (b === undefined) throw new Error("active must be a boolean");
        next.active = b;
        break;
      }
      case "username":
        if (typeof value !== "string" || !value.trim()) throw new Error("userName must be a string");
        next.userName = value.trim().toLowerCase();
        break;
      case "emails.value":
      case "emails":
        if (typeof value === "string") next.userName = value.trim().toLowerCase();
        else if (Array.isArray(value)) {
          const objs = value.filter((e): e is { value?: string; primary?: boolean } => Boolean(e) && typeof e === "object");
          const primary = objs.find((e) => e.primary) ?? objs[0];
          if (primary?.value) next.userName = String(primary.value).trim().toLowerCase();
        }
        break;
      case "name.givenname": next.givenName = value == null ? undefined : String(value); break;
      case "name.familyname": next.familyName = value == null ? undefined : String(value); break;
      case "displayname": next.displayName = value == null ? undefined : String(value); break;
      case "name":
        if (value && typeof value === "object") {
          const n = value as { givenName?: unknown; familyName?: unknown };
          if (n.givenName !== undefined) next.givenName = n.givenName == null ? undefined : String(n.givenName);
          if (n.familyName !== undefined) next.familyName = n.familyName == null ? undefined : String(n.familyName);
        }
        break;
      case "roles":
      case "roles.value": {
        const first = Array.isArray(value) ? value[0] : value;
        const v = first && typeof first === "object" ? (first as { value?: unknown }).value : first;
        if (typeof v === "string" && v.trim()) next.role = v.trim().toLowerCase();
        break;
      }
      default:
        // Attributes we do not persist (externalId, title, phoneNumbers…) are accepted and ignored.
        break;
    }
  };

  for (const op of ops) {
    if (op.op === "remove") {
      if (!op.path) throw new Error("remove requires a path");
      const p = normalisePath(op.path);
      if (p === "name.givenname") next.givenName = undefined;
      else if (p === "name.familyname") next.familyName = undefined;
      else if (p === "displayname") next.displayName = undefined;
      else if (p === "active") next.active = false;
      continue;
    }
    if (op.path) {
      setAttr(normalisePath(op.path), op.value);
    } else if (op.value && typeof op.value === "object") {
      // No path: value is an object of attributes to add/replace.
      for (const [k, v] of Object.entries(op.value as Record<string, unknown>)) setAttr(normalisePath(k), v);
    } else {
      throw new Error("add/replace requires a path or an object value");
    }
  }
  return next;
}

/** Pure: member ids added/removed by Group PATCH ops. */
export function applyGroupPatch(ops: PatchOp[]): { add: string[]; remove: string[]; replace: string[] | null } {
  const add: string[] = [];
  const remove: string[] = [];
  let replace: string[] | null = null;
  const ids = (v: unknown): string[] => {
    if (!Array.isArray(v)) return [];
    return v.map((m) => (m && typeof m === "object" ? (m as { value?: unknown }).value : m)).filter((x): x is string => typeof x === "string" && x.length > 0);
  };
  for (const op of ops) {
    const path = op.path ? op.path.trim() : "";
    const lower = path.toLowerCase();
    if (op.op === "remove") {
      const m = /^members\[\s*value\s+eq\s+"([^"]+)"\s*\]$/i.exec(path);
      if (m) remove.push(m[1]);
      else if (lower === "members") remove.push(...ids(op.value));
      else if (!path) throw new Error("remove requires a path");
      continue;
    }
    if (lower === "members" || (!path && op.value && typeof op.value === "object" && "members" in (op.value as object))) {
      const list = lower === "members" ? ids(op.value) : ids((op.value as { members?: unknown }).members);
      if (op.op === "replace") replace = list;
      else add.push(...list);
    }
    // displayName changes are ignored: groups are the fixed role set.
  }
  return { add, remove, replace };
}

// ── Discovery documents ──────────────────────────────────────────────────────

export function serviceProviderConfig(baseUrl: string) {
  return {
    schemas: [SCIM.SPC],
    documentationUri: `${baseUrl.replace(/\/api\/scim\/v2$/, "")}/settings/sso`,
    patch: { supported: true },
    bulk: { supported: false, maxOperations: 0, maxPayloadSize: 0 },
    filter: { supported: true, maxResults: SCIM_MAX_COUNT },
    changePassword: { supported: false },
    sort: { supported: false },
    etag: { supported: false },
    authenticationSchemes: [
      {
        type: "oauthbearertoken",
        name: "OAuth Bearer Token",
        description: "Authentication scheme using a SCIM bearer token generated under Settings → SSO & SCIM.",
        specUri: "https://www.rfc-editor.org/info/rfc6750",
        primary: true,
      },
    ],
    meta: { resourceType: "ServiceProviderConfig", location: `${baseUrl}/ServiceProviderConfig` },
  };
}

export function resourceTypes(baseUrl: string) {
  return [
    { schemas: [SCIM.RESOURCE_TYPE], id: "User", name: "User", endpoint: "/Users", description: "Workspace member", schema: SCIM.USER, meta: { resourceType: "ResourceType", location: `${baseUrl}/ResourceTypes/User` } },
    { schemas: [SCIM.RESOURCE_TYPE], id: "Group", name: "Group", endpoint: "/Groups", description: "Workspace role", schema: SCIM.GROUP, meta: { resourceType: "ResourceType", location: `${baseUrl}/ResourceTypes/Group` } },
  ];
}

export function schemas(baseUrl: string) {
  const attr = (name: string, type: string, extra: Record<string, unknown> = {}) => ({
    name, type, multiValued: false, required: false, caseExact: false, mutability: "readWrite", returned: "default", uniqueness: "none", ...extra,
  });
  return [
    {
      schemas: [SCIM.SCHEMA],
      id: SCIM.USER,
      name: "User",
      description: "Workspace member",
      attributes: [
        attr("userName", "string", { required: true, uniqueness: "server" }),
        attr("active", "boolean"),
        attr("displayName", "string"),
        attr("name", "complex", { subAttributes: [attr("givenName", "string"), attr("familyName", "string")] }),
        attr("emails", "complex", { multiValued: true, subAttributes: [attr("value", "string"), attr("primary", "boolean")] }),
        attr("roles", "complex", { multiValued: true, subAttributes: [attr("value", "string")] }),
      ],
      meta: { resourceType: "Schema", location: `${baseUrl}/Schemas/${SCIM.USER}` },
    },
    {
      schemas: [SCIM.SCHEMA],
      id: SCIM.GROUP,
      name: "Group",
      description: "Workspace role (owner, admin, manager, member, viewer)",
      attributes: [
        attr("displayName", "string", { required: true, mutability: "readOnly" }),
        attr("members", "complex", { multiValued: true, subAttributes: [attr("value", "string"), attr("display", "string")] }),
      ],
      meta: { resourceType: "Schema", location: `${baseUrl}/Schemas/${SCIM.GROUP}` },
    },
  ];
}
