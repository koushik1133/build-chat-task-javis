import { NextResponse } from "next/server";
import { z } from "zod";
import { requireScope, scopeErrorResponse } from "@/lib/auth/scope";
import { query, queryOne } from "@/lib/dsql";
import { getAgentTemplate, getDefaultSystemPrompt } from "@/lib/agent-templates";
import { RUN_LIMITS } from "@/lib/agents/types";

export const runtime = "nodejs";

const toolName = z.string().regex(/^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/, "tool names look like module.action");

const createSchema = z.object({
  name: z.string().trim().min(1, "name required").max(120),
  role: z.string().trim().min(1).max(120).optional(),
  system_prompt: z.string().max(20_000).nullable().optional(),
  template_id: z.string().trim().max(120).nullable().optional(),
  tools: z.array(toolName).max(RUN_LIMITS.maxToolsPerRun).nullable().optional(),
  model: z.string().trim().max(120).nullable().optional(),
  autonomy_level: z.enum(["draft", "approve", "auto"]).optional(),
  max_steps: z.number().int().min(1).max(RUN_LIMITS.absoluteMaxSteps).nullable().optional(),
});

function formatZodError(err: z.ZodError): string {
  return err.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ");
}

export async function GET() {
  let scope;
  try { scope = await requireScope({ area: "agents", edit: false }); }
  catch (err) { return scopeErrorResponse(err) ?? NextResponse.json({ error: "unauthorized" }, { status: 401 }); }
  const agents = await query(
    "SELECT * FROM agents WHERE user_id = $1 ORDER BY created_at DESC",
    [scope.dataId]
  ).catch(() => []);
  return NextResponse.json({ agents });
}

export async function POST(req: Request) {
  let scope;
  try { scope = await requireScope({ area: "agents", edit: true }); }
  catch (err) { return scopeErrorResponse(err) ?? NextResponse.json({ error: "unauthorized" }, { status: 401 }); }
  const rawBody = await req.json().catch(() => null);
  if (!rawBody || typeof rawBody !== "object") return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });

  const parsed = createSchema.safeParse(rawBody);
  if (!parsed.success) return NextResponse.json({ error: formatZodError(parsed.error) }, { status: 400 });
  const body = parsed.data;

  const template = body.template_id ? getAgentTemplate(body.template_id) : null;
  const resolvedRole = body.role ?? template?.role ?? "General Agent";
  const resolvedPrompt =
    body.system_prompt?.trim() || template?.system_prompt || getDefaultSystemPrompt(resolvedRole);
  const tools = body.tools !== undefined ? body.tools : template?.tools ?? null;
  const autonomy = body.autonomy_level ?? template?.autonomy_level ?? "approve";
  const maxSteps = body.max_steps ?? null;
  const model = body.model?.trim() || null;

  const agent = await queryOne(
    `INSERT INTO agents (user_id, name, role, system_prompt, template_id, status, tasks_completed, tools, model, autonomy_level, max_steps)
     VALUES ($1, $2, $3, $4, $5, 'idle', 0, $6, $7, $8, $9) RETURNING *`,
    [
      scope.dataId,
      body.name,
      resolvedRole,
      resolvedPrompt,
      body.template_id ?? null,
      tools ? JSON.stringify(tools) : null,
      model,
      autonomy,
      maxSteps,
    ]
  ).catch(async () =>
    queryOne(
      `INSERT INTO agents (user_id, name, role, system_prompt, template_id, status, tasks_completed)
       VALUES ($1, $2, $3, $4, $5, 'idle', 0) RETURNING *`,
      [scope.dataId, body.name, resolvedRole, resolvedPrompt, body.template_id ?? null]
    )
  );
  if (!agent) return NextResponse.json({ error: "failed to create agent" }, { status: 500 });
  return NextResponse.json({ agent });
}
