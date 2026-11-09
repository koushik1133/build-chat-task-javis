import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { readFile } from "fs/promises";
import { join } from "path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { CallToolRequestSchema, ListResourcesRequestSchema, ListToolsRequestSchema, ReadResourceRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { query } from "@/lib/dsql";
import { verifyApiKey } from "@/lib/api-keys";
import { getTool, listTools, needsApproval } from "@/lib/agents/registry";
import { keyMayUseTool, scopeForTool, toolInputSchema } from "@/lib/agents/tool-scopes";
import type { ToolContext, ToolSpec } from "@/lib/agents/types";
import { buildOpenApiDocument } from "@/lib/public-api/openapi";
import { rateLimitAsync } from "@/lib/request-limits";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Streamable HTTP MCP endpoint (stateless: one server + transport per request).
 *
 * - `tools/list` exposes every registry tool the API key's scopes allow
 *   (read tools need `read:<area>`, write tools `write:<area>`, legacy `mcp`
 *   grants all — see src/lib/agents/tool-scopes.ts) with its JSON schema.
 * - `tools/call` runs under the "approve" autonomy level, so gated writes
 *   land in the approvals inbox and the client receives the approval id.
 * - `resources/list` + `resources/read` serve the OpenAPI document and the
 *   docs (API.md, MCP.md) so an MCP client can discover the REST surface.
 */

interface Principal {
  userId: string;
  keyId: string;
  scopes: string[];
}

const DOC_RESOURCES: Array<{ uri: string; name: string; description: string; file: string }> = [
  { uri: "kernelhub://docs/api", name: "REST API guide", description: "docs/API.md — authentication, conventions, resources, webhooks.", file: "API.md" },
  { uri: "kernelhub://docs/mcp", name: "MCP guide", description: "docs/MCP.md — connecting MCP clients, scopes, approvals.", file: "MCP.md" },
];
const OPENAPI_URI = "kernelhub://openapi.json";

async function loadRegistry(): Promise<ToolSpec[]> {
  try {
    await import("@/lib/agents/tools/index");
  } catch (err) {
    console.error("[mcp] tool modules failed to load:", err);
  }
  return listTools();
}

async function insertApproval(userId: string, spec: ToolSpec, input: unknown, keyId: string): Promise<string> {
  const id = randomUUID();
  const preview = spec.preview ? spec.preview(input) : `${spec.name} ${JSON.stringify(input).slice(0, 200)}`;
  await query(
    `INSERT INTO approvals (id, user_id, run_id, agent_id, tool_name, input, preview, status, created_at)
     VALUES ($1, $2, 'mcp', NULL, $3, $4, $5, 'pending', NOW())`,
    [id, userId, spec.name, JSON.stringify(input ?? {}), `[MCP key ${keyId.slice(0, 8)}] ${preview}`.slice(0, 500)]
  );
  return id;
}

function text(payload: unknown, isError = false) {
  return { content: [{ type: "text" as const, text: JSON.stringify(payload) }], isError };
}

function buildServer(principal: Principal, specs: ToolSpec[], origin: string) {
  const server = new Server({ name: "kernelhub", version: "1.1.0" }, { capabilities: { tools: {}, resources: {} } });
  const allowed = specs.filter((t) => keyMayUseTool(principal.scopes, t));

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: allowed.map((t) => ({
      name: t.name,
      description: `${t.description}${t.scope === "write" ? " [write — may require approval]" : ""}`,
      inputSchema: toolInputSchema(t) as { type: "object"; properties?: Record<string, unknown>; required?: string[] },
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const spec = getTool(req.params.name);
    if (!spec) return text({ error: `Unknown tool ${req.params.name}` }, true);
    if (!keyMayUseTool(principal.scopes, spec)) {
      return text({ error: "forbidden", required_scope: scopeForTool(spec), granted: principal.scopes }, true);
    }

    const parsed = spec.input.safeParse(req.params.arguments ?? {});
    if (!parsed.success) {
      return text({ error: "Invalid input", issues: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`) }, true);
    }

    const ctx: ToolContext = { userId: principal.userId, runId: "mcp", agentId: null, autonomy: "approve" };
    if (needsApproval(spec, parsed.data, ctx)) {
      const approvalId = await insertApproval(principal.userId, spec, parsed.data, principal.keyId);
      return text({ status: "awaiting_approval", approval_id: approvalId, tool: spec.name, decide: `POST ${origin}/api/v1/approvals/${approvalId}/decide` });
    }

    try {
      const result = await spec.run(ctx, parsed.data);
      return text({ ok: result.ok, summary: result.summary, data: result.data ?? null, error: result.error ?? null }, !result.ok);
    } catch (err) {
      return text({ error: err instanceof Error ? err.message : String(err) }, true);
    }
  });

  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: [
      { uri: OPENAPI_URI, name: "OpenAPI 3.1 document", description: "The REST API (/api/v1) generated from the route registry. Operations list matching tools under x-kernelhub-tools.", mimeType: "application/json" },
      ...DOC_RESOURCES.map((d) => ({ uri: d.uri, name: d.name, description: d.description, mimeType: "text/markdown" })),
    ],
  }));

  server.setRequestHandler(ReadResourceRequestSchema, async (req) => {
    const uri = req.params.uri;
    if (uri === OPENAPI_URI) {
      const doc = buildOpenApiDocument({ serverUrl: `${origin}/api/v1` });
      return { contents: [{ uri, mimeType: "application/json", text: JSON.stringify(doc) }] };
    }
    const doc = DOC_RESOURCES.find((d) => d.uri === uri);
    if (!doc) throw new Error(`Unknown resource ${uri}`);
    const body = await readFile(join(process.cwd(), "docs", doc.file), "utf8").catch(() => `# ${doc.name}\n\n(not available on this deployment)`);
    return { contents: [{ uri, mimeType: "text/markdown", text: body }] };
  });

  return server;
}

async function authenticate(req: NextRequest): Promise<Principal | null> {
  const header = req.headers.get("authorization") ?? "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match) return null;
  const verified = await verifyApiKey(match[1]);
  return verified ? { userId: verified.userId, keyId: verified.keyId, scopes: verified.scopes } : null;
}

function unauthorized() {
  return NextResponse.json(
    { error: "unauthorized", hint: "Send `Authorization: Bearer <api key>` — create one under Settings → API Keys." },
    { status: 401, headers: { "WWW-Authenticate": 'Bearer realm="mcp"' } }
  );
}

export async function POST(req: NextRequest) {
  const principal = await authenticate(req);
  if (!principal) return unauthorized();
  const rl = await rateLimitAsync(`mcp:${principal.keyId}`, 300, 60_000);
  if (!rl.allowed) return NextResponse.json({ error: "rate_limited" }, { status: 429, headers: { "Retry-After": "60" } });

  try {
    const specs = await loadRegistry();
    const origin = (process.env.NEXT_PUBLIC_APP_URL ?? new URL(req.url).origin).replace(/\/$/, "");
    const server = buildServer(principal, specs, origin);
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // stateless
      enableJsonResponse: true,
    });
    await server.connect(transport);
    const res = await transport.handleRequest(req);
    void transport.close().catch(() => undefined);
    return res;
  } catch (err) {
    console.error("[mcp] request failed:", err);
    return NextResponse.json({ error: "MCP request failed" }, { status: 500 });
  }
}

/** Server-initiated SSE streams are not supported in stateless mode. */
export async function GET(req: NextRequest) {
  if (!(await authenticate(req))) return unauthorized();
  return NextResponse.json(
    { error: "method_not_allowed", hint: "This MCP endpoint is stateless; send JSON-RPC over POST." },
    { status: 405, headers: { Allow: "POST, DELETE" } }
  );
}

/** Nothing to tear down in stateless mode; acknowledge so clients can end cleanly. */
export async function DELETE(req: NextRequest) {
  if (!(await authenticate(req))) return unauthorized();
  return new NextResponse(null, { status: 204 });
}
