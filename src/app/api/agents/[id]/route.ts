import { NextResponse } from "next/server";
import { z } from "zod";
import { requireScope, scopeErrorResponse } from "@/lib/auth/scope";
import { query, queryOne } from "@/lib/dsql";
import { RUN_LIMITS } from "@/lib/agents/types";
import { deleteInBatches } from "@/lib/db/batch";

export const runtime = "nodejs";

const toolName = z.string().regex(/^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/, "tool names look like module.action");

const patchSchema = z.object({
  status: z.enum(["active", "paused", "idle"]).optional(),
  name: z.string().trim().min(1).max(120).optional(),
  role: z.string().trim().min(1).max(120).optional(),
  system_prompt: z.string().max(20_000).nullable().optional(),
  tools: z.array(toolName).max(RUN_LIMITS.maxToolsPerRun).nullable().optional(),
  model: z.string().trim().max(120).nullable().optional(),
  autonomy_level: z.enum(["draft", "approve", "auto"]).optional(),
  max_steps: z.number().int().min(1).max(RUN_LIMITS.absoluteMaxSteps).nullable().optional(),
});

function formatZodError(err: z.ZodError): string {
  return err.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ");
}

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  let scope;
  try { scope = await requireScope({ area: "agents", edit: false }); }
  catch (err) { return scopeErrorResponse(err) ?? NextResponse.json({ error: "unauthorized" }, { status: 401 }); }
  const { id } = await ctx.params;
  const agent = await queryOne("SELECT * FROM agents WHERE id = $1 AND user_id = $2", [id, scope.dataId]).catch(() => null);
  if (!agent) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json({ agent });
}

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  let scope;
  try { scope = await requireScope({ area: "agents", edit: true }); }
  catch (err) { return scopeErrorResponse(err) ?? NextResponse.json({ error: "unauthorized" }, { status: 401 }); }
  const { id } = await ctx.params;
  const rawBody = await req.json().catch(() => null);
  if (!rawBody || typeof rawBody !== "object") return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });

  const parsed = patchSchema.safeParse(rawBody);
  if (!parsed.success) return NextResponse.json({ error: formatZodError(parsed.error) }, { status: 400 });
  const body = parsed.data;

  // Each column is its own statement so a deployment missing a newer column
  // (e.g. `tools`) still updates the rest.
  const updates: Array<[string, unknown]> = [];
  if (body.status) updates.push(["status", body.status]);
  if (body.name) updates.push(["name", body.name]);
  if (body.role) updates.push(["role", body.role]);
  if (body.system_prompt !== undefined) updates.push(["system_prompt", body.system_prompt?.trim() || null]);
  if (body.tools !== undefined) updates.push(["tools", body.tools ? JSON.stringify(body.tools) : null]);
  if (body.model !== undefined) updates.push(["model", body.model?.trim() || null]);
  if (body.autonomy_level) updates.push(["autonomy_level", body.autonomy_level]);
  if (body.max_steps !== undefined) updates.push(["max_steps", body.max_steps]);

  for (const [column, value] of updates) {
    await query(`UPDATE agents SET ${column} = $1 WHERE id = $2 AND user_id = $3`, [value, id, scope.dataId]).catch((err) => {
      console.error(`[agents] failed to update ${column}:`, err);
    });
  }

  const agent = await queryOne("SELECT * FROM agents WHERE id = $1 AND user_id = $2", [id, scope.dataId]).catch(() => null);
  if (!agent) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json({ ok: true, agent });
}

export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  let scope;
  try { scope = await requireScope({ area: "agents", edit: true }); }
  catch (err) { return scopeErrorResponse(err) ?? NextResponse.json({ error: "unauthorized" }, { status: 401 }); }
  const { id } = await ctx.params;
  await deleteInBatches("agent_triggers", "agent_id = $1 AND user_id = $2", [id, scope.dataId]).catch(() => {});
  await query("DELETE FROM agents WHERE id = $1 AND user_id = $2", [id, scope.dataId]);
  return NextResponse.json({ ok: true });
}
