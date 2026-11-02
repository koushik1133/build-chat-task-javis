import { searchChunks } from "@/lib/pinecone";
import { getArticlesByIds, listArticles, pineconeConfigured, toPublicArticle, type KbArticleRow, type PublicArticle } from "./articles";

/**
 * Article search. Pinecone (semantic, namespace = dataId, fileId `kb:<id>`)
 * when configured; Postgres ILIKE otherwise. Pinecone failures fall back to
 * ILIKE so search never 500s because of the vector store.
 */

export interface ArticleHit extends PublicArticle {
  status: KbArticleRow["status"];
  is_public: boolean;
  score: number;
  /** Best matching chunk when the hit came from Pinecone. */
  snippet: string | null;
}

function toHit(a: KbArticleRow, score: number, snippet: string | null): ArticleHit {
  return { ...toPublicArticle(a), status: a.status, is_public: a.is_public, score, snippet };
}

export interface SearchOptions {
  /** Only published articles (default true). */
  publishedOnly?: boolean;
  /** Only public articles (help center). */
  publicOnly?: boolean;
}

async function ilikeSearch(dataId: string, q: string, limit: number, opts: SearchOptions): Promise<ArticleHit[]> {
  const rows = await listArticles(dataId, {
    q,
    status: opts.publishedOnly === false ? null : "published",
    publicOnly: opts.publicOnly,
    limit,
  });
  const needle = q.toLowerCase();
  return rows
    .map((a) => {
      const inTitle = a.title.toLowerCase().includes(needle) ? 1 : 0;
      const inExcerpt = a.excerpt?.toLowerCase().includes(needle) ? 0.5 : 0;
      return toHit(a, 0.3 + inTitle * 0.5 + inExcerpt * 0.2, null);
    })
    .sort((x, y) => y.score - x.score);
}

export async function searchArticles(dataId: string, q: string, limit = 10, opts: SearchOptions = {}): Promise<ArticleHit[]> {
  const needle = q.trim().slice(0, 300);
  const cap = Math.min(Math.max(limit, 1), 50);
  if (!needle) return [];

  if (pineconeConfigured()) {
    try {
      const chunks = await searchChunks(dataId, needle, cap * 3);
      const best = new Map<string, { score: number; snippet: string }>();
      for (const c of chunks) {
        if (!c.fileId.startsWith("kb:")) continue;
        const id = c.fileId.slice(3);
        const prev = best.get(id);
        if (!prev || c.score > prev.score) best.set(id, { score: c.score, snippet: c.text.slice(0, 400) });
      }
      if (best.size > 0) {
        const rows = await getArticlesByIds(dataId, [...best.keys()]);
        const hits = rows
          .filter((a) => (opts.publishedOnly === false || a.status === "published") && (!opts.publicOnly || a.is_public))
          .map((a) => {
            const b = best.get(a.id)!;
            return toHit(a, b.score, b.snippet);
          })
          .sort((x, y) => y.score - x.score)
          .slice(0, cap);
        if (hits.length > 0) return hits;
      }
    } catch (err) {
      console.error("[kb] pinecone search failed, falling back to ILIKE:", err);
    }
  }
  return ilikeSearch(dataId, needle, cap, opts);
}
