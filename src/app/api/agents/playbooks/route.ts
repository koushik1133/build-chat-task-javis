import { NextResponse } from "next/server";
import { z } from "zod";
import { requireScope, scopeErrorResponse } from "@/lib/auth/scope";
import { query } from "@/lib/dsql";
import { PLAYBOOKS, getPlaybook, runPlaybook } from "@/lib/agents/playbooks";

type RunRow = { id: string; playbook_id: string; entity_id: string | null; run_id: string | null; status: string | null; created_at: string; run_status: string | null };

export async function GET() {
  let scope;
  try { scope = await requireScope({ area: "agents", edit: false }); }
  catch (err) { return scopeErrorResponse(err) ?? NextResponse.json({ error: "unauthorized" }, { status: 401 }); }

  const settings = await query<{ playbook_id: string; enabled: boolean | null }>(
    `SELECT playbook_id, enabled FROM playbook_settings WHERE user_id = $1`, [scope.dataId]
  ).catch(() => []);
  const enabledMap = new Map(settings.map((s) => [s.playbook_id, s.enabled !== false]));

  const runs = await query<RunRow>(
    `SELECT pr.id, pr.playbook_id, pr.entity_id, pr.run_id, pr.status, pr.created_at, r.status AS run_status
     FROM playbook_runs pr
     LEFT JOIN agent_runs r ON r.id::text = pr.run_id
     WHERE pr.user_id = $1 ORDER BY pr.created_at DESC LIMIT 100`,
    [scope.dataId]
  ).catch(() => []);

  const playbooks = PLAYBOOKS.map((p) => ({
    id: p.id,
    name: p.name,
    description: p.description,
    eventTypes: p.eventTypes ?? [],
    cooldownHours: p.cooldownHours,
    defaultTools: p.defaultTools,
    enabled: enabledMap.get(p.id) ?? true,
    recentRuns: runs.filter((r) => r.playbook_id === p.id).slice(0, 5).map((r) => ({
      id: r.id, entityId: r.entity_id, runId: r.run_id,
      status: r.run_status ?? r.status ?? "queued", createdAt: r.created_at,
    })),
  }));
  return NextResponse.json({ playbooks });
}

const PatchBody = z.object({ id: z.string().min(1), enabled: z.boolean() });

export async function PATCH(req: Request) {
  let scope;
  try { scope = await requireScope({ area: "agents", edit: true }); }
  catch (err) { return scopeErrorResponse(err) ?? NextResponse.json({ error: "unauthorized" }, { status: 401 }); }
  const parsed = PatchBody.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "id and enabled required" }, { status: 400 });
  if (!getPlaybook(parsed.data.id)) return NextResponse.json({ error: "unknown playbook" }, { status: 404 });

  const ok = await query(
    `INSERT INTO playbook_settings (user_id, playbook_id, enabled, updated_at) VALUES ($1, $2, $3, NOW())
     ON CONFLICT (user_id, playbook_id) DO UPDATE SET enabled = EXCLUDED.enabled, updated_at = NOW()`,
    [scope.dataId, parsed.data.id, parsed.data.enabled]
  ).then(() => true).catch(() => false);
  if (!ok) return NextResponse.json({ error: "failed to save" }, { status: 500 });
  return NextResponse.json({ ok: true, id: parsed.data.id, enabled: parsed.data.enabled });
}

const PostBody = z.object({ id: z.string().min(1), entityId: z.string().min(1).optional() });

export async function POST(req: Request) {
  let scope;
  try { scope = await requireScope({ area: "agents", edit: true }); }
  catch (err) { return scopeErrorResponse(err) ?? NextResponse.json({ error: "unauthorized" }, { status: 401 }); }
  const parsed = PostBody.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "id required" }, { status: 400 });
  if (!getPlaybook(parsed.data.id)) return NextResponse.json({ error: "unknown playbook" }, { status: 404 });
  try {
    const result = await runPlaybook(scope.dataId, parsed.data.id, parsed.data.entityId);
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "run failed" }, { status: 500 });
  }
}
