import { randomUUID } from "crypto";
import { query, queryOne } from "@/lib/dsql";
import { recordAudit } from "@/lib/audit";
import { DOCUMENT_KINDS, type DocumentKind, type DocumentTemplateDTO, type MergeField } from "./types";
import { STARTER_TEMPLATES, findStarter } from "./starters";

/** Document templates: CRUD + starter installation. */

export class DocumentError extends Error {
  constructor(message: string, public readonly status = 400) {
    super(message);
    this.name = "DocumentError";
  }
}

const COLS = `id, name, kind, body_md, fields, requires_signature, signer_roles, version, starter_slug, created_at, updated_at`;

interface Row {
  id: string;
  name: string;
  kind: DocumentKind;
  body_md: string;
  fields: string | null;
  requires_signature: boolean;
  signer_roles: string | null;
  version: number;
  starter_slug: string | null;
  created_at: string | Date;
  updated_at: string | Date;
}

export function parseFields(raw: string | null): MergeField[] {
  if (!raw) return [];
  try {
    const v: unknown = JSON.parse(raw);
    if (!Array.isArray(v)) return [];
    return v
      .filter((f): f is MergeField => Boolean(f) && typeof f === "object" && typeof (f as MergeField).key === "string")
      .map((f) => ({ key: f.key, label: typeof f.label === "string" ? f.label : f.key, source: f.source === "contact" || f.source === "org" ? f.source : "custom", required: Boolean(f.required) }));
  } catch {
    return [];
  }
}

function parseRoles(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const v: unknown = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function toDto(r: Row): DocumentTemplateDTO {
  return {
    id: r.id,
    name: r.name,
    kind: DOCUMENT_KINDS.includes(r.kind) ? r.kind : "other",
    body_md: r.body_md,
    fields: parseFields(r.fields),
    requires_signature: Boolean(r.requires_signature),
    signer_roles: parseRoles(r.signer_roles),
    version: Number(r.version),
    starter_slug: r.starter_slug,
    created_at: new Date(r.created_at).toISOString(),
    updated_at: new Date(r.updated_at).toISOString(),
  };
}

export async function listTemplates(dataId: string): Promise<DocumentTemplateDTO[]> {
  const rows = await query<Row>(`SELECT ${COLS} FROM document_templates WHERE user_id = $1 ORDER BY name ASC LIMIT 500`, [dataId]);
  return rows.map(toDto);
}

export async function getTemplate(dataId: string, id: string): Promise<DocumentTemplateDTO | null> {
  const row = await queryOne<Row>(`SELECT ${COLS} FROM document_templates WHERE user_id = $1 AND id = $2`, [dataId, id]);
  return row ? toDto(row) : null;
}

export interface TemplateInput {
  name: string;
  kind?: DocumentKind;
  body_md?: string;
  fields?: MergeField[];
  requires_signature?: boolean;
  signer_roles?: string[];
}

export async function createTemplate(dataId: string, input: TemplateInput, actorId?: string | null, starterSlug: string | null = null): Promise<DocumentTemplateDTO> {
  const id = randomUUID();
  const row = await queryOne<Row>(
    `INSERT INTO document_templates (id, user_id, name, kind, body_md, fields, requires_signature, signer_roles, version, starter_slug)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 1, $9) RETURNING ${COLS}`,
    [id, dataId, input.name.trim(), input.kind ?? "other", input.body_md ?? "", JSON.stringify(input.fields ?? []), input.requires_signature ?? true, JSON.stringify(input.signer_roles ?? []), starterSlug]
  );
  if (!row) throw new Error("template insert returned no row");
  void recordAudit({ dataId, userId: actorId ?? null }, { action: "document_template.created", entity: "document_template", entityId: id, after: { name: input.name, kind: input.kind ?? "other" } });
  return toDto(row);
}

export async function updateTemplate(dataId: string, id: string, patch: Partial<TemplateInput>, actorId?: string | null): Promise<DocumentTemplateDTO> {
  const before = await getTemplate(dataId, id);
  if (!before) throw new DocumentError("Template not found", 404);
  const sets: string[] = [];
  const values: unknown[] = [dataId, id];
  const set = (col: string, v: unknown) => {
    values.push(v);
    sets.push(`${col} = $${values.length}`);
  };
  if (patch.name !== undefined) set("name", patch.name.trim());
  if (patch.kind !== undefined) set("kind", patch.kind);
  if (patch.body_md !== undefined) set("body_md", patch.body_md);
  if (patch.fields !== undefined) set("fields", JSON.stringify(patch.fields));
  if (patch.requires_signature !== undefined) set("requires_signature", patch.requires_signature);
  if (patch.signer_roles !== undefined) set("signer_roles", JSON.stringify(patch.signer_roles));
  if (sets.length === 0) return before;
  if (patch.body_md !== undefined && patch.body_md !== before.body_md) sets.push("version = version + 1");
  sets.push("updated_at = NOW()");
  const row = await queryOne<Row>(`UPDATE document_templates SET ${sets.join(", ")} WHERE user_id = $1 AND id = $2 RETURNING ${COLS}`, values);
  if (!row) throw new DocumentError("Template not found", 404);
  void recordAudit({ dataId, userId: actorId ?? null }, { action: "document_template.updated", entity: "document_template", entityId: id, before: { version: before.version }, after: { version: row.version } });
  return toDto(row);
}

export async function deleteTemplate(dataId: string, id: string, actorId?: string | null): Promise<boolean> {
  const rows = await query<{ id: string }>(`DELETE FROM document_templates WHERE user_id = $1 AND id = $2 RETURNING id`, [dataId, id]);
  if (rows.length) void recordAudit({ dataId, userId: actorId ?? null }, { action: "document_template.deleted", entity: "document_template", entityId: id });
  return rows.length > 0;
}

/** Install built-in starters (all, or the named slugs). Idempotent per slug. */
export async function installStarters(dataId: string, slugs: string[] | null, actorId?: string | null): Promise<{ installed: DocumentTemplateDTO[]; skipped: string[] }> {
  const wanted = slugs ? slugs.map(findStarter).filter((s): s is NonNullable<typeof s> => Boolean(s)) : [...STARTER_TEMPLATES];
  const existing = await query<{ starter_slug: string }>(`SELECT starter_slug FROM document_templates WHERE user_id = $1 AND starter_slug IS NOT NULL`, [dataId]);
  const have = new Set(existing.map((e) => e.starter_slug));
  const installed: DocumentTemplateDTO[] = [];
  const skipped: string[] = [];
  for (const s of wanted) {
    if (have.has(s.slug)) {
      skipped.push(s.slug);
      continue;
    }
    installed.push(await createTemplate(dataId, { name: s.name, kind: s.kind, body_md: s.body_md, fields: s.fields, requires_signature: s.requires_signature, signer_roles: s.signer_roles }, actorId, s.slug));
  }
  return { installed, skipped };
}

export { STARTER_TEMPLATES };
