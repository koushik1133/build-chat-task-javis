import { z } from "zod";
import { queryOne } from "@/lib/dsql";
import { registerTool } from "@/lib/agents/registry";
import { searchChunks } from "@/lib/pinecone";
import type { ToolResult } from "@/lib/agents/types";

/** Knowledge tools: RAG over the user's uploaded files + the Business DNA profile. */

function fail(error: string): ToolResult {
  return { ok: false, summary: error, error };
}
function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/* ---------- knowledge.search ---------- */
const SearchInput = z.object({
  query: z.string().min(1).max(500),
  limit: z.number().int().min(1).max(10).optional(),
});
type SearchInputT = z.infer<typeof SearchInput>;

registerTool<SearchInputT>({
  name: "knowledge.search",
  module: "knowledge",
  description: "Semantic search across the user's uploaded files (RAG). Returns matching chunks with file names.",
  input: SearchInput,
  parameters: {
    type: "object",
    properties: { query: { type: "string" }, limit: { type: "integer", minimum: 1, maximum: 10 } },
    required: ["query"],
  },
  scope: "read",
  preview: (i) => `Search files for "${i.query.slice(0, 60)}"`,
  async run(ctx, input) {
    try {
      // searchChunks scopes to the caller's Pinecone namespace (= userId).
      const hits = await searchChunks(ctx.userId, input.query, input.limit ?? 5);
      const data = hits.map((h) => ({ file: h.fileName, fileId: h.fileId, score: h.score, text: h.text.slice(0, 1200) }));
      return { ok: true, data, summary: `${hits.length} chunk(s) matched` };
    } catch (err) {
      return fail(`Knowledge search unavailable: ${errMsg(err)}`);
    }
  },
});

/* ---------- knowledge.business_profile ---------- */
const ProfileInput = z.object({});
type ProfileInputT = z.infer<typeof ProfileInput>;

interface ProfileRow {
  company_name: string;
  industry: string;
  stage: string;
  team_size: string;
  geography: string | null;
  product_desc: string | null;
  target_market: string | null;
  challenge: string | null;
  revenue_range: string | null;
  modules: string;
}

registerTool<ProfileInputT>({
  name: "knowledge.business_profile",
  module: "knowledge",
  description: "Return the user's Business DNA profile from onboarding (company, industry, stage, product, market, challenge).",
  input: ProfileInput,
  parameters: { type: "object", properties: {} },
  scope: "read",
  preview: () => "Read business profile",
  async run(ctx) {
    try {
      const row = await queryOne<ProfileRow>(
        `SELECT company_name, industry, stage, team_size, geography, product_desc, target_market, challenge, revenue_range, modules
         FROM business_profile WHERE user_id = $1`,
        [ctx.userId]
      );
      if (!row) return { ok: true, data: null, summary: "No business profile yet (onboarding incomplete)" };
      let modules: string[] = [];
      try {
        const parsed: unknown = JSON.parse(row.modules || "[]");
        if (Array.isArray(parsed)) modules = parsed.map(String);
      } catch {
        modules = [];
      }
      return { ok: true, data: { ...row, modules }, summary: `Profile for ${row.company_name}` };
    } catch (err) {
      return fail(`Profile lookup failed: ${errMsg(err)}`);
    }
  },
});
