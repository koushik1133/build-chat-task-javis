import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { requireScope } from "@/lib/auth/scope";
import { errorResponse, parseBody } from "@/lib/money/http";
import { planGate } from "@/lib/plans/http";
import { recordAudit } from "@/lib/audit";
import { EINVOICE_FORMATS, EInvoiceError, formatForRegime, generateEInvoice, getEInvoice, submitEInvoiceSimulated } from "@/lib/tax-compliance/einvoice/service";
import { getTaxProfile } from "@/lib/tax-compliance/store";
import { getInvoice } from "@/lib/money/invoices";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Body = z.object({ format: z.enum(EINVOICE_FORMATS).optional(), action: z.enum(["generate", "submit"]).default("generate") }).strict();

function eiErr(e: unknown) {
  if (e instanceof EInvoiceError) return NextResponse.json({ error: e.message, errors: e.errors }, { status: e.status });
  return null;
}

/** POST - generate (default) or SIMULATE submission of an e-invoice. No government endpoint is ever called. */
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const scope = await requireScope({ area: "billing", edit: true });
    const gate = await planGate(scope, { feature: "tax_compliance" });
    if (gate) return gate;
    const { id } = await ctx.params;
    const body = await parseBody(req, Body, 2_000);
    if (!body.ok) return body.res;
    const profile = await getTaxProfile(scope.dataId);
    if (!profile) return NextResponse.json({ error: "no_tax_profile" }, { status: 409 });
    const format = body.data.format ?? formatForRegime(profile.regime);
    if (!format) return NextResponse.json({ error: "regime_has_no_e_invoice_format" }, { status: 400 });
    if (!(await getInvoice(scope.dataId, id))) return NextResponse.json({ error: "not_found" }, { status: 404 });
    try {
      if (body.data.action === "submit") {
        const out = await submitEInvoiceSimulated(scope.dataId, id, format);
        await recordAudit(scope, { action: "einvoice.submit_simulated", entity: "invoice", entityId: id, after: { format } });
        return NextResponse.json({ e_invoice: out, simulated: true });
      }
      const out = await generateEInvoice(scope.dataId, id, format);
      await recordAudit(scope, { action: "einvoice.generate", entity: "invoice", entityId: id, after: { format } });
      return NextResponse.json({ e_invoice: out.record, warnings: out.warnings }, { status: 201 });
    } catch (e) {
      const r = eiErr(e);
      if (r) return r;
      throw e;
    }
  } catch (err) {
    return errorResponse(err, "invoices.e-invoice.POST");
  }
}

/** GET ?format= - download the stored payload (XML for UBL, JSON for IRP). */
export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const scope = await requireScope({ area: "billing" });
    const { id } = await ctx.params;
    const profile = await getTaxProfile(scope.dataId);
    const fq = req.nextUrl.searchParams.get("format");
    const format = EINVOICE_FORMATS.find((f) => f === fq) ?? (profile ? formatForRegime(profile.regime) : null);
    if (!format) return NextResponse.json({ error: "format_required" }, { status: 400 });
    const rec = await getEInvoice(scope.dataId, id, format);
    if (!rec || !rec.payload) return NextResponse.json({ error: "not_generated", detail: rec?.error ?? null }, { status: 404 });
    const xml = format === "ubl_peppol";
    return new NextResponse(rec.payload, { headers: { "content-type": xml ? "application/xml; charset=utf-8" : "application/json; charset=utf-8", "content-disposition": `attachment; filename="e-invoice-${id}.${xml ? "xml" : "json"}"`, "x-payload-sha256": rec.payload_hash ?? "" } });
  } catch (err) {
    return errorResponse(err, "invoices.e-invoice.GET");
  }
}
