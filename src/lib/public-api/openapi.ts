import type { ZodTypeAny } from "zod";
import { ROUTE_LIST, TAGS, type RouteDef } from "./registry";
import { API_SCOPES } from "./scopes";
import { RATE_LIMIT_PER_MIN } from "./auth";

/**
 * OpenAPI 3.1 document generated from the route registry.
 *
 * `zodToJsonSchema` covers the zod subset used in ./schemas. Anything it
 * does not recognise degrades to `{}` (any) rather than throwing, so a new
 * schema feature can never break the docs endpoint.
 */

export type JsonSchema = Record<string, unknown>;

type Def = { typeName?: string } & Record<string, unknown>;

function zdef(s: ZodTypeAny): Def {
  return (s as unknown as { _def: Def })._def;
}

function withDescription(schema: JsonSchema, s: ZodTypeAny): JsonSchema {
  const d = (s as { description?: string }).description;
  return d ? { ...schema, description: d } : schema;
}

export function zodToJsonSchema(s: ZodTypeAny): JsonSchema {
  const d = zdef(s);
  const out = convert(s, d);
  return withDescription(out, s);
}

function convert(s: ZodTypeAny, d: Def): JsonSchema {
  switch (d.typeName) {
    case "ZodString": {
      const out: JsonSchema = { type: "string" };
      for (const c of (d.checks as Array<{ kind: string; value?: unknown; regex?: RegExp }> | undefined) ?? []) {
        if (c.kind === "min") out.minLength = c.value;
        else if (c.kind === "max") out.maxLength = c.value;
        else if (c.kind === "length") {
          out.minLength = c.value;
          out.maxLength = c.value;
        } else if (c.kind === "email") out.format = "email";
        else if (c.kind === "uuid") out.format = "uuid";
        else if (c.kind === "url") out.format = "uri";
        else if (c.kind === "datetime") out.format = "date-time";
        else if (c.kind === "regex" && c.regex) out.pattern = c.regex.source;
      }
      return out;
    }
    case "ZodNumber": {
      const out: JsonSchema = { type: "number" };
      for (const c of (d.checks as Array<{ kind: string; value?: number; inclusive?: boolean }> | undefined) ?? []) {
        if (c.kind === "int") out.type = "integer";
        else if (c.kind === "min") out[c.inclusive === false ? "exclusiveMinimum" : "minimum"] = c.value;
        else if (c.kind === "max") out[c.inclusive === false ? "exclusiveMaximum" : "maximum"] = c.value;
      }
      return out;
    }
    case "ZodBoolean":
      return { type: "boolean" };
    case "ZodNull":
      return { type: "null" };
    case "ZodDate":
      return { type: "string", format: "date-time" };
    case "ZodLiteral":
      return { const: d.value };
    case "ZodEnum":
      return { type: "string", enum: [...(d.values as string[])] };
    case "ZodNativeEnum":
      return { enum: Object.values(d.values as Record<string, unknown>) };
    case "ZodArray": {
      const out: JsonSchema = { type: "array", items: zodToJsonSchema(d.type as ZodTypeAny) };
      const min = d.minLength as { value: number } | null | undefined;
      const max = d.maxLength as { value: number } | null | undefined;
      if (min) out.minItems = min.value;
      if (max) out.maxItems = max.value;
      return out;
    }
    case "ZodObject": {
      const shape = (d.shape as () => Record<string, ZodTypeAny>)();
      const properties: Record<string, JsonSchema> = {};
      const required: string[] = [];
      for (const [key, child] of Object.entries(shape)) {
        properties[key] = zodToJsonSchema(child);
        if (!isOptional(child)) required.push(key);
      }
      const out: JsonSchema = { type: "object", properties };
      if (required.length) out.required = required;
      if (d.unknownKeys === "strict") out.additionalProperties = false;
      return out;
    }
    case "ZodRecord":
      return { type: "object", additionalProperties: zodToJsonSchema(d.valueType as ZodTypeAny) };
    case "ZodOptional":
      return zodToJsonSchema(d.innerType as ZodTypeAny);
    case "ZodNullable": {
      const inner = zodToJsonSchema(d.innerType as ZodTypeAny);
      if (typeof inner.type === "string") return { ...inner, type: [inner.type, "null"] };
      return { oneOf: [inner, { type: "null" }] };
    }
    case "ZodDefault": {
      const inner = zodToJsonSchema(d.innerType as ZodTypeAny);
      return { ...inner, default: (d.defaultValue as () => unknown)() };
    }
    case "ZodEffects":
      return zodToJsonSchema(d.schema as ZodTypeAny);
    case "ZodLazy":
      return zodToJsonSchema((d.getter as () => ZodTypeAny)());
    case "ZodUnion":
    case "ZodDiscriminatedUnion":
      return { oneOf: (d.options as ZodTypeAny[]).map(zodToJsonSchema) };
    case "ZodTuple":
      return { type: "array", prefixItems: (d.items as ZodTypeAny[]).map(zodToJsonSchema) };
    case "ZodAny":
    case "ZodUnknown":
    default:
      return {};
  }
}

function isOptional(s: ZodTypeAny): boolean {
  const d = zdef(s);
  if (d.typeName === "ZodOptional" || d.typeName === "ZodDefault") return true;
  if (d.typeName === "ZodEffects") return isOptional(d.schema as ZodTypeAny);
  if (d.typeName === "ZodNullable") return isOptional(d.innerType as ZodTypeAny);
  return false;
}

/* ─── Document ─────────────────────────────────────────────────────────── */

const ERROR_SCHEMA: JsonSchema = {
  type: "object",
  required: ["error"],
  properties: {
    error: {
      type: "object",
      required: ["code", "message"],
      properties: { code: { type: "string" }, message: { type: "string" }, details: {} },
    },
  },
};

function errorResponse(description: string): JsonSchema {
  return { description, content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } };
}

function envelope(data: JsonSchema, list: boolean): JsonSchema {
  return {
    type: "object",
    required: ["data", "meta"],
    properties: {
      data: list ? { type: "array", items: data } : data,
      meta: {
        type: "object",
        properties: list ? { next_cursor: { type: ["string", "null"], description: "Pass as `cursor` to fetch the next page" } } : {},
      },
    },
  };
}

function parameters(def: RouteDef): JsonSchema[] {
  const out: JsonSchema[] = [];
  const add = (where: "path" | "query", schema: ZodTypeAny) => {
    const js = zodToJsonSchema(schema);
    const props = (js.properties as Record<string, JsonSchema> | undefined) ?? {};
    const required = new Set((js.required as string[] | undefined) ?? []);
    for (const [name, prop] of Object.entries(props)) {
      const { description, ...rest } = prop;
      out.push({ name, in: where, required: where === "path" ? true : required.has(name), description, schema: rest });
    }
  };
  if (def.params) add("path", def.params);
  if (def.query) add("query", def.query);
  return out;
}

function operation(def: RouteDef): JsonSchema {
  const okStatus = String(def.status ?? 200);
  const op: JsonSchema = {
    operationId: def.id,
    summary: def.summary,
    tags: [def.tag],
    security: def.scope === null ? [] : [{ bearerAuth: [] }],
    "x-scope": def.scope,
    ...(def.tools?.length ? { "x-kernelhub-tools": [...def.tools] } : {}),
    responses: {
      [okStatus]: {
        description: def.list ? "A page of results" : "Success",
        content: { "application/json": { schema: envelope(zodToJsonSchema(def.response), Boolean(def.list)) } },
      },
      "400": errorResponse("Malformed request (bad JSON, bad cursor)"),
      "422": errorResponse("Validation failed"),
      "500": errorResponse("Internal error"),
    },
  };
  const description = [def.description, def.emits?.length ? `Emits: ${def.emits.map((e) => `\`${e}\``).join(", ")}.` : null].filter(Boolean).join("\n\n");
  if (description) op.description = description;
  const params = parameters(def);
  if (params.length) op.parameters = params;
  if (def.body) {
    op.requestBody = { required: true, content: { "application/json": { schema: zodToJsonSchema(def.body) } } };
  }
  const responses = op.responses as Record<string, JsonSchema>;
  if (def.scope !== null) {
    responses["401"] = errorResponse("Missing or invalid API key");
    responses["403"] = errorResponse(`API key lacks the \`${def.scope}\` scope`);
    responses["429"] = errorResponse(`Rate limited (${RATE_LIMIT_PER_MIN}/min per key); see Retry-After`);
    if (def.method !== "GET") responses["404"] = errorResponse("Not found");
    if (def.method === "GET" && def.params) responses["404"] = errorResponse("Not found");
  }
  if (def.method === "POST" && def.scope !== null) {
    const list = Array.isArray(op.parameters) ? (op.parameters as JsonSchema[]) : [];
    list.push({
      name: "Idempotency-Key",
      in: "header",
      required: false,
      description: "Unique token (≤255 chars). Replays within 24h return the stored response with `Idempotent-Replay: true`.",
      schema: { type: "string", maxLength: 255 },
    });
    op.parameters = list;
  }
  return op;
}

export interface BuildOptions {
  /** Absolute base URL including /api/v1, e.g. https://app.example.com/api/v1 */
  serverUrl: string;
  version?: string;
  title?: string;
}

export function buildOpenApiDocument(opts: BuildOptions, routes: readonly RouteDef[] = ROUTE_LIST): JsonSchema {
  const paths: Record<string, Record<string, JsonSchema>> = {};
  for (const def of routes) {
    const p = (paths[def.path] ??= {});
    p[def.method.toLowerCase()] = operation(def);
  }
  return {
    openapi: "3.1.0",
    info: {
      title: opts.title ?? "KernelHub API",
      version: opts.version ?? "1.0.0",
      description:
        "Public REST API. Authenticate with `Authorization: Bearer kh_…` (Settings → API keys). " +
        "Responses are wrapped as `{ data, meta }`; errors as `{ error: { code, message } }`. " +
        `Lists use opaque cursors (\`meta.next_cursor\`). ${RATE_LIMIT_PER_MIN} requests/min per key; ` +
        "`X-RateLimit-Limit`, `X-RateLimit-Remaining` and `X-RateLimit-Reset` are sent on every authenticated response.",
    },
    servers: [{ url: opts.serverUrl }],
    tags: [...TAGS],
    "x-kernelhub-tools": {
      description: "Operations carry `x-kernelhub-tools`: the agent/MCP tool names (see /api/mcp and docs/MCP.md) that perform the same action.",
      mcp_endpoint: opts.serverUrl.replace(/\/api\/v1$/, "/api/mcp"),
    },
    paths,
    components: {
      securitySchemes: {
        bearerAuth: {
          type: "http",
          scheme: "bearer",
          bearerFormat: "kh_…",
          description: `Scopes: ${API_SCOPES.join(", ")}. "mcp" is the legacy full-access scope.`,
        },
      },
      schemas: { Error: ERROR_SCHEMA },
    },
  };
}
