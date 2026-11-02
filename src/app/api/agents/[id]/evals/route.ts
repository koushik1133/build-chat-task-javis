import { randomUUID } from "crypto";
import { NextResponse } from "next/server";
import { z } from "zod";
import { requireScope, scopeErrorResponse } from "@/lib/auth/scope";
import { query, queryOne } from "@/lib/dsql";
import { toEvalRunDTO, type EvalRow, type EvalRunRow } from "@/lib/evals/run";
import { MAX_CASES, parseCases } from "@/lib/evals/score";

export const runtime = "nodejs";

const CaseSchema = z
  .object({
    input: z.string().trim().min(1).max(8000),
    expected: z.string().max(8000).optional().nullable(),
    rubric: z.string().max(4000).optional().nullable(),
  })
  .strict();

const Create = z
  .object({
    name: z.string().trim().min(1).max(120),
    cases: z.array(CaseSchema).max(MAX_CASES).default([]),
  })
  .strict();

async function agentExists(userId: string, agentId: string): Promise<boolean> {
  const row = await queryOne<{ id: string }>(`SELECT id FROM agents WHERE id::text = $1 AND user_id = $2`, [agentId, userId]).catch(() => null);
  return Boolean(row);
}

function toDTO(e: EvalRow, latest?: EvalRunRow | null) {
  return {
    id: e.id,
    agent_id: e.agent_id,
    name: e.name,
    cases: parseCases(e.cases),
    created_at: e.created_at,
    updated_at: e.updated_at,
    latest_run: latest ? toEvalRunDTO(latest, { withResults: false }) : null,
  };
}

/** GET /api/agents/:id/evals → evals for the agent with their latest run. */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  let scope;
  try { scope = await requireScope({ area: "agents", edit: false }); }
  catch (err) { return scopeErrorResponse(err) ?? NextResponse.json({ error: "unauthorized" }, { status: 401 }); }
  const { id } = await ctx.params;
  if (!(await agentExists(scope.dataId, id))) return NextResponse.json({ error: "not found" }, { status: 404 });

  try {
    const evals = await query<EvalRow>(
      `SELECT * FROM agent_evals WHERE user_id = $1 AND agent_id = $2 ORDER BY created_at DESC LIMIT 100`,
      [scope.dataId, id]
    );
    const latest = await Promise.all(
      evals.map((e) =>
        queryOne<EvalRunRow>(
          `SELECT id, user_id, eval_id, agent_id, status, score, NULL AS results, model, cost_micros, error, created_at, finished_at
             FROM agent_eval_runs WHERE user_id = $1 AND eval_id = $2 ORDER BY created_at DESC LIMIT 1`,
          [scope.dataId, e.id]
        ).catch(() => null)
      )
    );
    return NextResponse.json({ evals: evals.map((e, i) => toDTO(e, latest[i])) });
  } catch (err) {
    console.error("[agents/evals] list failed:", err);
    return NextResponse.json({ error: "Could not load evals." }, { status: 500 });
  }
}

/** POST /api/agents/:id/evals { name, cases } → 201 { eval } */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  let scope;
  try { scope = await requireScope({ area: "agents", edit: true }); }
  catch (err) { return scopeErrorResponse(err) ?? NextResponse.json({ error: "unauthorized" }, { status: 401 }); }
  const { id } = await ctx.params;
  const parsed = Create.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ") }, { status: 400 });
  }
  if (!(await agentExists(scope.dataId, id))) return NextResponse.json({ error: "not found" }, { status: 404 });

  try {
    const evalId = randomUUID();
    const cases = parseCases(parsed.data.cases);
    await query(
      `INSERT INTO agent_evals (id, user_id, agent_id, name, cases) VALUES ($1, $2, $3, $4, $5)`,
      [evalId, scope.dataId, id, parsed.data.name, JSON.stringify(cases)]
    );
    const row = await queryOne<EvalRow>(`SELECT * FROM agent_evals WHERE id = $1`, [evalId]);
    if (!row) throw new Error("eval vanished after insert");
    return NextResponse.json({ eval: toDTO(row, null) }, { status: 201, headers: { Location: `/api/evals/${evalId}` } });
  } catch (err) {
    console.error("[agents/evals] create failed:", err);
    return NextResponse.json({ error: "Could not create eval." }, { status: 500 });
  }
}
