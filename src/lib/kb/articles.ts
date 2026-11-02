import { randomUUID } from "crypto";
import { query, queryOne } from "@/lib/dsql";
import { complete } from "@/lib/llm";
import { deleteFile, upsertChunks } from "@/lib/pinecone";
import { excerptFromMarkdown, isValidSlug, slugify, uniqueSlug } from "./slug";

/**
 * Knowledge base articles. Rows are keyed by `user_id` = the org's dataId.
 *
 * Published articles are mirrored into Pinecone (fileId `kb:<articleId>`,
 * namespace = dataId) when PINECONE_API_KEY is configured so `kb.search` and
 * the copilots can retrieve them semantically. Indexing is best-effort: a
 * Pinecone outage never blocks a save.
 */

export type ArticleStatus = "draft" | "published";

export interface KbArticleRow {
  id: string;
  user_id: string;
  slug: string;
  title: string;
  body_md: string;
  excerpt: string | null;
  category: string | null;
  tags: string;
  status: ArticleStatus;
  is_public: boolean;
  views: number;
  source_ticket_ids: string;
  created_at: string;
  updated_at: string;
  published_at: string | null;
}

export interface KbCategoryRow {
  id: string;
  user_id: string;
  slug: string;
  name: string;
  sort: number;
}

export const ARTICLE_COLS = `id, user_id, slug, title, body_md, excerpt, category, tags, status, is_public, views, source_ticket_ids, created_at, updated_at, published_at`;
const CATEGORY_COLS = `id, user_id, slug, name, sort`;

export { slugify } from "./slug";

export function parseJsonArray(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const v: unknown = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((t): t is string => typeof t === "string") : [];
  } catch {
    return [];
  }
}

export function pineconeConfigured(): boolean {
  return Boolean(process.env.PINECONE_API_KEY?.trim());
}

/* ───────────────────────── indexing ───────────────────────── */

const CHUNK_CHARS = 1500;

function chunkMarkdown(md: string): string[] {
  const paras = md.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  const chunks: string[] = [];
  let cur = "";
  for (const p of paras) {
    if ((cur + "\n\n" + p).length > CHUNK_CHARS && cur) {
      chunks.push(cur);
      cur = p;
    } else {
      cur = cur ? `${cur}\n\n${p}` : p;
    }
  }
  if (cur) chunks.push(cur);
  return chunks.length ? chunks : [md.slice(0, CHUNK_CHARS)];
}

export function kbFileId(articleId: string): string {
  return `kb:${articleId}`;
}

/** Mirror a published article into Pinecone; remove it when unpublished. Never throws. */
export async function syncArticleIndex(article: KbArticleRow): Promise<void> {
  if (!pineconeConfigured()) return;
  const fileId = kbFileId(article.id);
  try {
    await deleteFile(article.user_id, fileId);
    if (article.status !== "published") return;
    const chunks = chunkMarkdown(`${article.title}\n\n${article.body_md}`);
    await upsertChunks(
      article.user_id,
      chunks.map((text, i) => ({
        id: `${fileId}:${i}`,
        chunk_text: text,
        file_id: fileId,
        file_name: article.title,
        user_id: article.user_id,
      }))
    );
  } catch (err) {
    console.error(`[kb] index sync failed for ${article.id}:`, err);
  }
}

/* ───────────────────────── categories ───────────────────────── */

export async function listCategories(dataId: string): Promise<KbCategoryRow[]> {
  return query<KbCategoryRow>(`SELECT ${CATEGORY_COLS} FROM kb_categories WHERE user_id = $1 ORDER BY sort ASC, name ASC`, [dataId]);
}

export async function upsertCategory(dataId: string, input: { name: string; slug?: string; sort?: number }): Promise<KbCategoryRow> {
  const name = input.name.trim().slice(0, 100);
  if (!name) throw new Error("category name is required");
  const slug = input.slug && isValidSlug(input.slug) ? input.slug : slugify(name, 60);
  const existing = await queryOne<KbCategoryRow>(`SELECT ${CATEGORY_COLS} FROM kb_categories WHERE user_id = $1 AND slug = $2`, [dataId, slug]);
  if (existing) {
    await query(`UPDATE kb_categories SET name = $3, sort = $4 WHERE user_id = $1 AND id = $2`, [dataId, existing.id, name, input.sort ?? existing.sort]);
    return { ...existing, name, sort: input.sort ?? existing.sort };
  }
  const id = randomUUID();
  await query(`INSERT INTO kb_categories (id, user_id, slug, name, sort) VALUES ($1, $2, $3, $4, $5)`, [id, dataId, slug, name, input.sort ?? 0]);
  return { id, user_id: dataId, slug, name, sort: input.sort ?? 0 };
}

export async function deleteCategory(dataId: string, id: string): Promise<void> {
  const row = await queryOne<KbCategoryRow>(`SELECT ${CATEGORY_COLS} FROM kb_categories WHERE user_id = $1 AND id = $2`, [dataId, id]);
  if (!row) return;
  await query(`UPDATE kb_articles SET category = NULL WHERE user_id = $1 AND category = $2`, [dataId, row.slug]);
  await query(`DELETE FROM kb_categories WHERE user_id = $1 AND id = $2`, [dataId, id]);
}

/* ───────────────────────── articles ───────────────────────── */

export interface ListArticlesOptions {
  status?: string | null;
  category?: string | null;
  q?: string | null;
  publicOnly?: boolean;
  limit?: number;
}

export async function listArticles(dataId: string, opts: ListArticlesOptions = {}): Promise<KbArticleRow[]> {
  const where: string[] = ["user_id = $1"];
  const params: unknown[] = [dataId];
  if (opts.status === "draft" || opts.status === "published") {
    params.push(opts.status);
    where.push(`status = $${params.length}`);
  }
  if (opts.publicOnly) where.push(`is_public = TRUE AND status = 'published'`);
  if (opts.category) {
    params.push(opts.category);
    where.push(`category = $${params.length}`);
  }
  const q = opts.q?.trim().slice(0, 200);
  if (q) {
    params.push(`%${q.replace(/[%_\\]/g, "\\$&")}%`);
    where.push(`(title ILIKE $${params.length} OR body_md ILIKE $${params.length} OR excerpt ILIKE $${params.length})`);
  }
  params.push(Math.min(Math.max(opts.limit ?? 100, 1), 500));
  return query<KbArticleRow>(
    `SELECT ${ARTICLE_COLS} FROM kb_articles WHERE ${where.join(" AND ")} ORDER BY updated_at DESC LIMIT $${params.length}`,
    params
  );
}

export async function getArticle(dataId: string, id: string): Promise<KbArticleRow | null> {
  return queryOne<KbArticleRow>(`SELECT ${ARTICLE_COLS} FROM kb_articles WHERE user_id = $1 AND id = $2`, [dataId, id]);
}

export async function getArticleBySlug(dataId: string, slug: string): Promise<KbArticleRow | null> {
  return queryOne<KbArticleRow>(`SELECT ${ARTICLE_COLS} FROM kb_articles WHERE user_id = $1 AND slug = $2`, [dataId, slug]);
}

export async function getArticlesByIds(dataId: string, ids: string[]): Promise<KbArticleRow[]> {
  if (ids.length === 0) return [];
  return query<KbArticleRow>(`SELECT ${ARTICLE_COLS} FROM kb_articles WHERE user_id = $1 AND id = ANY($2::text[])`, [dataId, ids]);
}

async function resolveSlug(dataId: string, wanted: string, excludeId?: string): Promise<string> {
  const base = isValidSlug(wanted) ? wanted : slugify(wanted);
  const rows = await query<{ slug: string }>(
    `SELECT slug FROM kb_articles WHERE user_id = $1 AND slug LIKE $2 ${excludeId ? "AND id <> $3" : ""}`,
    excludeId ? [dataId, `${base}%`, excludeId] : [dataId, `${base}%`]
  );
  const taken = new Set(rows.map((r) => r.slug));
  return uniqueSlug(base, (c) => taken.has(c));
}

export interface ArticleInput {
  title: string;
  body_md?: string;
  slug?: string | null;
  excerpt?: string | null;
  category?: string | null;
  tags?: string[];
  status?: ArticleStatus;
  is_public?: boolean;
  source_ticket_ids?: string[];
}

export async function createArticle(dataId: string, input: ArticleInput): Promise<KbArticleRow> {
  const title = input.title.trim().slice(0, 200);
  if (!title) throw new Error("title is required");
  const body = (input.body_md ?? "").slice(0, 200_000);
  const slug = await resolveSlug(dataId, input.slug?.trim() || title);
  const status: ArticleStatus = input.status === "published" ? "published" : "draft";
  const id = randomUUID();
  await query(
    `INSERT INTO kb_articles (id, user_id, slug, title, body_md, excerpt, category, tags, status, is_public, views, source_ticket_ids, published_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 0, $11, CASE WHEN $9 = 'published' THEN NOW() ELSE NULL END)`,
    [
      id,
      dataId,
      slug,
      title,
      body,
      (input.excerpt?.trim() || excerptFromMarkdown(body)).slice(0, 500) || null,
      input.category?.trim().slice(0, 100) || null,
      JSON.stringify((input.tags ?? []).map((t) => t.trim()).filter(Boolean).slice(0, 30)),
      status,
      Boolean(input.is_public),
      JSON.stringify((input.source_ticket_ids ?? []).slice(0, 50)),
    ]
  );
  const row = await getArticle(dataId, id);
  if (!row) throw new Error("article not found after insert");
  if (row.status === "published") void syncArticleIndex(row);
  return row;
}

export async function updateArticle(dataId: string, id: string, patch: Partial<ArticleInput>): Promise<KbArticleRow> {
  const current = await getArticle(dataId, id);
  if (!current) throw new Error("Article not found");
  const title = (patch.title ?? current.title).trim().slice(0, 200) || current.title;
  const body = patch.body_md === undefined ? current.body_md : patch.body_md.slice(0, 200_000);
  const slug = patch.slug && patch.slug.trim() && patch.slug !== current.slug ? await resolveSlug(dataId, patch.slug.trim(), id) : current.slug;
  const status: ArticleStatus = patch.status === undefined ? current.status : patch.status === "published" ? "published" : "draft";
  const excerpt =
    patch.excerpt === undefined
      ? patch.body_md !== undefined && !current.excerpt
        ? excerptFromMarkdown(body)
        : current.excerpt
      : patch.excerpt?.trim() || excerptFromMarkdown(body);
  await query(
    `UPDATE kb_articles SET slug = $3, title = $4, body_md = $5, excerpt = $6, category = $7, tags = $8, status = $9, is_public = $10,
        source_ticket_ids = $11, updated_at = NOW(),
        published_at = CASE WHEN $9 = 'published' THEN COALESCE(published_at, NOW()) ELSE published_at END
     WHERE user_id = $1 AND id = $2`,
    [
      dataId,
      id,
      slug,
      title,
      body,
      excerpt?.slice(0, 500) || null,
      patch.category === undefined ? current.category : patch.category?.trim().slice(0, 100) || null,
      patch.tags ? JSON.stringify(patch.tags.map((t) => t.trim()).filter(Boolean).slice(0, 30)) : current.tags,
      status,
      patch.is_public === undefined ? current.is_public : Boolean(patch.is_public),
      patch.source_ticket_ids ? JSON.stringify(patch.source_ticket_ids.slice(0, 50)) : current.source_ticket_ids,
    ]
  );
  const row = await getArticle(dataId, id);
  if (!row) throw new Error("Article not found");
  const contentChanged = row.title !== current.title || row.body_md !== current.body_md || row.status !== current.status;
  if (contentChanged) void syncArticleIndex(row);
  return row;
}

export async function deleteArticle(dataId: string, id: string): Promise<boolean> {
  const row = await getArticle(dataId, id);
  if (!row) return false;
  await query(`DELETE FROM kb_articles WHERE user_id = $1 AND id = $2`, [dataId, id]);
  if (pineconeConfigured()) deleteFile(dataId, kbFileId(id)).catch(() => undefined);
  return true;
}

/* ───────────────────────── public help center ───────────────────────── */

export interface PublicArticle {
  id: string;
  slug: string;
  title: string;
  excerpt: string | null;
  category: string | null;
  tags: string[];
  views: number;
  published_at: string | null;
  updated_at: string;
}

export interface PublicArticleDetail extends PublicArticle {
  body_md: string;
}

export interface PublicCategory {
  slug: string;
  name: string;
  count: number;
}

export interface HelpCenterOrg {
  id: string;
  name: string;
  slug: string;
  dataId: string;
}

export function toPublicArticle(a: KbArticleRow): PublicArticle {
  return {
    id: a.id,
    slug: a.slug,
    title: a.title,
    excerpt: a.excerpt,
    category: a.category,
    tags: parseJsonArray(a.tags),
    views: Number(a.views ?? 0),
    published_at: a.published_at,
    updated_at: a.updated_at,
  };
}

/** Resolve a public help-center org by `organizations.slug`. */
export async function getHelpCenterOrg(orgSlug: string): Promise<HelpCenterOrg | null> {
  if (!orgSlug || orgSlug.length > 80 || !/^[a-z0-9-]+$/i.test(orgSlug)) return null;
  const row = await queryOne<{ id: string; name: string; slug: string; owner_user_id: string }>(
    `SELECT id, name, slug, owner_user_id FROM organizations WHERE slug = $1`,
    [orgSlug.toLowerCase()]
  );
  return row ? { id: row.id, name: row.name, slug: row.slug, dataId: row.owner_user_id } : null;
}

export async function listPublicArticles(dataId: string, opts: { q?: string | null; category?: string | null } = {}): Promise<{ articles: PublicArticle[]; categories: PublicCategory[] }> {
  const [rows, cats] = await Promise.all([
    listArticles(dataId, { publicOnly: true, q: opts.q, category: opts.category, limit: 200 }),
    listCategories(dataId),
  ]);
  const counts = new Map<string, number>();
  const all = opts.q || opts.category ? await listArticles(dataId, { publicOnly: true, limit: 500 }) : rows;
  for (const a of all) if (a.category) counts.set(a.category, (counts.get(a.category) ?? 0) + 1);
  const named = new Map(cats.map((c) => [c.slug, c.name]));
  const categories: PublicCategory[] = [...counts.entries()]
    .map(([slug, count]) => ({ slug, name: named.get(slug) ?? slug.replace(/-/g, " "), count }))
    .sort((a, b) => {
      const sa = cats.find((c) => c.slug === a.slug)?.sort ?? 999;
      const sb = cats.find((c) => c.slug === b.slug)?.sort ?? 999;
      return sa - sb || a.name.localeCompare(b.name);
    });
  return { articles: rows.map(toPublicArticle), categories };
}

/** Public article by slug; increments `views` (best effort). */
export async function getPublicArticle(dataId: string, slug: string, opts: { countView?: boolean } = {}): Promise<PublicArticleDetail | null> {
  const row = await getArticleBySlug(dataId, slug);
  if (!row || row.status !== "published" || !row.is_public) return null;
  if (opts.countView !== false) {
    query(`UPDATE kb_articles SET views = views + 1 WHERE user_id = $1 AND id = $2`, [dataId, row.id]).catch(() => undefined);
  }
  return { ...toPublicArticle(row), body_md: row.body_md };
}

/* ───────────────────────── AI drafting ───────────────────────── */

export interface ArticleDraft {
  title: string;
  body_md: string;
  excerpt: string;
  tags: string[];
  source_ticket_ids: string[];
}

interface TicketForDraft {
  id: string;
  number: number;
  subject: string;
  status: string;
}
interface MsgForDraft {
  ticket_id: string;
  author_kind: string;
  body: string;
  is_internal: boolean;
}

/**
 * Turn one or more resolved tickets into a knowledge-base article draft.
 * Throws LlmNotConfiguredError (→ 503 via llmErrorResponse) when no key is set.
 */
export async function draftArticleFromTickets(dataId: string, ticketIds: string[]): Promise<ArticleDraft> {
  const ids = [...new Set(ticketIds.filter((t) => typeof t === "string" && t.length < 100))].slice(0, 10);
  if (ids.length === 0) throw new Error("ticketIds is required");
  const tickets = await query<TicketForDraft>(
    `SELECT id, number, subject, status FROM tickets WHERE user_id = $1 AND id = ANY($2::text[])`,
    [dataId, ids]
  );
  if (tickets.length === 0) throw new Error("Ticket not found");
  const messages = await query<MsgForDraft>(
    `SELECT ticket_id, author_kind, body, is_internal FROM ticket_messages
     WHERE user_id = $1 AND ticket_id = ANY($2::text[]) AND is_internal = FALSE ORDER BY created_at ASC LIMIT 200`,
    [dataId, tickets.map((t) => t.id)]
  );

  const transcript = tickets
    .map((t) => {
      const lines = messages
        .filter((m) => m.ticket_id === t.id)
        .map((m) => `[${m.author_kind}] ${m.body.slice(0, 1200)}`)
        .join("\n");
      return `Ticket #${t.number} — ${t.subject}\n${lines || "(no messages)"}`;
    })
    .join("\n\n---\n\n")
    .slice(0, 24_000);

  const raw = await complete(
    [
      {
        role: "system",
        content: [
          "You write concise, customer-facing help-center articles from support ticket transcripts.",
          "Never mention ticket numbers, customer names, emails or internal notes. Generalise the problem and give the solution as steps.",
          "Reply with ONLY a JSON object: {\"title\": string, \"excerpt\": string (<=160 chars), \"tags\": string[] (<=5), \"body_md\": string (markdown with ## headings, steps, and a short 'Still stuck?' closing line)}.",
        ].join(" "),
      },
      { role: "user", content: `Write one article that resolves the issue(s) in these tickets:\n\n${transcript}` },
    ],
    { maxTokens: 1800 }
  );

  const cleaned = raw.trim().replace(/^```(?:json)?\s*|```\s*$/g, "");
  let parsed: Partial<ArticleDraft> | null = null;
  try {
    const v: unknown = JSON.parse(cleaned);
    if (v && typeof v === "object") parsed = v as Partial<ArticleDraft>;
  } catch {
    parsed = null;
  }
  const title = (typeof parsed?.title === "string" && parsed.title.trim()) || `How to: ${tickets[0].subject}`.slice(0, 200);
  const body_md = (typeof parsed?.body_md === "string" && parsed.body_md.trim()) || (parsed ? "" : cleaned) || `## ${title}\n\n_Draft could not be generated. Write the steps here._`;
  const excerpt = (typeof parsed?.excerpt === "string" && parsed.excerpt.trim()) || excerptFromMarkdown(body_md, 160);
  const tags = Array.isArray(parsed?.tags) ? parsed.tags.filter((t): t is string => typeof t === "string").slice(0, 5) : [];
  return { title: title.slice(0, 200), body_md, excerpt: excerpt.slice(0, 500), tags, source_ticket_ids: tickets.map((t) => t.id) };
}
