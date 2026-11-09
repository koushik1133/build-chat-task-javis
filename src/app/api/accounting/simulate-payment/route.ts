import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getConnection, getLink } from "@/lib/accounting/connections";
import { createSimulatedRemotePayment } from "@/lib/accounting/providers/simulated";
import { pullPaymentsFor } from "@/lib/accounting/sync";
import { getInvoice } from "@/lib/money/invoices";
import { billingScope, isResponse } from "../_shared";

export const dynamic = "force-dynamic";

const Body = z.object({
  connection_id: z.string().trim().min(1).max(100),
  invoice_id: z.string().trim().min(1).max(100),
  /** Defaults to the outstanding balance. */
  amount_minor: z.number().int().min(1).max(1_000_000_000_000).optional(),
  /** Pull immediately after creating (default true). */
  pull: z.boolean().optional(),
}).strict();

/** Simulated only: pretend a payment was recorded in the accounting system against a pushed invoice, then pull it. */
export async function POST(req: NextRequest) {
  const scope = await billingScope(true);
  if (isResponse(scope)) return scope;
  const body = Body.safeParse(await req.json().catch(() => null));
  if (!body.success) return NextResponse.json({ error: "Invalid body", detail: body.error.flatten() }, { status: 400 });
  const conn = await getConnection(scope.dataId, body.data.connection_id);
  if (!conn) return NextResponse.json({ error: "Connection not found" }, { status: 404 });
  if (conn.provider !== "simulated") return NextResponse.json({ error: "Only the simulated ledger supports fake remote payments." }, { status: 409 });
  const inv = await getInvoice(scope.dataId, body.data.invoice_id);
  if (!inv) return NextResponse.json({ error: "Invoice not found" }, { status: 404 });
  const link = await getLink(conn.id, "invoice", inv.id);
  if (!link?.remote_id) return NextResponse.json({ error: "Push the invoice first so the ledger knows about it." }, { status: 409 });
  const amount = body.data.amount_minor ?? Math.max(inv.total_minor - inv.paid_minor, 0);
  if (amount <= 0) return NextResponse.json({ error: "Nothing outstanding on this invoice." }, { status: 409 });
  const remoteId = await createSimulatedRemotePayment(scope.dataId, conn.id, { invoiceRemoteId: link.remote_id, amountMinor: amount, currency: inv.currency });
  const pull = body.data.pull === false ? null : await pullPaymentsFor(conn);
  return NextResponse.json({ ok: true, remote_id: remoteId, amount_minor: amount, pull });
}
