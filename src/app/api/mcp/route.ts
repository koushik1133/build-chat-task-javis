import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { query } from "@/lib/dsql";
import { verifyApiKey } from "@/lib/api-keys";
import { getTool, listTools, needsApproval } from "@/lib/agents/registry";
import type { ToolContext, ToolSpec } from "@/lib/agents/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Streamable HTTP MCP endpoint (stateless: one server + transport per request).
 *
 * Every registry tool is exposed as an MCP tool. Calls run under the
 * "approve" autonomy level, so anything the registry gates lands in the
 * approvals inbox instead of executing, and the client receives the
 * approval id.
 */

async function loadRegistry(): Promise<ToolSpec[]> {
  try {
    await import("@/lib/agents/tools/index");
  } catch (err) {
    console.error("[mcp] tool modules failed to load:", err);
  }
  return listTools();
}

async function insertApproval(userId: string, spec: ToolSpec, input: unknown): Promise<string> {
  const id = randomUUID();
  const preview = spec.preview ? spec.preview(input) : `${spec.name} ${JSON.stringify(input).slice(0, 200)}`;
  await query(
    `INSERT INTO approvals (id, user_id, run_id, agent_id, tool_name, input, preview, status, created_at)
     VALUES ($1, $2, 'mcp', NULL, $3, $4, $5, 'pending', NOW())`,
    [id, userId, spec.name, JSON.stringify(input ?? {}), preview.slice(0, 500)]
  );
  return id;
}

function text(payload: unknown, isError = false) {
  return { content: [{ type: "text" as const, text: JSON.stringify(payload) }], isError };
}

function buildServer(userId: string, specs: ToolSpec[]) {
  const server = new Server({ name: "kernelhub", version: "1.0.0" }, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: specs.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: { type: "object" as const, ...(t.parameters as Record<string, unknown>) },
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const spec = getTool(req.params.name);
    if (!spec) return text({ error: `Unknown tool ${req.params.name}` }, true);

    const parsed = spec.input.safeParse(req.params.arguments ?? {});
    if (!parsed.success) {
      return text({ error: "Invalid input", issues: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`) }, true);
    }

    const ctx: ToolContext = { userId, runId: "mcp", agentId: null, autonomy: "approve" };
    if (needsApproval(spec, parsed.data, ctx)) {
      const approvalId = await insertApproval(userId, spec, parsed.data);
      return text({ status: "awaiting_approval", approval_id: approvalId, tool: spec.name });
    }

    try {
      const result = await spec.run(ctx, parsed.data);
      return text({ ok: result.ok, summary: result.summary, data: result.data ?? null, error: result.error ?? null }, !result.ok);
    } catch (err) {
      return text({ error: err instanceof Error ? err.message : String(err) }, true);
    }
  });

  return server;
}

async function authenticate(req: NextRequest): Promise<string | null> {
  const header = req.headers.get("authorization") ?? "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match) return null;
  const verified = await verifyApiKey(match[1]);
  return verified?.userId ?? null;
}

export async function POST(req: NextRequest) {
  const userId = await authenticate(req);
  if (!userId) {
    return NextResponse.json(
      { error: "unauthorized", hint: "Send `Authorization: Bearer <api key>` — create one under Settings → API Keys." },
      { status: 401, headers: { "WWW-Authenticate": 'Bearer realm="mcp"' } }
    );
  }

  try {
    const specs = await loadRegistry();
    const server = buildServer(userId, specs);
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // stateless
      enableJsonResponse: true,
    });
    await server.connect(transport);
    const res = await transport.handleRequest(req);
    // Fire-and-forget teardown once the response has been produced.
    void transport.close().catch(() => undefined);
    return res;
  } catch (err) {
    console.error("[mcp] request failed:", err);
    return NextResponse.json({ error: "MCP request failed" }, { status: 500 });
  }
}

/** Server-initiated SSE streams are not supported in stateless mode. */
export async function GET(req: NextRequest) {
  const userId = await authenticate(req);
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  return NextResponse.json(
    { error: "method_not_allowed", hint: "This MCP endpoint is stateless; send JSON-RPC over POST." },
    { status: 405, headers: { Allow: "POST, DELETE" } }
  );
}

/** Nothing to tear down in stateless mode; acknowledge so clients can end cleanly. */
export async function DELETE(req: NextRequest) {
  const userId = await authenticate(req);
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  return new NextResponse(null, { status: 204 });
}
