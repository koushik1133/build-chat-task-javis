import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

vi.mock("@/lib/dsql", () => ({ query: vi.fn(), queryOne: vi.fn(), withRetry: (fn: () => unknown) => fn(), transaction: vi.fn() }));

import { buildOpenApiDocument, zodToJsonSchema } from "@/lib/public-api/openapi";
import { ROUTES, ROUTE_LIST } from "@/lib/public-api/registry";

describe("zodToJsonSchema", () => {
  it("converts the subset used by the registry", () => {
    const schema = z
      .object({
        name: z.string().min(1).max(10).describe("Name"),
        email: z.string().email().nullable().optional(),
        qty: z.number().int().min(0).max(5),
        kind: z.enum(["a", "b"]).default("a"),
        tags: z.array(z.string()).max(3),
        meta: z.record(z.unknown()),
        flag: z.boolean(),
        when: z.coerce.number().optional(),
      })
      .strict();
    const js = zodToJsonSchema(schema);
    expect(js).toMatchObject({
      type: "object",
      additionalProperties: false,
      required: ["name", "qty", "tags", "meta", "flag"],
      properties: {
        name: { type: "string", minLength: 1, maxLength: 10, description: "Name" },
        email: { type: ["string", "null"], format: "email" },
        qty: { type: "integer", minimum: 0, maximum: 5 },
        kind: { type: "string", enum: ["a", "b"], default: "a" },
        tags: { type: "array", items: { type: "string" }, maxItems: 3 },
        meta: { type: "object", additionalProperties: {} },
        flag: { type: "boolean" },
        when: { type: "number" },
      },
    });
  });
  it("never throws on unknown schema kinds", () => {
    expect(zodToJsonSchema(z.any())).toEqual({});
    expect(zodToJsonSchema(z.promise(z.string()))).toEqual({});
  });
});

describe("buildOpenApiDocument", () => {
  const doc = buildOpenApiDocument({ serverUrl: "https://app.test/api/v1" });
  const paths = doc.paths as Record<string, Record<string, Record<string, unknown>>>;

  it("is a 3.1 document with every registry route and no drift", () => {
    expect(doc.openapi).toBe("3.1.0");
    expect((doc.servers as Array<{ url: string }>)[0].url).toBe("https://app.test/api/v1");
    const ops = Object.values(paths).flatMap((p) => Object.values(p));
    expect(ops).toHaveLength(ROUTE_LIST.length);
    for (const r of ROUTE_LIST) {
      expect(paths[r.path]?.[r.method.toLowerCase()], `${r.method} ${r.path}`).toBeDefined();
    }
    const ids = ops.map((o) => o.operationId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("documents auth, scope, pagination and idempotency per operation", () => {
    const list = paths["/contacts"].get;
    expect(list.security).toEqual([{ bearerAuth: [] }]);
    expect(list["x-scope"]).toBe("read:crm");
    const params = list.parameters as Array<{ name: string; in: string }>;
    expect(params.map((p) => p.name)).toEqual(expect.arrayContaining(["limit", "cursor", "q", "lifecycle"]));
    const r200 = (list.responses as Record<string, { content: Record<string, { schema: Record<string, unknown> }> }>)["200"];
    const env = r200.content["application/json"].schema as { properties: { data: { type: string }; meta: { properties: Record<string, unknown> } } };
    expect(env.properties.data.type).toBe("array");
    expect(env.properties.meta.properties.next_cursor).toBeDefined();

    const create = paths["/contacts"].post;
    expect((create.parameters as Array<{ name: string; in: string }>).find((p) => p.in === "header")?.name).toBe("Idempotency-Key");
    expect(create.requestBody).toBeDefined();
    expect(Object.keys(create.responses as object)).toEqual(expect.arrayContaining(["201", "401", "403", "422", "429"]));

    const open = paths["/openapi.json"].get;
    expect(open.security).toEqual([]);
    expect(Object.keys(open.responses as object)).not.toContain("401");

    const byId = paths["/contacts/{id}"].get;
    expect((byId.parameters as Array<{ name: string; in: string; required: boolean }>)[0]).toMatchObject({ name: "id", in: "path", required: true });
  });

  it("every route has a scope or is explicitly public", () => {
    for (const r of Object.values(ROUTES)) {
      expect(r.scope === null || /^(read|write):[a-z]+$/.test(r.scope), r.id).toBe(true);
      if (r.method !== "GET") expect(r.scope?.startsWith("write:"), r.id).toBe(true);
    }
  });
});
