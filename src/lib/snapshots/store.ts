import { randomUUID } from "crypto";
import { query, queryOne } from "@/lib/dsql";
import { recordAudit } from "@/lib/audit";
import { emitEvent } from "@/lib/events/bus";
import { findSecretPaths, isSingletonSection, SECTION_KEYS, MAX_ITEMS_PER_SECTION, SNAPSHOT_SCHEMA_VERSION, type ApplicationDTO, type ApplyError, type ApplyMode, type ApplyResult, type PlanItem, type SectionKey, type SectionPlan, type SnapshotMeta, type SnapshotPlan } from "./types";
import { parseSnapshot, sectionsPresent, type SnapshotDoc } from "./schema";
import type { Area } from "@/lib/auth/roles";
import { APPLY_ORDER, canonicalJson, SECTION_AREA, SECTION_IMPLS, SINGLETON_KEY, sha256 } from "./sections";

/**
 * Snapshot export / plan / apply. Configuration only, never data; every write
 * goes through the module's own create/update function (see sections.ts).
 */

export class SnapshotError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
    this.name = "SnapshotError";
  }
}

/* ─── export ────────────────────────────────────────────────────────────── */

export interface ExportedSnapshot {
  doc: SnapshotDoc;
  json: string;
  sha256: string;
  size_bytes: number;
  sections: SectionKey[];
  warnings: string[];
}

export function normaliseSections(input: readonly string[] | undefined | null): SectionKey[] {
  if (!input || input.length === 0) return [...SECTION_KEYS];
  return SECTION_KEYS.filter((k) => input.includes(k));
}

export async function exportSnapshot(dataId: string, opts: { sections?: readonly string[]; name: string; description?: string | null }): Promise<ExportedSnapshot> {
  const wanted = normaliseSections(opts.sections);
  const warnings: string[] = [];
  const sections: Record<string, unknown> = {};
  for (const key of wanted) {
    let items: unknown[] = [];
    try {
      items = await SECTION_IMPLS[key].exportItems(dataId);
    } catch (err) {
      warnings.push(`${key}: ${err instanceof Error ? err.message : "export failed"}`);
      continue;
    }
    if (items.length === 0) continue;
    if (isSingletonSection(key)) sections[key] = items[0];
    else {
      if (items.length > MAX_ITEMS_PER_SECTION) warnings.push(`${key}: truncated to ${MAX_ITEMS_PER_SECTION} items`);
      sections[key] = items.slice(0, MAX_ITEMS_PER_SECTION);
    }
  }
  const raw = {
    schema: SNAPSHOT_SCHEMA_VERSION,
    name: opts.name.trim().slice(0, 120) || "Snapshot",
    ...(opts.description ? { description: opts.description.slice(0, 1000) } : {}),
    created_at: new Date().toISOString(),
    source: { product: "KernelHub" },
    sections,
  };
  const parsed = parseSnapshot(raw);
  if (!parsed.ok) throw new SnapshotError(`Snapshot failed validation: ${parsed.errors.join("; ")}`, 422);
  const json = JSON.stringify(parsed.snapshot);
  return { doc: parsed.snapshot, json, sha256: sha256(json), size_bytes: parsed.bytes, sections: sectionsPresent(parsed.snapshot), warnings };
}

/** Item counts per section for the create dialog preview. */
export async function countSections(dataId: string): Promise<Record<SectionKey, number>> {
  const out = {} as Record<SectionKey, number>;
  await Promise.all(
    SECTION_KEYS.map(async (k) => {
      out[k] = await SECTION_IMPLS[k].exportItems(dataId).then((r) => r.length).catch(() => 0);
    })
  );
  return out;
}

/* ─── stored snapshots ──────────────────────────────────────────────────── */

interface SnapshotRow {
  id: string; user_id: string; name: string; description: string | null; sections: string; payload?: string; sha256: string; size_bytes: number | string;
  source_org_id: string | null; visibility: string; created_by: string | null; created_at: string | Date;
}
const META_COLS = `id, user_id, name, description, sections, sha256, size_bytes, source_org_id, visibility, created_by, created_at`;

function toMeta(r: SnapshotRow, origin: "own" | "agency" = "own"): SnapshotMeta {
  let sections: SectionKey[] = [];
  try {
    const v: unknown = JSON.parse(r.sections);
    if (Array.isArray(v)) sections = SECTION_KEYS.filter((k) => v.includes(k));
  } catch {
    /* ignore */
  }
  return {
    id: r.id, name: r.name, description: r.description, sections, sha256: r.sha256, size_bytes: Number(r.size_bytes),
    source_org_id: r.source_org_id, visibility: r.visibility === "agency" ? "agency" : "private", created_by: r.created_by,
    created_at: new Date(r.created_at).toISOString(), origin,
  };
}

/** data id of the agency parent org, if this workspace is a client workspace. */
export async function parentDataId(dataId: string): Promise<string | null> {
  const row = await queryOne<{ owner_user_id: string }>(
    `SELECT p.owner_user_id FROM organizations c JOIN organizations p ON p.id = c.parent_org_id WHERE c.owner_user_id = $1`,
    [dataId]
  ).catch(() => null);
  return row?.owner_user_id ?? null;
}

export async function persistSnapshot(
  dataId: string,
  ex: ExportedSnapshot,
  opts: { actorId: string | null; orgId?: string | null; visibility?: "private" | "agency" }
): Promise<SnapshotMeta> {
  const id = randomUUID();
  await query(
    `INSERT INTO snapshots (id, user_id, name, description, sections, payload, sha256, size_bytes, source_org_id, visibility, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [id, dataId, ex.doc.name, ex.doc.description ?? null, JSON.stringify(ex.sections), ex.json, ex.sha256, ex.size_bytes, opts.orgId ?? null, opts.visibility === "agency" ? "agency" : "private", opts.actorId]
  );
  await recordAudit({ dataId, userId: opts.actorId }, { action: "snapshot.created", entity: "snapshot", entityId: id, after: { name: ex.doc.name, sections: ex.sections, size_bytes: ex.size_bytes } });
  const row = await queryOne<SnapshotRow>(`SELECT ${META_COLS} FROM snapshots WHERE id = $1`, [id]);
  if (!row) throw new SnapshotError("Snapshot was not saved", 500);
  return toMeta(row);
}

export async function createSnapshot(
  dataId: string,
  input: { name: string; description?: string | null; sections?: readonly string[]; visibility?: "private" | "agency" },
  actor: { actorId: string | null; orgId?: string | null }
): Promise<{ meta: SnapshotMeta; warnings: string[] }> {
  const ex = await exportSnapshot(dataId, input);
  if (ex.sections.length === 0) throw new SnapshotError("Nothing to snapshot: the selected sections are empty", 422);
  const meta = await persistSnapshot(dataId, ex, { ...actor, visibility: input.visibility });
  return { meta, warnings: ex.warnings };
}

/** Import a foreign JSON document (validated, secret-scanned) as a stored snapshot. */
export async function importSnapshot(dataId: string, raw: unknown, actor: { actorId: string | null; orgId?: string | null }, visibility: "private" | "agency" = "private"): Promise<SnapshotMeta> {
  const parsed = parseSnapshot(raw);
  if (!parsed.ok) throw new SnapshotError(parsed.errors.join("; "), 422);
  const json = JSON.stringify(parsed.snapshot);
  const sections = sectionsPresent(parsed.snapshot);
  if (sections.length === 0) throw new SnapshotError("The snapshot has no sections", 422);
  return persistSnapshot(dataId, { doc: parsed.snapshot, json, sha256: sha256(json), size_bytes: parsed.bytes, sections, warnings: [] }, { ...actor, visibility });
}

export async function listSnapshots(dataId: string): Promise<SnapshotMeta[]> {
  const own = await query<SnapshotRow>(`SELECT ${META_COLS} FROM snapshots WHERE user_id = $1 ORDER BY created_at DESC LIMIT 200`, [dataId]);
  const out = own.map((r) => toMeta(r, "own"));
  const parent = await parentDataId(dataId);
  if (parent) {
    const shared = await query<SnapshotRow>(`SELECT ${META_COLS} FROM snapshots WHERE user_id = $1 AND visibility = 'agency' ORDER BY created_at DESC LIMIT 100`, [parent]);
    out.push(...shared.map((r) => toMeta(r, "agency")));
  }
  return out;
}

export async function getSnapshotMeta(dataId: string, id: string): Promise<SnapshotMeta | null> {
  const row = await queryOne<SnapshotRow>(`SELECT ${META_COLS} FROM snapshots WHERE id = $1 AND user_id = $2`, [id, dataId]);
  if (row) return toMeta(row, "own");
  const parent = await parentDataId(dataId);
  if (!parent) return null;
  const shared = await queryOne<SnapshotRow>(`SELECT ${META_COLS} FROM snapshots WHERE id = $1 AND user_id = $2 AND visibility = 'agency'`, [id, parent]);
  return shared ? toMeta(shared, "agency") : null;
}

/** The stored document, if `dataId` may read it (own, or agency-shared by its parent). */
export async function getSnapshotDoc(dataId: string, id: string): Promise<{ meta: SnapshotMeta; doc: SnapshotDoc; json: string } | null> {
  const meta = await getSnapshotMeta(dataId, id);
  if (!meta) return null;
  const row = await queryOne<{ payload: string }>(`SELECT payload FROM snapshots WHERE id = $1`, [id]);
  if (!row) return null;
  const parsed = parseSnapshot(row.payload);
  if (!parsed.ok) throw new SnapshotError(`Stored snapshot is invalid: ${parsed.errors.join("; ")}`, 500);
  return { meta, doc: parsed.snapshot, json: row.payload };
}

export async function deleteSnapshot(dataId: string, id: string, actorId: string | null): Promise<boolean> {
  const rows = await query<{ id: string }>(`DELETE FROM snapshots WHERE id = $1 AND user_id = $2 RETURNING id`, [id, dataId]);
  if (rows.length === 0) return false;
  await recordAudit({ dataId, userId: actorId }, { action: "snapshot.deleted", entity: "snapshot", entityId: id });
  return true;
}

/* ─── plan ──────────────────────────────────────────────────────────────── */

interface OwnedRow { natural_key: string; object_id: string; item_sha: string | null }

async function ownedMap(dataId: string, section: SectionKey): Promise<Map<string, OwnedRow>> {
  const rows = await query<OwnedRow>(`SELECT natural_key, object_id, item_sha FROM snapshot_objects WHERE user_id = $1 AND section = $2`, [dataId, section]).catch(() => []);
  return new Map(rows.map((r) => [r.natural_key, r]));
}

function itemsOf(doc: SnapshotDoc, key: SectionKey): unknown[] {
  const v = (doc.sections as Record<string, unknown>)[key];
  if (v === undefined || v === null) return [];
  return isSingletonSection(key) ? [v] : (v as unknown[]);
}

interface Decision { action: PlanItem["action"]; reason?: string; conflict: boolean; objectId?: string; itemSha: string }

function decide(mode: ApplyMode, exists: string | undefined, owned: OwnedRow | undefined, itemSha: string): Decision {
  if (!exists) return { action: "create", reason: owned ? "previously applied object is gone" : undefined, conflict: false, itemSha };
  const ownedHere = owned !== undefined && owned.object_id === exists;
  if (ownedHere && owned.item_sha === itemSha) return { action: "skip", reason: "unchanged", conflict: false, objectId: exists, itemSha };
  if (mode === "merge" && ownedHere) return { action: "update", reason: "changed in snapshot", conflict: false, objectId: exists, itemSha };
  return { action: "skip", reason: mode === "merge" ? "exists and is not owned by a snapshot" : "already exists", conflict: !ownedHere, objectId: exists, itemSha };
}

export async function planSnapshot(dataId: string, doc: SnapshotDoc, opts: { sections?: readonly string[]; mode?: ApplyMode } = {}): Promise<SnapshotPlan> {
  const mode: ApplyMode = opts.mode === "merge" ? "merge" : "skip_existing";
  const wanted = new Set(normaliseSections(opts.sections));
  const present = new Set(sectionsPresent(doc));
  const plans: SectionPlan[] = [];
  for (const section of APPLY_ORDER) {
    if (!wanted.has(section) || !present.has(section)) continue;
    const impl = SECTION_IMPLS[section];
    const [existing, owned] = await Promise.all([impl.existing(dataId), ownedMap(dataId, section)]);
    const sp: SectionPlan = { section, create: 0, update: 0, skip: 0, conflicts: [], items: [] };
    const seen = new Set<string>();
    for (const item of itemsOf(doc, section)) {
      const key = isSingletonSection(section) ? SINGLETON_KEY : impl.keyOf(item);
      if (!key || seen.has(key)) {
        sp.skip++;
        sp.items.push({ key: key || "(unnamed)", action: "skip", reason: key ? "duplicate in snapshot" : "missing name" });
        continue;
      }
      seen.add(key);
      const d = decide(mode, existing.get(key), owned.get(key), sha256(canonicalJson(item)));
      sp[d.action]++;
      if (d.conflict) sp.conflicts.push(key);
      sp.items.push({ key, action: d.action, reason: d.reason });
    }
    plans.push(sp);
  }
  const totals = plans.reduce((t, p) => ({ create: t.create + p.create, update: t.update + p.update, skip: t.skip + p.skip, conflicts: t.conflicts + p.conflicts.length }), { create: 0, update: 0, skip: 0, conflicts: 0 });
  return { mode, sections: plans, totals };
}

/* ─── apply ─────────────────────────────────────────────────────────────── */

export async function applySnapshot(
  dataId: string,
  doc: SnapshotDoc,
  opts: { sections?: readonly string[]; mode?: ApplyMode; actorId?: string | null; snapshotId?: string | null; snapshotSha?: string | null; can?: (area: Area, edit?: boolean) => boolean }
): Promise<ApplyResult> {
  const mode: ApplyMode = opts.mode === "merge" ? "merge" : "skip_existing";
  const wanted = new Set(normaliseSections(opts.sections));
  const present = new Set(sectionsPresent(doc));
  const snapshotSha = opts.snapshotSha ?? sha256(JSON.stringify(doc));
  const ctx = { dataId, actorId: opts.actorId ?? null };
  const errors: ApplyError[] = [];
  const plan: SnapshotPlan = { mode, sections: [], totals: { create: 0, update: 0, skip: 0, conflicts: 0 } };
  let created = 0;
  let updated = 0;
  let skipped = 0;

  for (const section of APPLY_ORDER) {
    if (!wanted.has(section) || !present.has(section)) continue;
    const impl = SECTION_IMPLS[section];
    if (opts.can && !opts.can(SECTION_AREA[section], true)) {
      // The caller lacks edit rights for this section's area: report it instead of silently widening their access.
      errors.push({ section, key: "*", message: `Not permitted to edit ${SECTION_AREA[section]}` });
      continue;
    }
    const [existing, owned] = await Promise.all([impl.existing(dataId), ownedMap(dataId, section)]);
    const sp: SectionPlan = { section, create: 0, update: 0, skip: 0, conflicts: [], items: [] };
    const seen = new Set<string>();
    for (const item of itemsOf(doc, section)) {
      const key = isSingletonSection(section) ? SINGLETON_KEY : impl.keyOf(item);
      if (!key || seen.has(key)) {
        sp.skip++;
        skipped++;
        sp.items.push({ key: key || "(unnamed)", action: "skip", reason: key ? "duplicate in snapshot" : "missing name" });
        continue;
      }
      seen.add(key);
      const d = decide(mode, existing.get(key), owned.get(key), sha256(canonicalJson(item)));
      try {
        let objectId = d.objectId;
        if (d.action === "create") {
          objectId = await impl.create(ctx, item);
          created++;
        } else if (d.action === "update" && objectId) {
          await impl.update(ctx, objectId, item);
          updated++;
        } else {
          skipped++;
        }
        if ((d.action === "create" || d.action === "update") && objectId) {
          await query(
            `INSERT INTO snapshot_objects (id, user_id, section, natural_key, object_id, snapshot_sha, item_sha, applied_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
             ON CONFLICT (user_id, section, natural_key) DO UPDATE SET object_id = EXCLUDED.object_id, snapshot_sha = EXCLUDED.snapshot_sha, item_sha = EXCLUDED.item_sha, applied_at = NOW()`,
            [randomUUID(), dataId, section, key, objectId, snapshotSha, d.itemSha]
          );
        }
        sp[d.action]++;
        if (d.conflict) sp.conflicts.push(key);
        sp.items.push({ key, action: d.action, reason: d.reason });
      } catch (err) {
        errors.push({ section, key, message: (err instanceof Error ? err.message : String(err)).slice(0, 300) });
        sp.skip++;
        sp.items.push({ key, action: "skip", reason: "error" });
      }
    }
    plan.sections.push(sp);
  }
  plan.totals = plan.sections.reduce((t, p) => ({ create: t.create + p.create, update: t.update + p.update, skip: t.skip + p.skip, conflicts: t.conflicts + p.conflicts.length }), { create: 0, update: 0, skip: 0, conflicts: 0 });

  const status: ApplyResult["status"] = errors.length === 0 ? "applied" : created + updated > 0 ? "partial" : "failed";
  const applicationId = randomUUID();
  const summary = { created, updated, skipped, errors };
  await query(
    `INSERT INTO snapshot_applications (id, user_id, snapshot_id, applied_by, mode, plan, result, status) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [applicationId, dataId, opts.snapshotId ?? null, opts.actorId ?? null, mode, JSON.stringify(plan.totals), JSON.stringify(summary), status]
  ).catch((err) => console.error("[snapshots] failed to record application", err));
  await emitEvent(dataId, { type: "snapshot.applied", entity: "snapshot", entityId: opts.snapshotId ?? applicationId, data: { application_id: applicationId, mode, status, created, updated, skipped, errors: errors.length } });
  await recordAudit({ dataId, userId: opts.actorId ?? null }, { action: "snapshot.applied", entity: "snapshot", entityId: opts.snapshotId ?? applicationId, after: { mode, status, created, updated, skipped, errors: errors.length } });
  return { application_id: applicationId, status, plan, created, updated, skipped, errors };
}

export async function listApplications(dataId: string, limit = 50): Promise<ApplicationDTO[]> {
  const rows = await query<{ id: string; snapshot_id: string | null; applied_by: string | null; mode: string; result: string | null; status: string; created_at: string | Date; snapshot_name: string | null }>(
    `SELECT a.id, a.snapshot_id, a.applied_by, a.mode, a.result, a.status, a.created_at, s.name AS snapshot_name
       FROM snapshot_applications a LEFT JOIN snapshots s ON s.id = a.snapshot_id
      WHERE a.user_id = $1 ORDER BY a.created_at DESC LIMIT $2`,
    [dataId, Math.min(Math.max(limit, 1), 200)]
  ).catch(() => []);
  return rows.map((r) => {
    let res: { created?: number; updated?: number; skipped?: number; errors?: unknown[] } = {};
    try {
      res = JSON.parse(r.result ?? "{}") as typeof res;
    } catch {
      /* ignore */
    }
    return {
      id: r.id, snapshot_id: r.snapshot_id, snapshot_name: r.snapshot_name, applied_by: r.applied_by, mode: r.mode, status: r.status,
      created: res.created ?? 0, updated: res.updated ?? 0, skipped: res.skipped ?? 0, errors: Array.isArray(res.errors) ? res.errors.length : 0,
      created_at: new Date(r.created_at).toISOString(),
    };
  });
}

/** Defence in depth for tests and callers: true when a serialised snapshot is free of credential-like keys/values. */
export function isSnapshotClean(json: string): boolean {
  try {
    return findSecretPaths(JSON.parse(json)).length === 0;
  } catch {
    return false;
  }
}
