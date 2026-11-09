import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { ensureFreshAuth, getConnection, getLiveProvider, parseSettings, toContext, updateConnectionSettings } from "@/lib/accounting/connections";
import { listSimulatedObjects } from "@/lib/accounting/providers/simulated";
import { syncConnection } from "@/lib/accounting/sync";
import { recordAudit } from "@/lib/audit";
import { billingScope, isResponse } from "../../_shared";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

const Id = z.string().trim().min(1).max(100);

const SettingsSchema = z
  .object({
    sales_account_id: z.string().trim().max(200).nullable().optional(),
    expense_account_id: z.string().trim().max(200).nullable().optional(),
    deposit_account_id: z.string().trim().max(200).nullable().optional(),
    tax_code_id: z.string().trim().max(200).nullable().optional(),
    zero_tax_code_id: z.string().trim().max(200).nullable().optional(),
    push_payments: z.boolean().optional(),
    push_expenses: z.boolean().optional(),
  })
  .strict();

const PatchSchema = z.object({ settings: SettingsSchema.optional(), status: z.enum(["connected", "disabled"]).optional() }).strict();

/** Connection details + the chart of accounts for the mapping form (+ simulated objects). */
export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const scope = await billingScope(false);
  if (isResponse(scope)) return scope;
  const { id } = await ctx.params;
  if (!Id.safeParse(id).success) return NextResponse.json({ error: "Invalid id" }, { status: 400 });
  const row = await getConnection(scope.dataId, id);
  if (!row) return NextResponse.json({ error: "Connection not found" }, { status: 404 });
  const provider = getLiveProvider(row.provider);
  let accounts: unknown[] = [];
  let accountsError: string | null = null;
  try {
    if (provider && row.status !== "disabled") accounts = await provider.listAccounts(await ensureFreshAuth(row), toContext(row));
  } catch (err) {
    accountsError = err instanceof Error ? err.message : "Could not load accounts";
  }
  const simulated = row.provider === "simulated" ? await listSimulatedObjects(scope.dataId, row.id, 50).catch(() => []) : [];
  return NextResponse.json({
    connection: { id: row.id, provider: row.provider, realm_id: row.realm_id, tenant_id: row.tenant_id, company_name: row.company_name, status: row.status, last_sync_at: row.last_sync_at, last_error: row.last_error, settings: parseSettings(row.settings), created_at: row.created_at },
    accounts,
    accountsError,
    simulated,
  });
}

/** Update account mappings or enable/disable. */
export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const scope = await billingScope(true);
  if (isResponse(scope)) return scope;
  const { id } = await ctx.params;
  if (!Id.safeParse(id).success) return NextResponse.json({ error: "Invalid id" }, { status: 400 });
  const body = PatchSchema.safeParse(await req.json().catch(() => null));
  if (!body.success) return NextResponse.json({ error: "Invalid body", detail: body.error.flatten() }, { status: 400 });
  try {
    const row = await updateConnectionSettings(scope.dataId, id, body.data);
    if (!row) return NextResponse.json({ error: "Connection not found" }, { status: 404 });
    await recordAudit(scope, { action: "accounting.settings", entity: "accounting_connection", entityId: id, after: body.data as Record<string, unknown> });
    return NextResponse.json({ ok: true, settings: parseSettings(row.settings), status: row.status });
  } catch (err) {
    console.error("[accounting/connections] patch failed:", err);
    return NextResponse.json({ error: "Could not save settings." }, { status: 500 });
  }
}

/** Sync now. */
export async function POST(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const scope = await billingScope(true);
  if (isResponse(scope)) return scope;
  const { id } = await ctx.params;
  if (!Id.safeParse(id).success) return NextResponse.json({ error: "Invalid id" }, { status: 400 });
  const row = await getConnection(scope.dataId, id);
  if (!row) return NextResponse.json({ error: "Connection not found" }, { status: 404 });
  try {
    const result = await syncConnection(row.id);
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Sync failed" }, { status: 409 });
  }
}
