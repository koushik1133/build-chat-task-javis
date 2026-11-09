import { keysetClause, keysetOrder, type Cursor } from "@/lib/public-api/pagination";
import { randomUUID } from "crypto";
import { query, queryOne } from "@/lib/dsql";

/** Reusable email / SMS content with `{{merge}}` fields. */

export interface TemplateRow {
  id: string;
  user_id: string;
  name: string;
  subject: string;
  preheader: string | null;
  body_md: string;
  category: string;
  created_at: string;
  updated_at: string;
}

const COLS = `id, user_id, name, subject, preheader, body_md, category, created_at, updated_at`;

export interface TemplateInput {
  name: string;
  subject?: string | null;
  preheader?: string | null;
  body_md: string;
  category?: string | null;
}

export async function listTemplates(dataId: string, opts: { category?: string | null; cursor?: Cursor | null; limit?: number } = {}): Promise<TemplateRow[]> {
  const params: unknown[] = [dataId];
  let where = `user_id = $1`;
  if (opts.category) {
    params.push(opts.category);
    where += ` AND category = $${params.length}`;
  }
  where += keysetClause(opts.cursor, params);
  params.push(Math.min(Math.max(opts.limit ?? 200, 1), 201));
  return query<TemplateRow>(`SELECT ${COLS} FROM email_templates WHERE ${where} ORDER BY ${keysetOrder()} LIMIT $${params.length}`, params);
}

export async function getTemplate(dataId: string, id: string): Promise<TemplateRow | null> {
  return queryOne<TemplateRow>(`SELECT ${COLS} FROM email_templates WHERE user_id = $1 AND id = $2`, [dataId, id]);
}

export async function createTemplate(dataId: string, input: TemplateInput): Promise<TemplateRow> {
  const row = await queryOne<TemplateRow>(
    `INSERT INTO email_templates (id, user_id, name, subject, preheader, body_md, category, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), NOW()) RETURNING ${COLS}`,
    [randomUUID(), dataId, input.name.trim(), (input.subject ?? "").trim(), input.preheader?.trim() || null, input.body_md, input.category?.trim() || "general"]
  );
  if (!row) throw new Error("template insert returned no row");
  return row;
}

export async function updateTemplate(dataId: string, id: string, patch: Partial<TemplateInput>): Promise<TemplateRow | null> {
  const cur = await getTemplate(dataId, id);
  if (!cur) return null;
  return queryOne<TemplateRow>(
    `UPDATE email_templates SET name = $3, subject = $4, preheader = $5, body_md = $6, category = $7, updated_at = NOW() WHERE user_id = $1 AND id = $2 RETURNING ${COLS}`,
    [
      dataId,
      id,
      (patch.name ?? cur.name).trim(),
      (patch.subject === undefined ? cur.subject : (patch.subject ?? "")).trim(),
      patch.preheader === undefined ? cur.preheader : patch.preheader?.trim() || null,
      patch.body_md ?? cur.body_md,
      patch.category === undefined ? cur.category : patch.category?.trim() || "general",
    ]
  );
}

export async function deleteTemplate(dataId: string, id: string): Promise<boolean> {
  const row = await queryOne<{ id: string }>(`DELETE FROM email_templates WHERE user_id = $1 AND id = $2 RETURNING id`, [dataId, id]);
  return Boolean(row);
}
