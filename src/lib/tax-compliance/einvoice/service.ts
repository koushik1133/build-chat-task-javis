import { createHash, randomUUID } from "crypto";
import { query, queryOne } from "@/lib/dsql";
import { getInvoice } from "@/lib/money/invoices";
import { listTaxRates, type TaxRateDTO } from "@/lib/money/tax-rates";
import { businessName } from "@/lib/money/quotes";
import { getBillingSettings } from "@/lib/money/settings";
import { computeLineTax } from "@/lib/money/tax";
import { emitEvent } from "@/lib/events/bus";
import { addressFromRaw, normalizeCountry, type Regime } from "../regimes";
import { resolveTax, type VatCategory } from "../resolver";
import { loadContactTax } from "../document";
import { getTaxProfile } from "../store";
import { buildIrpJson, simulateIrpSubmission, type IrpPayload } from "./india-irp";
import { buildPeppolUbl } from "./peppol-ubl";
import type { EDoc, ELine, EParty, ETaxSubtotal } from "./types";

export const EINVOICE_FORMATS = ["ubl_peppol", "in_irp_json"] as const;
export type EInvoiceFormat = (typeof EINVOICE_FORMATS)[number];
export type EInvoiceStatus = "draft" | "generated" | "submitted" | "accepted" | "rejected";

export interface EInvoiceDTO {
  id: string; invoice_id: string; invoice_number: string | null; format: EInvoiceFormat; status: EInvoiceStatus;
  payload_hash: string | null; provider_ref: string | null; error: string | null; created_at: string; updated_at: string;
}

function parseAddr(raw: string | null | undefined): { line1: string | null; city: string | null } {
  if (!raw || !raw.trim().startsWith("{")) return { line1: raw?.trim() || null, city: null };
  try {
    const o = JSON.parse(raw) as Record<string, unknown>;
    const s = (k: string) => (typeof o[k] === "string" && (o[k] as string).trim() ? (o[k] as string).trim() : null);
    return { line1: [s("line1") ?? s("street"), s("line2")].filter(Boolean).join(", ") || null, city: s("city") };
  } catch {
    return { line1: null, city: null };
  }
}

export function formatForRegime(regime: Regime | string): EInvoiceFormat | null {
  if (regime === "india_gst") return "in_irp_json";
  if (regime === "eu_vat" || regime === "uk_vat") return "ubl_peppol";
  return null;
}

/** Build the neutral e-invoice view of an invoice from live data. */
export async function loadEDoc(dataId: string, invoiceId: string): Promise<EDoc | null> {
  const inv = await getInvoice(dataId, invoiceId);
  if (!inv) return null;
  const meta0 = await queryOne<{ place_of_supply: string | null; reverse_charge: boolean | null; tax_regime: string | null }>(
    `SELECT place_of_supply, reverse_charge, tax_regime FROM invoices WHERE id = $1 AND user_id = $2`, [invoiceId, dataId]
  ).catch(() => null);
  const profile = await getTaxProfile(dataId);
  if (!profile) return null;
  const [rates, settings, bizName] = await Promise.all([listTaxRates(dataId, { includeInactive: true }).catch(() => [] as TaxRateDTO[]), getBillingSettings(dataId), businessName(dataId)]);
  const contact = inv.contact_id ? await loadContactTax(dataId, inv.contact_id).catch(() => null) : null;
  const contactRow = inv.contact_id ? await queryOne<{ company: string | null }>(`SELECT company FROM crm_contacts WHERE id = $1 AND user_id = $2`, [inv.contact_id, dataId]).catch(() => null) : null;
  const resolved = await resolveTax({ profile, items: inv.items, rates, contact, reverseCharge: meta0?.reverse_charge ?? undefined, docDate: new Date(inv.created_at), jurisdictionRates: rates.filter((r) => r.jurisdiction) });
  const productIds = [...new Set(inv.items.map((i) => i.product_id).filter((x): x is string => Boolean(x)))];
  const hsnByProduct = new Map<string, string>();
  if (productIds.length > 0) {
    const rows = await query<{ id: string; hsn_sac_code: string | null }>(`SELECT id, hsn_sac_code FROM products WHERE user_id = $1 AND id = ANY($2::text[])`, [dataId, productIds]).catch(() => []);
    for (const r of rows) if (r.hsn_sac_code) hsnByProduct.set(r.id, r.hsn_sac_code);
  }
  const kind = profile.settings.supply_kind ?? (profile.regime === "india_gst" ? "goods" : "services");
  const lines: ELine[] = resolved.items.map((l, i) => {
    const lt = computeLineTax(l, resolved.rates, { inclusive: settings.prices_include_tax });
    const rate_bp = Math.round(lt.parts.reduce((s, p) => s + p.rate_bp, 0) * 100) / 100;
    const category: VatCategory = rate_bp > 0 ? "S" : resolved.meta.vat_category && resolved.meta.vat_category !== "S" ? resolved.meta.vat_category : "Z";
    const orig = inv.items[i];
    return {
      id: String(i + 1), description: l.description, qty: l.qty, unit_minor: l.unit_minor, net_minor: lt.net_minor,
      hsn_sac: orig?.hsn_sac ?? (orig?.product_id ? hsnByProduct.get(orig.product_id) ?? null : null),
      is_service: kind === "services", category, rate_bp, tax_minor: lt.tax_minor,
      parts: lt.parts.map((p) => ({ name: p.name, rate_bp: p.rate_bp, tax_minor: p.tax })),
    };
  });
  const groups = new Map<string, ETaxSubtotal>();
  for (const l of lines) {
    const k = `${l.category}:${l.rate_bp}`;
    const g = groups.get(k) ?? { category: l.category, rate_bp: l.rate_bp, taxable_minor: 0, tax_minor: 0 };
    g.taxable_minor += l.net_minor;
    g.tax_minor += l.tax_minor;
    groups.set(k, g);
  }
  const bAddr = addressFromRaw(contact?.billing_address);
  const bLine = parseAddr(contact?.billing_address);
  const sellerCountry = normalizeCountry(profile.country) ?? (profile.regime === "india_gst" ? "IN" : null);
  const seller: EParty = {
    name: bizName, legal_name: profile.settings.legal_name ?? bizName,
    tax_id: profile.registration_number ?? settings.tax_number, country: sellerCountry,
    state: profile.state_province, address_line1: profile.settings.address_line1 ?? null, city: profile.settings.city ?? null, postal_code: profile.settings.postal_code ?? null,
  };
  const buyerCountry = normalizeCountry(contact?.tax_country) ?? normalizeCountry(bAddr.country) ?? (profile.regime === "india_gst" && resolved.meta.supply_kind !== "export" ? "IN" : null);
  const buyer: EParty = {
    name: inv.contact_name ?? "", legal_name: contactRow?.company ?? inv.contact_name, tax_id: contact?.tax_number ?? null, country: buyerCountry,
    state: contact?.tax_state ?? bAddr.state ?? null, address_line1: bLine.line1, city: bLine.city, postal_code: bAddr.postal_code ?? null, email: inv.contact_email,
  };
  const iso = (v: string | null) => (v ? new Date(v).toISOString().slice(0, 10) : null);
  return {
    kind: "invoice", number: inv.number, issue_date: iso(inv.sent_at) ?? iso(inv.created_at) ?? new Date().toISOString().slice(0, 10), due_date: iso(inv.due_at),
    currency: inv.currency, seller, buyer, buyer_type: (contact?.tax_registration_type as EDoc["buyer_type"]) ?? (contact?.tax_number ? "b2b" : null),
    lines, tax_subtotals: [...groups.values()], subtotal_minor: inv.subtotal_minor, tax_minor: inv.tax_minor, total_minor: inv.total_minor, paid_minor: inv.paid_minor,
    reverse_charge: meta0?.reverse_charge ?? resolved.meta.reverse_charge, exempt_reason_code: resolved.meta.exempt_reason_code,
    exempt_reason_text: resolved.meta.legends.join(" ") || null, place_of_supply: meta0?.place_of_supply ?? resolved.meta.place_of_supply,
    supply_kind: resolved.meta.supply_kind, notes: inv.notes,
  };
}

interface Row { id: string; invoice_id: string; format: string; status: string; payload: string | null; payload_hash: string | null; provider_ref: string | null; error: string | null; created_at: string | Date; updated_at: string | Date }
const iso = (v: string | Date) => (v instanceof Date ? v.toISOString() : String(v));
const toDTO = (r: Row & { number?: string | null }): EInvoiceDTO => ({
  id: r.id, invoice_id: r.invoice_id, invoice_number: r.number ?? null, format: r.format as EInvoiceFormat, status: r.status as EInvoiceStatus,
  payload_hash: r.payload_hash, provider_ref: r.provider_ref, error: r.error, created_at: iso(r.created_at), updated_at: iso(r.updated_at),
});

export async function listEInvoices(dataId: string, limit = 100): Promise<EInvoiceDTO[]> {
  const rows = await query<Row & { number: string | null }>(
    `SELECT e.*, i.number FROM e_invoices e LEFT JOIN invoices i ON i.id = e.invoice_id AND i.user_id = e.user_id WHERE e.user_id = $1 ORDER BY e.created_at DESC LIMIT $2`,
    [dataId, Math.min(limit, 500)]
  );
  return rows.map(toDTO);
}

export async function getEInvoice(dataId: string, invoiceId: string, format: EInvoiceFormat): Promise<(EInvoiceDTO & { payload: string | null }) | null> {
  const r = await queryOne<Row>(`SELECT * FROM e_invoices WHERE user_id = $1 AND invoice_id = $2 AND format = $3`, [dataId, invoiceId, format]);
  return r ? { ...toDTO(r), payload: r.payload } : null;
}

export class EInvoiceError extends Error {
  constructor(message: string, readonly errors: string[] = [], readonly status = 422) {
    super(message);
    this.name = "EInvoiceError";
  }
}

/** Build and store (upsert) an e-invoice. Validation failures are persisted as `draft` with `error`. */
export async function generateEInvoice(dataId: string, invoiceId: string, format: EInvoiceFormat): Promise<{ record: EInvoiceDTO; warnings: string[] }> {
  const doc = await loadEDoc(dataId, invoiceId);
  if (!doc) throw new EInvoiceError("Invoice not found or no tax profile configured", [], 404);
  let payload: string | null = null;
  let errors: string[] = [];
  let warnings: string[] = [];
  if (format === "ubl_peppol") {
    const r = buildPeppolUbl(doc);
    payload = r.output;
    errors = r.errors;
    warnings = r.warnings;
  } else {
    const r = buildIrpJson(doc);
    payload = r.output ? JSON.stringify(r.output, null, 2) : null;
    errors = r.errors;
    warnings = r.warnings;
  }
  const existing = await getEInvoice(dataId, invoiceId, format);
  if (existing && (existing.status === "submitted" || existing.status === "accepted")) throw new EInvoiceError("E-invoice already submitted; it cannot be regenerated", [], 409);
  const hash = payload ? createHash("sha256").update(payload).digest("hex") : null;
  const status: EInvoiceStatus = payload ? "generated" : "draft";
  const err = errors.length > 0 ? errors.join("; ") : null;
  if (existing) {
    await query(`UPDATE e_invoices SET status = $3, payload = $4, payload_hash = $5, error = $6, updated_at = NOW() WHERE id = $1 AND user_id = $2`, [existing.id, dataId, status, payload, hash, err]);
  } else {
    await query(`INSERT INTO e_invoices (id, user_id, invoice_id, format, status, payload, payload_hash, error) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, [randomUUID(), dataId, invoiceId, format, status, payload, hash, err]);
  }
  const rec = await getEInvoice(dataId, invoiceId, format);
  if (!rec) throw new Error("E-invoice vanished after save");
  if (payload) await query(`UPDATE invoices SET e_invoice_status = $3 WHERE id = $1 AND user_id = $2`, [invoiceId, dataId, status]).catch(() => undefined);
  if (!payload) throw new EInvoiceError("E-invoice has validation errors", errors);
  return { record: rec, warnings };
}

/** Simulated submission: no network. IRP formats get a fake IRN/ack/QR; UBL is marked submitted with a fake reference. */
export async function submitEInvoiceSimulated(dataId: string, invoiceId: string, format: EInvoiceFormat, now: Date = new Date()): Promise<EInvoiceDTO & { ack?: unknown }> {
  const rec = await getEInvoice(dataId, invoiceId, format);
  if (!rec || !rec.payload) throw new EInvoiceError("Generate the e-invoice first", [], 409);
  if (rec.status === "accepted" || rec.status === "submitted") return rec;
  let ref: string;
  let ack: unknown;
  if (format === "in_irp_json") {
    const p = JSON.parse(rec.payload) as IrpPayload;
    const doc = await loadEDoc(dataId, invoiceId);
    const a = simulateIrpSubmission(p, doc?.issue_date ?? now.toISOString().slice(0, 10), now);
    ref = a.irn;
    ack = a;
  } else {
    ref = "SIM-" + (rec.payload_hash ?? "").slice(0, 16);
    ack = { reference: ref, simulated: true };
  }
  await query(`UPDATE e_invoices SET status = 'accepted', provider_ref = $3, updated_at = NOW() WHERE id = $1 AND user_id = $2`, [rec.id, dataId, ref]);
  await query(`UPDATE invoices SET e_invoice_ref = $3, e_invoice_status = 'accepted' WHERE id = $1 AND user_id = $2`, [invoiceId, dataId, ref]).catch(() => undefined);
  void emitEvent(dataId, { type: "einvoice.accepted", entity: "invoice", entityId: invoiceId, data: { format, simulated: true } });
  const out = await getEInvoice(dataId, invoiceId, format);
  return { ...(out as EInvoiceDTO), ack };
}
