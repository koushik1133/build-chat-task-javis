import { query, queryOne } from "@/lib/dsql";
import { tableExists } from "@/lib/table-exists";
import { getOrgSettings } from "@/lib/org-settings";
import type { Area } from "@/lib/auth/roles";
import type { FieldDef } from "@/lib/records/types";
import { STATIC_DATASETS, describeDataset, recordTypeIdFromKey, recordsDataset, type Dataset, type DatasetDescription } from "./datasets";
import { compileReport, type CompiledReport, type OutputColumn } from "./compile";
import type { ReportRow } from "./chart";
import type { ReportSpec } from "./spec";

export { compileReport, ReportSpecError } from "./compile";
export type { CompiledReport, OutputColumn } from "./compile";

/** Server side: dataset resolution (incl. per-type records datasets) and execution. */

export class DatasetUnavailableError extends Error {
  constructor(key: string) {
    super(`Dataset ${key} is not available in this workspace`);
    this.name = "DatasetUnavailableError";
  }
}

interface RecordTypeRow { id: string; name: string; fields: string | null }

function parseFields(raw: string | null): FieldDef[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw) as unknown;
    return Array.isArray(v) ? (v as FieldDef[]).filter((f) => f && typeof f.key === "string" && typeof f.type === "string") : [];
  } catch {
    return [];
  }
}

/** Resolve a dataset key for an org; records datasets read the type's field list. */
export async function resolveDataset(dataId: string, key: string): Promise<Dataset | null> {
  const typeId = recordTypeIdFromKey(key);
  if (typeId) {
    if (!(await tableExists("record_types"))) return null;
    const row = await queryOne<RecordTypeRow>(`SELECT id, name, fields FROM record_types WHERE user_id = $1 AND (id = $2 OR slug = $2)`, [dataId, typeId]);
    if (!row) return null;
    const ds = recordsDataset({ id: row.id, name: row.name, fields: parseFields(row.fields) });
    return { ...ds, key };
  }
  return STATIC_DATASETS[key] ?? null;
}

/** Catalogue for the builder, filtered by what the caller may view and what exists in this workspace. */
export async function listDatasets(dataId: string, can: (area: Area) => boolean): Promise<DatasetDescription[]> {
  const out: DatasetDescription[] = [];
  const statics = await Promise.all(Object.values(STATIC_DATASETS).map(async (ds) => ((can(ds.area) && (await tableExists(ds.table))) ? ds : null)));
  for (const ds of statics) if (ds) out.push(describeDataset(ds));
  if (can("crm") && (await tableExists("record_types"))) {
    const types = await query<RecordTypeRow>(`SELECT id, name, fields FROM record_types WHERE user_id = $1 ORDER BY name ASC LIMIT 50`, [dataId]).catch(() => []);
    for (const t of types) out.push(describeDataset(recordsDataset({ id: t.id, name: t.name, fields: parseFields(t.fields) })));
  }
  return out;
}

export interface ReportResult {
  dataset: string;
  columns: OutputColumn[];
  rows: ReportRow[];
  totals: ReportRow | null;
  row_count: number;
  truncated: boolean;
  mode: CompiledReport["mode"];
  currency: string;
  timezone: string;
  generated_at: string;
}

function normaliseRow(r: Record<string, unknown>, columns: OutputColumn[]): ReportRow {
  const out: ReportRow = {};
  for (const c of columns) {
    const v = r[c.key];
    if (v instanceof Date) out[c.key] = v.toISOString();
    else if (c.kind === "measure") out[c.key] = v === null || v === undefined ? null : Number(v);
    else if (typeof v === "boolean" || typeof v === "number" || typeof v === "string" || v === null) out[c.key] = v;
    else out[c.key] = v === undefined ? null : String(v);
  }
  return out;
}

/** Run a validated spec for an org. Throws ReportSpecError / DatasetUnavailableError for caller errors. */
export async function runReport(dataId: string, spec: ReportSpec, opts: { dataset?: Dataset | null; now?: Date } = {}): Promise<ReportResult> {
  const ds = opts.dataset ?? (await resolveDataset(dataId, spec.dataset));
  if (!ds) throw new DatasetUnavailableError(spec.dataset);
  if (!(await tableExists(ds.table))) throw new DatasetUnavailableError(spec.dataset);
  const settings = await getOrgSettings(dataId).catch(() => ({ currency: "USD", timezone: "UTC", locale: "en" as const }));
  const recordTypeId = recordTypeIdFromKey(spec.dataset) ? await resolveRecordTypeId(dataId, spec.dataset) : null;
  const compiled = compileReport(ds, spec, { dataId, timeZone: settings.timezone || "UTC", now: opts.now, recordTypeId });
  const [rows, totals] = await Promise.all([
    query<Record<string, unknown>>(compiled.sql, compiled.values),
    compiled.totalsSql ? queryOne<Record<string, unknown>>(compiled.totalsSql, compiled.totalsValues) : Promise.resolve(null),
  ]);
  return {
    dataset: spec.dataset,
    columns: compiled.columns,
    rows: rows.map((r) => normaliseRow(r, compiled.columns)),
    totals: totals ? normaliseRow(totals, compiled.columns.filter((c) => c.kind === "measure")) : null,
    row_count: rows.length,
    truncated: rows.length >= compiled.limit,
    mode: compiled.mode,
    currency: settings.currency || "USD",
    timezone: settings.timezone || "UTC",
    generated_at: new Date().toISOString(),
  };
}

async function resolveRecordTypeId(dataId: string, key: string): Promise<string | null> {
  const ref = recordTypeIdFromKey(key);
  if (!ref) return null;
  const row = await queryOne<{ id: string }>(`SELECT id FROM record_types WHERE user_id = $1 AND (id = $2 OR slug = $2)`, [dataId, ref]);
  return row?.id ?? null;
}
