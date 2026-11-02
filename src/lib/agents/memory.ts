import { randomUUID } from "crypto";
import { query, queryOne } from "@/lib/dsql";
import { likeContains } from "@/lib/like";
import { CORRECTION_FILE_PREFIX, deleteFile, searchChunks, upsertChunks } from "@/lib/pinecone";

/**
 * Corrections-as-memory.
 *
 * Every time an operator fixes what an agent proposed (editing an approval's
 * payload, or adding a manual correction) we store the before/after pair in
 * `agent_corrections` and embed it in Pinecone under the file id
 * `corr:<id>`. At run time `recallCorrections` pulls the top-k most relevant
 * ones (vector search, ILIKE fallback, recency fallback) and
 * `formatCorrectionsBlock` renders them into the agent's system prompt.
 */

export interface CorrectionMemory {
  id: string;
  agent_id: string;
  run_id: string | null;
  step_id: string | null;
  original: string;
  corrected: string;
  note: string | null;
  embedding_ref: string | null;
  created_at: string;
}

interface CorrectionRow {
  id: string;
  agent_id: string;
  run_id?: string | null;
  step_id?: string | null;
  original_text: string;
  corrected_text: string;
  note?: string | null;
  context?: string | null;
  embedding_ref?: string | null;
  created_at: string;
}

export { CORRECTION_FILE_PREFIX };
const MAX_FIELD = 4000;

export function toCorrectionMemory(r: CorrectionRow): CorrectionMemory {
  return {
    id: r.id,
    agent_id: r.agent_id,
    run_id: r.run_id ?? null,
    step_id: r.step_id ?? null,
    original: r.original_text,
    corrected: r.corrected_text,
    note: r.note ?? r.context ?? null,
    embedding_ref: r.embedding_ref ?? null,
    created_at: r.created_at,
  };
}

/** Text that gets embedded; also what ILIKE matches against conceptually. */
export function correctionText(c: { original: string; corrected: string; note?: string | null }): string {
  const parts = [`Instead of: ${c.original}`, `Do: ${c.corrected}`];
  if (c.note?.trim()) parts.push(`Note: ${c.note.trim()}`);
  return parts.join("\n");
}

function clip(s: string, max = 600): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

/** The system-prompt block. Empty string when there is nothing to say. */
export function formatCorrectionsBlock(items: ReadonlyArray<Pick<CorrectionMemory, "original" | "corrected" | "note">>): string {
  if (items.length === 0) return "";
  let block = "\n\n## Past corrections from your operator\n";
  block += "Your operator corrected earlier work. Apply these preferences whenever they are relevant; do not repeat the original mistake.\n";
  items.forEach((c, i) => {
    block += `\n${i + 1}. Instead of: ${clip(c.original)}\n   Do: ${clip(c.corrected)}`;
    if (c.note?.trim()) block += `\n   Why: ${clip(c.note, 300)}`;
  });
  return block + "\n";
}

/** A handful of distinctive words from the task, for the ILIKE fallback. */
export function keywordsFor(text: string | null | undefined, max = 3): string[] {
  if (!text) return [];
  const stop = new Set(["the", "and", "for", "with", "that", "this", "from", "into", "your", "about", "have", "will", "please", "today", "daily"]);
  const words = text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 4 && !stop.has(w));
  const uniq = Array.from(new Set(words)).sort((a, b) => b.length - a.length);
  return uniq.slice(0, max);
}

async function loadByIds(userId: string, agentId: string, ids: string[]): Promise<CorrectionMemory[]> {
  if (ids.length === 0) return [];
  const placeholders = ids.map((_, i) => `$${i + 3}`).join(", ");
  const rows = await query<CorrectionRow>(
    `SELECT * FROM agent_corrections WHERE user_id = $1 AND agent_id = $2 AND id IN (${placeholders})`,
    [userId, agentId, ...ids]
  );
  const byId = new Map(rows.map((r) => [r.id, toCorrectionMemory(r)]));
  return ids.map((id) => byId.get(id)).filter((c): c is CorrectionMemory => Boolean(c));
}

/**
 * Top-k corrections for an agent, most relevant to `task` first.
 * Order of attempts: Pinecone → ILIKE on task keywords → most recent.
 */
export async function recallCorrections(userId: string, agentId: string, k = 5, task?: string | null): Promise<CorrectionMemory[]> {
  const limit = Math.min(Math.max(k, 1), 20);

  if (task?.trim()) {
    try {
      const hits = await searchChunks(userId, task.slice(0, 2000), limit * 4, { includeCorrections: true });
      const ids = Array.from(
        new Set(hits.filter((h) => h.fileId.startsWith(CORRECTION_FILE_PREFIX)).map((h) => h.fileId.slice(CORRECTION_FILE_PREFIX.length)))
      );
      if (ids.length > 0) {
        const found = await loadByIds(userId, agentId, ids);
        if (found.length > 0) return found.slice(0, limit);
      }
    } catch {
      /* Pinecone unavailable → fall back */
    }

    const words = keywordsFor(task);
    if (words.length > 0) {
      const conds = words.map((_, i) => `(original_text ILIKE $${i + 4} OR corrected_text ILIKE $${i + 4})`).join(" OR ");
      const rows = await query<CorrectionRow>(
        `SELECT * FROM agent_corrections WHERE user_id = $1 AND agent_id = $2 AND (${conds})
         ORDER BY created_at DESC LIMIT $3`,
        [userId, agentId, limit, ...words.map(likeContains)]
      ).catch(() => [] as CorrectionRow[]);
      if (rows.length > 0) return rows.map(toCorrectionMemory);
    }
  }

  const rows = await query<CorrectionRow>(
    `SELECT * FROM agent_corrections WHERE user_id = $1 AND agent_id = $2 ORDER BY created_at DESC LIMIT $3`,
    [userId, agentId, limit]
  ).catch(() => [] as CorrectionRow[]);
  return rows.map(toCorrectionMemory);
}

export interface RememberCorrectionInput {
  agentId: string;
  runId?: string | null;
  stepId?: string | null;
  original: string;
  corrected: string;
  note?: string | null;
}

/** Store a correction and embed it. Embedding failures are logged, never thrown. */
export async function rememberCorrection(userId: string, input: RememberCorrectionInput): Promise<CorrectionMemory> {
  const id = randomUUID();
  const original = input.original.slice(0, MAX_FIELD);
  const corrected = input.corrected.slice(0, MAX_FIELD);
  const note = input.note?.trim().slice(0, 1000) || null;
  await query(
    `INSERT INTO agent_corrections (id, user_id, agent_id, run_id, step_id, original_text, corrected_text, context, note)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8)`,
    [id, userId, input.agentId, input.runId ?? null, input.stepId ?? null, original, corrected, note]
  );

  let embeddingRef: string | null = null;
  try {
    const fileId = `${CORRECTION_FILE_PREFIX}${id}`;
    await upsertChunks(userId, [
      { id: `${fileId}:0`, chunk_text: correctionText({ original, corrected, note }), file_id: fileId, file_name: `correction ${id}`, user_id: userId },
    ]);
    embeddingRef = fileId;
    await query(`UPDATE agent_corrections SET embedding_ref = $2 WHERE id = $1`, [id, fileId]).catch(() => undefined);
  } catch (err) {
    console.warn("[memory] correction embedding skipped:", err instanceof Error ? err.message : err);
  }

  const row = await queryOne<CorrectionRow>(`SELECT * FROM agent_corrections WHERE id = $1`, [id]).catch(() => null);
  return row
    ? toCorrectionMemory(row)
    : { id, agent_id: input.agentId, run_id: input.runId ?? null, step_id: input.stepId ?? null, original, corrected, note, embedding_ref: embeddingRef, created_at: new Date().toISOString() };
}

export async function listCorrections(userId: string, agentId: string, limit = 50): Promise<CorrectionMemory[]> {
  const rows = await query<CorrectionRow>(
    `SELECT * FROM agent_corrections WHERE user_id = $1 AND agent_id = $2 ORDER BY created_at DESC LIMIT $3`,
    [userId, agentId, Math.min(Math.max(limit, 1), 200)]
  );
  return rows.map(toCorrectionMemory);
}

/** Delete a correction and its vectors. Returns false when it did not exist. */
export async function forgetCorrection(userId: string, agentId: string, id: string): Promise<boolean> {
  const row = await queryOne<{ id: string }>(
    `DELETE FROM agent_corrections WHERE id = $1 AND user_id = $2 AND agent_id = $3 RETURNING id`,
    [id, userId, agentId]
  );
  if (!row) return false;
  await deleteFile(userId, `${CORRECTION_FILE_PREFIX}${id}`).catch(() => undefined);
  return true;
}
