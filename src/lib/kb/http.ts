import { z } from "zod";

/** Zod schemas for the knowledge-base routes. */
export const ArticleBodySchema = z
  .object({
    title: z.string().min(1).max(200),
    body_md: z.string().max(200_000).optional(),
    slug: z.string().max(120).nullable().optional(),
    excerpt: z.string().max(500).nullable().optional(),
    category: z.string().max(100).nullable().optional(),
    tags: z.array(z.string().max(40)).max(30).optional(),
    status: z.enum(["draft", "published"]).optional(),
    is_public: z.boolean().optional(),
    source_ticket_ids: z.array(z.string().max(100)).max(50).optional(),
  })
  .strict();

export const ArticlePatchSchema = ArticleBodySchema.partial();
