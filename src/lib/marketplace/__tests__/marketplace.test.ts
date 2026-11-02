import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ query: vi.fn(), queryOne: vi.fn() }));
vi.mock("@/lib/dsql", () => ({ query: mocks.query, queryOne: mocks.queryOne, withRetry: (fn: () => unknown) => fn(), transaction: vi.fn() }));
vi.mock("@/lib/agents/queue", () => ({ enqueueJob: vi.fn() }));
vi.mock("@/lib/table-exists", () => ({ tableExists: vi.fn(async () => false) }));

import { AGENT_TEMPLATES } from "@/lib/agent-templates";
import { PACKS } from "@/lib/records/packs";
import { PLAYBOOKS } from "@/lib/agents/playbooks";
import { builtinListings, getBuiltinListing } from "@/lib/marketplace/builtin";
import { listCatalog, getListing } from "@/lib/marketplace/catalog";
import { matchesQuery, parseDefinition, scrubAutomationConfig, slugifyListing, sortListings, type ListingDTO } from "@/lib/marketplace/types";

beforeEach(() => {
  mocks.query.mockReset();
  mocks.queryOne.mockReset();
});

describe("built-in catalog", () => {
  it("lists every agent template, record pack and playbook with a valid definition", () => {
    const all = builtinListings();
    expect(all.filter((l) => l.kind === "agent")).toHaveLength(AGENT_TEMPLATES.length);
    expect(all.filter((l) => l.kind === "pack")).toHaveLength(PACKS.length);
    expect(all.filter((l) => l.kind === "playbook")).toHaveLength(PLAYBOOKS.length);
    expect(new Set(all.map((l) => l.id)).size).toBe(all.length);
    for (const l of all) {
      expect(l.builtin).toBe(true);
      expect(l.visibility).toBe("public");
      expect(l.id.startsWith(`builtin:${l.kind}:`)).toBe(true);
      expect(() => parseDefinition(l.kind, l.definition)).not.toThrow();
      expect(l.description_md).toBeTruthy();
    }
  });

  it("returns copies so callers cannot mutate the cache", () => {
    const a = getBuiltinListing("builtin:pack:healthcare")!;
    a.tags.push("mutated");
    a.title = "x";
    const b = getBuiltinListing("builtin:pack:healthcare")!;
    expect(b.title).toBe("Healthcare");
    expect(b.tags).not.toContain("mutated");
  });

  it("serves the catalog from code alone before the marketplace tables exist", async () => {
    const rows = await listCatalog("org-1", { kind: "pack", q: "health" });
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((l) => l.kind === "pack")).toBe(true);
    expect(rows.some((l) => l.id === "builtin:pack:healthcare")).toBe(true);
    expect(mocks.query).not.toHaveBeenCalled();
    expect(await getListing("org-1", "builtin:agent:lead-generator")).toMatchObject({ kind: "agent", title: "Lead Generator" });
    expect(await getListing("org-1", "nope")).toBeNull();
  });
});

describe("definitions and scrubbing", () => {
  it("drops endpoints, recipients and ids from automation configs but keeps templates", () => {
    const { config, removed } = scrubAutomationConfig({
      webhook_url: "https://hooks.slack.com/services/T000/B000/XXXX",
      url: "https://example.com/hook",
      to: "ceo@example.com",
      agent_id: "6b2c8a7e-1b1c-4c1a-9b7a-9d7e0b2c4f10",
      entity_id: "abc",
      subject: "Daily {{workflow}}",
      message: "Card {{task_title}} moved to {{to_column}}",
      prompt: "Summarise the day",
      deliver_via: ["notification", 42, "email"],
      playbook_id: "stalled-deal",
      api_key: "sk-live-abcdefghijklmnopqrstuvwxyz0123456789",
    });
    expect(config).toEqual({ subject: "Daily {{workflow}}", message: "Card {{task_title}} moved to {{to_column}}", prompt: "Summarise the day", deliver_via: ["notification", "email"], playbook_id: "stalled-deal" });
    expect(removed.sort()).toEqual(["agent_id", "api_key", "entity_id", "to", "url", "webhook_url"]);
  });

  it("drops an allowlisted template that smuggles a URL or token", () => {
    const { config, removed } = scrubAutomationConfig({ message: "ping https://evil.example/x", subject: "ok" });
    expect(config).toEqual({ subject: "ok" });
    expect(removed).toEqual(["message"]);
    expect(scrubAutomationConfig(null)).toEqual({ config: {}, removed: [] });
  });

  it("validates definitions per kind", () => {
    expect(() => parseDefinition("agent", { name: "A", role: "R", system_prompt: null, tools: ["crm.search_contacts"], autonomy_level: "auto", model: null, max_steps: null })).not.toThrow();
    expect(() => parseDefinition("agent", { name: "A", role: "R", system_prompt: null, tools: ["not a tool"], autonomy_level: "auto", model: null, max_steps: null })).toThrow();
    expect(() => parseDefinition("playbook", { playbook_id: "" })).toThrow();
    expect(() => parseDefinition("pack", { slug: "x", name: "X", description: "", icon: "box", recordTypes: [] })).toThrow();
  });

  it("slugifies titles", () => {
    expect(slugifyListing("  Lead Follow-Up  v2! ")).toBe("lead-follow-up-v2");
  });
});

describe("search and sort", () => {
  const mk = (over: Partial<ListingDTO>): ListingDTO => ({
    id: over.id ?? "x",
    kind: "agent",
    slug: "x",
    title: "Title",
    summary: null,
    description_md: null,
    category: null,
    tags: [],
    definition: null,
    version: 1,
    visibility: "public",
    install_count: 0,
    rating_sum: 0,
    rating_count: 0,
    rating_avg: null,
    builtin: false,
    publisher: "community",
    owner: false,
    installed: false,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    published_at: null,
    ...over,
  });

  it("matches every token across title, summary, tags and category", () => {
    const l = mk({ title: "Lead Generator", summary: "Finds leads", tags: ["sales", "outreach"], category: "sales" });
    expect(matchesQuery(l, "lead sales")).toBe(true);
    expect(matchesQuery(l, "OUTREACH")).toBe(true);
    expect(matchesQuery(l, "lead support")).toBe(false);
    expect(matchesQuery(l, "   ")).toBe(true);
  });

  it("sorts by installs, rating, recency and title", () => {
    const a = mk({ id: "a", title: "B", install_count: 5, rating_avg: 3, rating_count: 2, published_at: "2026-02-01T00:00:00.000Z" });
    const b = mk({ id: "b", title: "A", install_count: 9, rating_avg: 5, rating_count: 1, published_at: "2026-01-15T00:00:00.000Z" });
    const c = mk({ id: "c", title: "C", install_count: 9, rating_avg: null, rating_count: 0, published_at: "2026-03-01T00:00:00.000Z" });
    expect(sortListings([a, b, c], "popular").map((x) => x.id)).toEqual(["b", "c", "a"]);
    expect(sortListings([a, b, c], "rating").map((x) => x.id)).toEqual(["b", "a", "c"]);
    expect(sortListings([a, b, c], "newest").map((x) => x.id)).toEqual(["c", "a", "b"]);
    expect(sortListings([a, b, c], "title").map((x) => x.id)).toEqual(["b", "a", "c"]);
  });
});
