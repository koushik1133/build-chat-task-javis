import { randomUUID } from "crypto";
import { query, queryOne } from "@/lib/dsql";
import { emitEvent } from "@/lib/events/bus";
import { likeContains } from "@/lib/like";
import { keysetClause, keysetOrder, type Cursor } from "@/lib/public-api/pagination";
import {
  RESERVED_TYPE_SLUGS,
  RecordTypeInputSchema,
  RecordTypePatchSchema,
  RecordValidationError,
  resolveStage,
  slugifyRecordType,
  validateRecordData,
  validateViews,
  type RecordTypeInput,
} from "./schema";
import type {
  ActivityKind,
  ActivityRow,
  FieldDef,
  LinkKind,
  LinkRow,
  RecordData,
  RecordItem,
  RecordRow,
  RecordType,
  RecordTypeRow,
  RecordTypeViews,
  StageDef,
} from "./types";

/**
 * Records store. Every function takes `dataId` (the org's data key from
 * `requireScope().dataId`) and scopes every query by it.
 */

const TYPE_COLS =
  "id, user_id, slug, name, icon, description, fields, stages, views, copilot_prompt, pack_slug, created_at, updated_at";
const RECORD_COLS =
  "id, user_id, type_id, title, stage, data, summary, contact_id, amount_minor, currency, due_at, assigned_to, deleted_at, created_at, updated_at";

function parseJson<T>(s: string | null | undefined, fallback: T): T {
  if (!s) return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
}

export function typeFromRow(r: RecordTypeRow): RecordType {
  return {
    id: r.id,
    slug: r.slug,
    name: r.name,
    icon: r.icon,
    description: r.description,
    fields: parseJson<FieldDef[]>(r.fields, []),
    stages: parseJson<StageDef[]>(r.stages, []),
    views: parseJson<RecordTypeViews>(r.views, {}),
    copilot_prompt: r.copilot_prompt,
    pack_slug: r.pack_slug,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

export function recordFromRow(r: RecordRow): RecordItem {
  return {
    id: r.id,
    type_id: r.type_id,
    title: r.title,
    stage: r.stage,
    data: parseJson<RecordData>(r.data, {}),
    summary: r.summary,
    contact_id: r.contact_id,
    amount_minor: r.amount_minor === null || r.amount_minor === undefined ? null : Number(r.amount_minor),
    currency: r.currency,
    due_at: r.due_at,
    assigned_to: r.assigned_to,
    deleted_at: r.deleted_at,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

/* ─── Record types ─────────────────────────────────────────────────────── */

export async function listTypes(dataId: string): Promise<RecordType[]> {
  const rows = await query<RecordTypeRow>(`SELECT ${TYPE_COLS} FROM record_types WHERE user_id = $1 ORDER BY name ASC`, [
    dataId,
  ]);
  return rows.map(typeFromRow);
}

/** Look up a type by id or slug. */
export async function getType(dataId: string, idOrSlug: string): Promise<RecordType | null> {
  const row = await queryOne<RecordTypeRow>(
    `SELECT ${TYPE_COLS} FROM record_types WHERE user_id = $1 AND (id = $2 OR slug = $2) LIMIT 1`,
    [dataId, idOrSlug]
  );
  return row ? typeFromRow(row) : null;
}

export interface CreateTypeOptions {
  pack_slug?: string | null;
}

export async function createType(dataId: string, input: RecordTypeInput, opts: CreateTypeOptions = {}): Promise<RecordType> {
  const parsed = RecordTypeInputSchema.parse(input);
  const slug = parsed.slug ?? slugifyRecordType(parsed.name);
  if (!slug) throw new RecordValidationError(["name must contain letters or numbers"]);
  if ((RESERVED_TYPE_SLUGS as readonly string[]).includes(slug)) throw new RecordValidationError([`"${slug}" is a reserved slug`]);
  const views = parsed.views ?? {};
  const viewErrors = validateViews(views, parsed.fields);
  if (viewErrors.length) throw new RecordValidationError(viewErrors);

  const existing = await queryOne<{ id: string }>(`SELECT id FROM record_types WHERE user_id = $1 AND slug = $2`, [
    dataId,
    slug,
  ]);
  if (existing) throw new RecordValidationError([`a record type with slug "${slug}" already exists`]);

  const id = randomUUID();
  const row = await queryOne<RecordTypeRow>(
    `INSERT INTO record_types (id, user_id, slug, name, icon, description, fields, stages, views, copilot_prompt, pack_slug)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING ${TYPE_COLS}`,
    [
      id,
      dataId,
      slug,
      parsed.name,
      parsed.icon ?? null,
      parsed.description ?? null,
      JSON.stringify(parsed.fields),
      JSON.stringify(parsed.stages),
      JSON.stringify(views),
      parsed.copilot_prompt ?? null,
      opts.pack_slug ?? null,
    ]
  );
  if (!row) throw new Error("Insert returned no row");
  return typeFromRow(row);
}

export async function updateType(dataId: string, idOrSlug: string, patch: unknown): Promise<RecordType> {
  const existing = await getType(dataId, idOrSlug);
  if (!existing) throw new Error("Record type not found");
  const parsed = RecordTypePatchSchema.parse(patch);
  const fields = parsed.fields ?? existing.fields;
  const stages = parsed.stages ?? existing.stages;
  const views = parsed.views ?? existing.views;
  const viewErrors = validateViews(views, fields);
  if (viewErrors.length) throw new RecordValidationError(viewErrors);

  const row = await queryOne<RecordTypeRow>(
    `UPDATE record_types
        SET name = $3, icon = $4, description = $5, fields = $6, stages = $7, views = $8, copilot_prompt = $9, updated_at = NOW()
      WHERE id = $1 AND user_id = $2 RETURNING ${TYPE_COLS}`,
    [
      existing.id,
      dataId,
      parsed.name ?? existing.name,
      parsed.icon === undefined ? existing.icon : parsed.icon,
      parsed.description === undefined ? existing.description : parsed.description,
      JSON.stringify(fields),
      JSON.stringify(stages),
      JSON.stringify(views),
      parsed.copilot_prompt === undefined ? existing.copilot_prompt : parsed.copilot_prompt,
    ]
  );
  if (!row) throw new Error("Record type not found");
  return typeFromRow(row);
}

/** Delete a type and soft-delete its records. */
export async function deleteType(dataId: string, idOrSlug: string): Promise<boolean> {
  const existing = await getType(dataId, idOrSlug);
  if (!existing) return false;
  await query(`UPDATE records SET deleted_at = NOW() WHERE user_id = $1 AND type_id = $2 AND deleted_at IS NULL`, [
    dataId,
    existing.id,
  ]);
  const rows = await query<{ id: string }>(`DELETE FROM record_types WHERE id = $1 AND user_id = $2 RETURNING id`, [
    existing.id,
    dataId,
  ]);
  return rows.length > 0;
}

/* ─── Records ──────────────────────────────────────────────────────────── */

export interface ListRecordsOptions {
  stage?: string | null;
  q?: string | null;
  limit?: number;
  includeDeleted?: boolean;
  /** "updated" (default) or "created" (newest first, cursor-friendly). */
  order?: "updated" | "created";
  cursor?: Cursor | null;
}

export async function listRecords(dataId: string, type: RecordType, opts: ListRecordsOptions = {}): Promise<RecordItem[]> {
  const params: unknown[] = [dataId, type.id];
  let sql = `SELECT ${RECORD_COLS} FROM records WHERE user_id = $1 AND type_id = $2`;
  if (!opts.includeDeleted) sql += ` AND deleted_at IS NULL`;
  if (opts.stage) {
    params.push(opts.stage);
    sql += ` AND stage = $${params.length}`;
  }
  if (opts.q?.trim()) {
    params.push(likeContains(opts.q.trim().slice(0, 100)));
    const i = params.length;
    sql += ` AND (title ILIKE $${i} OR summary ILIKE $${i} OR data ILIKE $${i})`;
  }
  if (opts.order === "created") sql += keysetClause(opts.cursor, params);
  params.push(Math.min(Math.max(opts.limit ?? 200, 1), 500));
  sql += opts.order === "created" ? ` ORDER BY ${keysetOrder()} LIMIT $${params.length}` : ` ORDER BY updated_at DESC LIMIT $${params.length}`;
  const rows = await query<RecordRow>(sql, params);
  return rows.map(recordFromRow);
}

export async function getRecord(dataId: string, id: string): Promise<RecordItem | null> {
  const row = await queryOne<RecordRow>(`SELECT ${RECORD_COLS} FROM records WHERE id = $1 AND user_id = $2`, [id, dataId]);
  return row ? recordFromRow(row) : null;
}

/** Derive the denormalised columns from validated data + the type's views. */
function derived(type: RecordType, data: RecordData) {
  const v = type.views;
  const firstOf = (t: FieldDef["type"]) => type.fields.find((f) => f.type === t)?.key;
  const amountKey = v.amountField ?? firstOf("money");
  const dueKey = v.dueField ?? firstOf("date");
  const contactKey = v.contactField ?? firstOf("contact_ref");
  const amount = amountKey ? data[amountKey] : null;
  const due = dueKey ? data[dueKey] : null;
  const contact = contactKey ? data[contactKey] : null;
  return {
    amount_minor: typeof amount === "number" && Number.isFinite(amount) ? Math.round(amount) : null,
    due_at: typeof due === "string" && due ? due : null,
    contact_id: typeof contact === "string" && contact ? contact : null,
  };
}

export interface CreateRecordInput {
  title: string;
  stage?: string | null;
  data?: unknown;
  summary?: string | null;
  currency?: string | null;
  assigned_to?: string | null;
  actorId?: string | null;
  /** Skip the activity row + event (bulk imports). */
  silent?: boolean;
}

export async function createRecord(dataId: string, type: RecordType, input: CreateRecordInput): Promise<RecordItem> {
  const title = String(input.title ?? "").trim().slice(0, 300);
  if (!title) throw new RecordValidationError(["title is required"]);
  const data = validateRecordData(type.fields, input.data ?? {});
  const stage = resolveStage(type.stages, input.stage);
  const d = derived(type, data);
  const id = randomUUID();
  const row = await queryOne<RecordRow>(
    `INSERT INTO records (id, user_id, type_id, title, stage, data, summary, contact_id, amount_minor, currency, due_at, assigned_to)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING ${RECORD_COLS}`,
    [
      id,
      dataId,
      type.id,
      title,
      stage,
      JSON.stringify(data),
      input.summary?.slice(0, 4000) ?? null,
      d.contact_id,
      d.amount_minor,
      d.amount_minor !== null ? (input.currency ?? "USD").toUpperCase().slice(0, 3) : input.currency ?? null,
      d.due_at,
      input.assigned_to ?? null,
    ]
  );
  if (!row) throw new Error("Insert returned no row");
  const rec = recordFromRow(row);
  if (!input.silent) {
    await addActivity(dataId, rec.id, { kind: "created", actorId: input.actorId ?? null, body: `Created in ${stage}` });
    void emitEvent(dataId, {
      type: "record.created",
      entity: "record",
      entityId: rec.id,
      data: { type: type.slug, stage, title },
    });
  }
  return rec;
}

export interface UpdateRecordInput {
  title?: string;
  data?: unknown;
  summary?: string | null;
  currency?: string | null;
  assigned_to?: string | null;
  actorId?: string | null;
}

export async function updateRecord(dataId: string, type: RecordType, id: string, input: UpdateRecordInput): Promise<RecordItem> {
  const existing = await getRecord(dataId, id);
  if (!existing || existing.type_id !== type.id) throw new Error("Record not found");
  const partial = input.data === undefined ? {} : validateRecordData(type.fields, input.data, true);
  const data: RecordData = { ...existing.data, ...partial };
  const title = input.title === undefined ? existing.title : String(input.title).trim().slice(0, 300);
  if (!title) throw new RecordValidationError(["title is required"]);
  const d = derived(type, data);
  const diff: Record<string, { from: unknown; to: unknown }> = {};
  for (const k of Object.keys(partial)) {
    if (JSON.stringify(existing.data[k]) !== JSON.stringify(partial[k])) diff[k] = { from: existing.data[k] ?? null, to: partial[k] };
  }
  if (title !== existing.title) diff.title = { from: existing.title, to: title };

  const row = await queryOne<RecordRow>(
    `UPDATE records
        SET title = $3, data = $4, summary = $5, contact_id = $6, amount_minor = $7, currency = $8, due_at = $9, assigned_to = $10, updated_at = NOW()
      WHERE id = $1 AND user_id = $2 RETURNING ${RECORD_COLS}`,
    [
      id,
      dataId,
      title,
      JSON.stringify(data),
      input.summary === undefined ? existing.summary : input.summary?.slice(0, 4000) ?? null,
      d.contact_id,
      d.amount_minor,
      input.currency === undefined ? existing.currency ?? (d.amount_minor !== null ? "USD" : null) : input.currency,
      d.due_at,
      input.assigned_to === undefined ? existing.assigned_to : input.assigned_to,
    ]
  );
  if (!row) throw new Error("Record not found");
  if (Object.keys(diff).length) {
    await addActivity(dataId, id, {
      kind: "updated",
      actorId: input.actorId ?? null,
      body: `Updated ${Object.keys(diff).join(", ")}`,
      diff,
    });
  }
  return recordFromRow(row);
}

export async function moveRecord(
  dataId: string,
  type: RecordType,
  id: string,
  stage: string,
  actorId: string | null = null
): Promise<RecordItem> {
  const existing = await getRecord(dataId, id);
  if (!existing || existing.type_id !== type.id) throw new Error("Record not found");
  const next = resolveStage(type.stages, stage);
  if (next === existing.stage) return existing;
  const row = await queryOne<RecordRow>(
    `UPDATE records SET stage = $3, updated_at = NOW() WHERE id = $1 AND user_id = $2 RETURNING ${RECORD_COLS}`,
    [id, dataId, next]
  );
  if (!row) throw new Error("Record not found");
  const label = (k: string) => type.stages.find((s) => s.key === k)?.label ?? k;
  await addActivity(dataId, id, {
    kind: "moved",
    actorId,
    body: `Moved from ${label(existing.stage)} to ${label(next)}`,
    diff: { stage: { from: existing.stage, to: next } },
  });
  void emitEvent(dataId, {
    type: "record.moved",
    entity: "record",
    entityId: id,
    data: { type: type.slug, from: existing.stage, to: next, title: existing.title },
  });
  return recordFromRow(row);
}

export async function softDeleteRecord(dataId: string, type: RecordType, id: string): Promise<boolean> {
  const rows = await query<{ id: string }>(
    `UPDATE records SET deleted_at = NOW(), updated_at = NOW()
      WHERE id = $1 AND user_id = $2 AND type_id = $3 AND deleted_at IS NULL RETURNING id`,
    [id, dataId, type.id]
  );
  return rows.length > 0;
}

/* ─── Activity + links ─────────────────────────────────────────────────── */

export interface AddActivityInput {
  kind: ActivityKind;
  actorId?: string | null;
  body?: string | null;
  diff?: Record<string, unknown> | null;
}

export async function addActivity(dataId: string, recordId: string, input: AddActivityInput): Promise<ActivityRow> {
  const id = randomUUID();
  const row = await queryOne<ActivityRow>(
    `INSERT INTO record_activity (id, user_id, record_id, actor_id, kind, body, diff)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id, record_id, actor_id, kind, body, diff, created_at`,
    [id, dataId, recordId, input.actorId ?? null, input.kind, input.body?.slice(0, 8000) ?? null, input.diff ? JSON.stringify(input.diff) : null]
  );
  if (!row) throw new Error("Insert returned no row");
  return row;
}

export async function listActivity(dataId: string, recordId: string, limit = 100): Promise<ActivityRow[]> {
  return query<ActivityRow>(
    `SELECT id, record_id, actor_id, kind, body, diff, created_at FROM record_activity
      WHERE user_id = $1 AND record_id = $2 ORDER BY created_at DESC LIMIT $3`,
    [dataId, recordId, Math.min(Math.max(limit, 1), 500)]
  );
}

export async function link(
  dataId: string,
  recordId: string,
  targetKind: LinkKind,
  targetId: string,
  actorId: string | null = null
): Promise<LinkRow> {
  const existing = await queryOne<LinkRow>(
    `SELECT id, record_id, target_kind, target_id, created_at FROM record_links
      WHERE user_id = $1 AND record_id = $2 AND target_kind = $3 AND target_id = $4`,
    [dataId, recordId, targetKind, targetId]
  );
  if (existing) return existing;
  const id = randomUUID();
  const row = await queryOne<LinkRow>(
    `INSERT INTO record_links (id, user_id, record_id, target_kind, target_id)
     VALUES ($1,$2,$3,$4,$5) RETURNING id, record_id, target_kind, target_id, created_at`,
    [id, dataId, recordId, targetKind, targetId.slice(0, 200)]
  );
  if (!row) throw new Error("Insert returned no row");
  await addActivity(dataId, recordId, { kind: "linked", actorId, body: `Linked ${targetKind} ${targetId}` });
  return row;
}

export async function listLinks(dataId: string, recordId: string): Promise<LinkRow[]> {
  return query<LinkRow>(
    `SELECT id, record_id, target_kind, target_id, created_at FROM record_links
      WHERE user_id = $1 AND record_id = $2 ORDER BY created_at DESC LIMIT 200`,
    [dataId, recordId]
  );
}

/** Counts per stage for the board header. */
export async function stageCounts(dataId: string, type: RecordType): Promise<Record<string, number>> {
  const rows = await query<{ stage: string; n: string | number }>(
    `SELECT stage, COUNT(*) AS n FROM records WHERE user_id = $1 AND type_id = $2 AND deleted_at IS NULL GROUP BY stage`,
    [dataId, type.id]
  );
  const out: Record<string, number> = {};
  for (const r of rows) out[r.stage] = Number(r.n);
  return out;
}
