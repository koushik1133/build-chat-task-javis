import { z } from "zod";
import { registerTool } from "@/lib/agents/registry";
import type { ToolResult } from "@/lib/agents/types";
import { listCatalog } from "@/lib/marketplace/catalog";
import { installListing } from "@/lib/marketplace/install";
import { LISTING_KINDS } from "@/lib/marketplace/types";

/** Marketplace tools: find and install agents, playbooks, automations and record packs. */

function fail(error: string): ToolResult {
  return { ok: false, summary: error, error };
}
function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/* ---------- marketplace.search ---------- */
const SearchInput = z.object({
  query: z.string().max(200).optional(),
  kind: z.enum(LISTING_KINDS).optional(),
  category: z.string().max(40).optional(),
  limit: z.number().int().min(1).max(50).optional(),
});
type SearchT = z.infer<typeof SearchInput>;

registerTool<SearchT>({
  name: "marketplace.search",
  module: "marketplace",
  description: "Search the marketplace for agents, playbooks, automations and record packs that could be installed into this workspace. Returns listing ids for marketplace.install.",
  input: SearchInput,
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "Free text, e.g. 'lead follow up' or 'healthcare'" },
      kind: { type: "string", enum: [...LISTING_KINDS] },
      category: { type: "string", description: "sales, marketing, support, operations, finance, content, research, industry, other" },
      limit: { type: "number" },
    },
  },
  scope: "read",
  preview: (i) => `Search marketplace${i.query ? ` for "${i.query}"` : ""}${i.kind ? ` (${i.kind}s)` : ""}`,
  async run(ctx, input) {
    try {
      const rows = await listCatalog(ctx.userId, { q: input.query, kind: input.kind, category: input.category, limit: input.limit ?? 20 });
      const data = rows.map((l) => ({
        id: l.id,
        kind: l.kind,
        title: l.title,
        summary: l.summary,
        category: l.category,
        tags: l.tags,
        publisher: l.publisher,
        installs: l.install_count,
        rating: l.rating_avg,
        installed: l.installed,
      }));
      return { ok: true, data, summary: `${rows.length} listing(s)${rows.length ? `: ${rows.slice(0, 5).map((l) => l.title).join(", ")}` : ""}` };
    } catch (err) {
      return fail(`Search failed: ${errMsg(err)}`);
    }
  },
});

/* ---------- marketplace.install ---------- */
const InstallInput = z.object({ listing_id: z.string().min(1).max(200) });
type InstallT = z.infer<typeof InstallInput>;

registerTool<InstallT>({
  name: "marketplace.install",
  module: "marketplace",
  description: "Install a marketplace listing into this workspace (creates the agent / enables the playbook / adds a paused automation / creates the pack's record types). Idempotent.",
  input: InstallInput,
  parameters: {
    type: "object",
    properties: { listing_id: { type: "string", description: "Listing id from marketplace.search" } },
    required: ["listing_id"],
  },
  scope: "write",
  requiresApproval: true,
  preview: (i) => `Install marketplace listing ${i.listing_id}`,
  async run(ctx, input) {
    try {
      const out = await installListing(ctx.userId, input.listing_id);
      return {
        ok: true,
        data: { listing_id: out.listing.id, title: out.listing.title, entity_kind: out.entityKind, entity_id: out.entityId, created: out.created, note: out.note },
        summary: out.created ? `Installed "${out.listing.title}" (${out.entityKind} ${out.entityId})` : `"${out.listing.title}" was already installed`,
      };
    } catch (err) {
      return fail(`Install failed: ${errMsg(err)}`);
    }
  },
});
