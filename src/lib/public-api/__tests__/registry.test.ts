import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/dsql", () => ({ query: vi.fn(), queryOne: vi.fn(), withRetry: (fn: () => unknown) => fn(), transaction: vi.fn() }));
vi.mock("@/lib/pinecone", () => ({ searchChunks: vi.fn(), upsertChunks: vi.fn(), deleteFile: vi.fn(), CORRECTION_FILE_PREFIX: "corr:" }));

import { ROUTE_LIST, TAGS } from "@/lib/public-api/registry";
import { buildOpenApiDocument } from "@/lib/public-api/openapi";
import { API_SCOPES } from "@/lib/public-api/scopes";
import { listTools } from "@/lib/agents/registry";
import { ensureToolsLoaded } from "@/lib/agents/tools";
import { TOOL_MODULE_AREA, scopeForTool, toolInputSchema } from "@/lib/agents/tool-scopes";

/**
 * Registry hygiene: every /api/v1 route is documented and scoped, every
 * `x-kernelhub-tools` reference resolves to a registered tool, and every
 * write tool is approval-gated or explicitly marked safe.
 */

describe("public API registry", () => {
  const tagNames = new Set(TAGS.map((t) => t.name));

  it("every route has a known tag, a summary and a scope (or is explicitly public)", () => {
    for (const r of ROUTE_LIST) {
      expect(tagNames.has(r.tag), `${r.id}: tag "${r.tag}" missing from TAGS`).toBe(true);
      expect(r.summary.trim().length, `${r.id}: summary`).toBeGreaterThan(3);
      expect(r.scope === null || (API_SCOPES as readonly string[]).includes(r.scope), `${r.id}: scope ${String(r.scope)}`).toBe(true);
      if (r.method !== "GET") expect(r.scope?.startsWith("write:"), `${r.id}: non-GET must need a write scope`).toBe(true);
      expect(r.path.startsWith("/"), r.id).toBe(true);
    }
  });

  it("route ids and method+path pairs are unique", () => {
    const ids = ROUTE_LIST.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    const keys = ROUTE_LIST.map((r) => `${r.method} ${r.path}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("covers the Phase 6 modules", () => {
    const paths = new Set(ROUTE_LIST.map((r) => r.path));
    for (const p of ["/expenses", "/time-entries/start", "/equipment/checkout", "/change-orders/{id}/status", "/sla-policies", "/kb/search", "/marketplace/{id}/install", "/credits/balance", "/privacy/consents", "/privacy/dsr", "/voice/campaigns/{id}/targets", "/mail/accounts", "/accounting/push", "/optimize/pricing", "/agents/runs/{id}", "/approvals/{id}/decide", "/events/{id}"]) {
      expect(paths.has(p), p).toBe(true);
    }
    expect(ROUTE_LIST.length).toBeGreaterThanOrEqual(100);
  });

  it("x-kernelhub-tools names resolve to registered tools and appear in the OpenAPI document", () => {
    ensureToolsLoaded();
    const known = new Set(listTools().map((t) => t.name));
    const doc = buildOpenApiDocument({ serverUrl: "https://app.test/api/v1" });
    const paths = doc.paths as Record<string, Record<string, Record<string, unknown>>>;
    let withTools = 0;
    for (const r of ROUTE_LIST) {
      for (const t of r.tools ?? []) expect(known.has(t), `${r.id} → ${t}`).toBe(true);
      const op = paths[r.path][r.method.toLowerCase()];
      if (r.tools?.length) {
        withTools++;
        expect(op["x-kernelhub-tools"]).toEqual([...r.tools]);
      } else {
        expect(op["x-kernelhub-tools"]).toBeUndefined();
      }
    }
    expect(withTools).toBeGreaterThan(15);
    expect(doc["x-kernelhub-tools"]).toMatchObject({ mcp_endpoint: "https://app.test/api/mcp" });
  });
});

describe("agent tool registry", () => {
  ensureToolsLoaded();
  const tools = listTools();

  it("registers the Phase 6 parity tools", () => {
    const names = new Set(tools.map((t) => t.name));
    for (const n of ["helpdesk.create_ticket", "helpdesk.assign", "helpdesk.set_sla", "kb.create_article", "kb.publish_article", "inventory.adjust_stock", "inventory.checkout", "inventory.checkin", "finance.create_change_order", "calendar.reschedule", "records.delete", "records.link", "agency.rollup", "accounting.push", "home.summary"]) {
      expect(names.has(n), n).toBe(true);
    }
  });

  it("every write tool is approval-gated or explicitly marked safe", () => {
    for (const t of tools) {
      if (t.scope !== "write") continue;
      // `requiresApproval` undefined means "gated by default" (needsApproval falls back to scope === write);
      // `false` is an explicit opt-out that we require to be deliberate: such tools must not send externally.
      expect(t.requiresApproval === undefined || typeof t.requiresApproval === "boolean" || typeof t.requiresApproval === "function", t.name).toBe(true);
      if (t.requiresApproval === false) {
        expect(/send|publish|delete|start_campaign|push/.test(t.name), `${t.name} is marked safe but looks externally visible`).toBe(false);
      }
    }
  });

  it("every tool module maps to an API scope and exposes a JSON schema", () => {
    for (const t of tools) {
      expect(TOOL_MODULE_AREA[t.module], `${t.name}: module ${t.module} has no area`).toBeDefined();
      expect(scopeForTool(t)).toMatch(/^(read|write):[a-z]+$/);
      const schema = toolInputSchema(t);
      expect(schema.type).toBe("object");
      expect(schema.additionalProperties).toBe(false);
      expect(typeof schema.properties).toBe("object");
    }
  });
});
