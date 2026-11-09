import { createHash } from "crypto";
import { convertMinor, type FxRateLike } from "@/lib/money/fx";
import type { TaxBreakdownRow } from "@/lib/money/tax";
import { EU_MEMBER_STATES, validateEuVat, validateGstin, vatPrefixForCountry } from "./validators";
import { splitGstTotal } from "./resolver";
import type { Regime } from "./regimes";

/**
 * Filing-ready report aggregation (pure). Inputs are plain documents; the DB
 * loader lives in reports-data.ts. Every amount is in minor units of the
 * REPORTING currency (documents in other currencies are converted with the
 * org's fx rates and the rate used is recorded in `fx_notes`).
 */

export interface RDoc {
  id: string;
  number: string;
  kind: "invoice" | "credit_note";
  /** ISO date-time. */
  date: string;
  currency: string;
  subtotal_minor: number;
  tax_minor: number;
  total_minor: number;
  breakdown: TaxBreakdownRow[];
  items: Array<{ description: string; hsn_sac: string | null; qty: number; net_minor: number }>;
  contact: { id: string | null; name: string | null; tax_number: string | null; type: string | null; country: string | null; state: string | null };
  place_of_supply: string | null;
  reverse_charge: boolean;
}

export interface RInput {
  id: string;
  number: string;
  source: "bill" | "expense";
  date: string;
  currency: string;
  net_minor: number;
  tax_minor: number;
  supplier: string | null;
}

export type Cell = string | number | null;
export interface Section { key: string; title: string; columns: string[]; rows: Cell[][] }
export interface Report {
  regime: Regime;
  kind: string;
  title: string;
  period: { from: string; to: string };
  currency: string;
  totals: Record<string, number>;
  sections: Section[];
  warnings: string[];
  fx_notes: string[];
  report_hash: string;
}

export interface ReportParams {
  regime: Regime;
  from: string;
  to: string;
  currency: string;
  fx: readonly FxRateLike[];
  sellerCountry?: string | null;
  /** US nexus states; others flagged. */
  nexusStates?: string[];
  /** India B2CL threshold in minor units of the reporting currency (INR 2,50,000 -> 25_000_000 paise; verify). */
  b2clThreshold?: number;
}

class Conv {
  notes = new Set<string>();
  warnings = new Set<string>();
  constructor(private target: string, private rates: readonly FxRateLike[]) {}
  mixed = false;
  to(minor: number, cur: string, date: string): number {
    const c = cur.toUpperCase();
    if (c === this.target) return minor;
    this.mixed = true;
    const out = convertMinor(minor, c, this.target, this.rates);
    if (out === null) {
      this.warnings.add(`No FX rate for ${c} -> ${this.target}; ${c} documents (e.g. dated ${date.slice(0, 10)}) were excluded from totals.`);
      return 0;
    }
    const one = convertMinor(100_000, c, this.target, this.rates);
    this.notes.add(`${c} -> ${this.target} at ${one === null ? "?" : (one / 100_000).toFixed(6)} (latest stored rate, applied to all documents in the period)`);
    return out;
  }
}

const inPeriod = (d: string, p: ReportParams) => d.slice(0, 10) >= p.from && d.slice(0, 10) <= p.to;

/** Canonical hash: stable key order, no timestamps. */
export function hashReport(r: Omit<Report, "report_hash">): string {
  const canon = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(canon);
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => [k, canon(x)]));
    return v;
  };
  return createHash("sha256").update(JSON.stringify(canon(r))).digest("hex");
}

function finish(p: ReportParams, kind: string, title: string, conv: Conv, totals: Record<string, number>, sections: Section[], warnings: string[]): Report {
  if (conv.mixed) warnings.push("Documents in more than one currency were converted into the reporting currency.");
  const base: Omit<Report, "report_hash"> = {
    regime: p.regime, kind, title, period: { from: p.from, to: p.to }, currency: p.currency, totals, sections,
    warnings: [...new Set([...warnings, ...conv.warnings])], fx_notes: [...conv.notes].sort(),
  };
  return { ...base, report_hash: hashReport(base) };
}

/* ---------- document slicing ---------- */

interface Slice { gst_bp: number; taxable: number; igst: number; cgst: number; sgst: number; other: number; name: string }

/** One slice per GST rate on a document, signed (credit notes negative) and converted. */
function gstSlices(d: RDoc, sign: number, conv: Conv): Slice[] {
  const f = (m: number) => sign * conv.to(m, d.currency, d.date);
  const by = new Map<number, Slice>();
  const get = (bp: number): Slice => {
    const s = by.get(bp) ?? { gst_bp: bp, taxable: 0, igst: 0, cgst: 0, sgst: 0, other: 0, name: "" };
    by.set(bp, s);
    return s;
  };
  for (const r of d.breakdown) {
    const nm = r.name.toUpperCase();
    if (nm === "CGST" || nm === "SGST") {
      const s = get(Math.round(r.rate_bp * 2));
      if (nm === "CGST") { s.taxable += f(r.taxable_minor); s.cgst += f(r.tax_minor); } else s.sgst += f(r.tax_minor);
    } else if (nm === "IGST") {
      const s = get(r.rate_bp);
      s.taxable += f(r.taxable_minor);
      s.igst += f(r.tax_minor);
    } else {
      const s = get(r.rate_bp);
      s.taxable += f(r.taxable_minor);
      s.other += f(r.tax_minor);
    }
  }
  if (by.size === 0) get(0).taxable = f(d.subtotal_minor);
  return [...by.values()].sort((a, b) => a.gst_bp - b.gst_bp);
}

const pct = (bp: number) => Math.round(bp) / 100;
const isRegisteredIn = (d: RDoc) => Boolean(d.contact.tax_number && validateGstin(d.contact.tax_number).valid);
const isExport = (d: RDoc) => d.place_of_supply === "96";

/* ---------- India ---------- */

export function buildGstr1(invoices: RDoc[], credits: RDoc[], p: ReportParams): Report {
  const conv = new Conv(p.currency, p.fx);
  const warnings: string[] = [];
  const thr = p.b2clThreshold ?? 25_000_000;
  const inv = invoices.filter((d) => inPeriod(d.date, p));
  const cns = credits.filter((d) => inPeriod(d.date, p));
  const b2b: Cell[][] = [];
  const b2cl: Cell[][] = [];
  const b2cs = new Map<string, { pos: string; gst: number; taxable: number; igst: number; cgst: number; sgst: number }>();
  const exp: Cell[][] = [];
  const cdn: Cell[][] = [];
  const hsn = new Map<string, { hsn: string; gst: number; qty: number; taxable: number; igst: number; cgst: number; sgst: number }>();
  let taxable = 0, igst = 0, cgst = 0, sgst = 0;

  const addHsn = (d: RDoc, sign: number, slices: Slice[]) => {
    const rate = slices.length === 1 ? slices[0].gst_bp : 0;
    const sub = d.items.reduce((s, i) => s + i.net_minor, 0) || 1;
    for (const it of d.items) {
      const code = it.hsn_sac ?? "MISSING";
      if (!it.hsn_sac) warnings.push(`${d.number}: line "${it.description.slice(0, 40)}" has no HSN/SAC code.`);
      const share = it.net_minor / sub;
      const k = `${code}|${rate}`;
      const h = hsn.get(k) ?? { hsn: code, gst: rate, qty: 0, taxable: 0, igst: 0, cgst: 0, sgst: 0 };
      h.qty += sign * it.qty;
      h.taxable += Math.round(slices.reduce((s, x) => s + x.taxable, 0) * share);
      h.igst += Math.round(slices.reduce((s, x) => s + x.igst, 0) * share);
      h.cgst += Math.round(slices.reduce((s, x) => s + x.cgst, 0) * share);
      h.sgst += Math.round(slices.reduce((s, x) => s + x.sgst, 0) * share);
      hsn.set(k, h);
    }
  };

  for (const d of inv) {
    const slices = gstSlices(d, 1, conv);
    const total = conv.to(d.total_minor, d.currency, d.date);
    for (const s of slices) { taxable += s.taxable; igst += s.igst; cgst += s.cgst; sgst += s.sgst; }
    addHsn(d, 1, slices);
    if (d.contact.type === "b2b" && !isRegisteredIn(d) && !isExport(d)) warnings.push(`${d.number}: B2B customer ${d.contact.name ?? ""} has no valid GSTIN - reported as B2C.`);
    if (!d.place_of_supply) warnings.push(`${d.number}: place of supply is not recorded.`);
    if (isExport(d)) {
      for (const s of slices) exp.push([d.number, d.date.slice(0, 10), total, pct(s.gst_bp), s.taxable, s.igst]);
    } else if (isRegisteredIn(d)) {
      for (const s of slices) b2b.push([d.contact.tax_number, d.contact.name, d.number, d.date.slice(0, 10), total, d.place_of_supply, d.reverse_charge ? "Y" : "N", pct(s.gst_bp), s.taxable, s.igst, s.cgst, s.sgst]);
    } else {
      const interState = slices.some((s) => s.igst !== 0);
      if (interState && total > thr) {
        for (const s of slices) b2cl.push([d.number, d.date.slice(0, 10), total, d.place_of_supply, pct(s.gst_bp), s.taxable, s.igst]);
      } else {
        for (const s of slices) {
          const k = `${d.place_of_supply ?? "?"}|${s.gst_bp}`;
          const g = b2cs.get(k) ?? { pos: d.place_of_supply ?? "?", gst: s.gst_bp, taxable: 0, igst: 0, cgst: 0, sgst: 0 };
          g.taxable += s.taxable; g.igst += s.igst; g.cgst += s.cgst; g.sgst += s.sgst;
          b2cs.set(k, g);
        }
      }
    }
  }
  for (const d of cns) {
    const slices = gstSlices(d, -1, conv);
    const total = -conv.to(d.total_minor, d.currency, d.date);
    for (const s of slices) { taxable += s.taxable; igst += s.igst; cgst += s.cgst; sgst += s.sgst; cdn.push([isRegisteredIn(d) ? "Registered" : "Unregistered", d.contact.tax_number, d.contact.name, d.number, d.date.slice(0, 10), total, d.place_of_supply, pct(s.gst_bp), s.taxable, s.igst, s.cgst, s.sgst]); }
    addHsn(d, -1, slices);
  }
  const b2csRows = [...b2cs.values()].sort((a, b) => a.pos.localeCompare(b.pos) || a.gst - b.gst).map((g) => [g.pos, pct(g.gst), g.taxable, g.igst, g.cgst, g.sgst] as Cell[]);
  const hsnRows = [...hsn.values()].sort((a, b) => a.hsn.localeCompare(b.hsn) || a.gst - b.gst).map((h) => [h.hsn, pct(h.gst), h.qty, h.taxable, h.igst, h.cgst, h.sgst] as Cell[]);
  const sections: Section[] = [
    { key: "b2b", title: "4A - B2B invoices", columns: ["GSTIN", "Receiver", "Invoice", "Date", "Invoice value", "POS", "Reverse charge", "Rate %", "Taxable", "IGST", "CGST", "SGST"], rows: b2b },
    { key: "b2cl", title: "5 - B2C large (inter-state)", columns: ["Invoice", "Date", "Invoice value", "POS", "Rate %", "Taxable", "IGST"], rows: b2cl },
    { key: "b2cs", title: "7 - B2C small (summary)", columns: ["POS", "Rate %", "Taxable", "IGST", "CGST", "SGST"], rows: b2csRows },
    { key: "exp", title: "6A - Exports", columns: ["Invoice", "Date", "Invoice value", "Rate %", "Taxable", "IGST"], rows: exp },
    { key: "cdn", title: "9B - Credit notes (negative)", columns: ["Type", "GSTIN", "Receiver", "Note", "Date", "Note value", "POS", "Rate %", "Taxable", "IGST", "CGST", "SGST"], rows: cdn },
    { key: "hsn", title: "12 - HSN summary", columns: ["HSN/SAC", "Rate %", "Qty", "Taxable", "IGST", "CGST", "SGST"], rows: hsnRows },
  ];
  const totals = { invoices: inv.length, credit_notes: cns.length, taxable, igst, cgst, sgst, total_tax: igst + cgst + sgst };
  return finish(p, "gstr1", "GSTR-1 style outward supplies", conv, totals, sections, [...new Set(warnings)]);
}

export function buildGstr3b(invoices: RDoc[], credits: RDoc[], inputs: RInput[], p: ReportParams): Report {
  const conv = new Conv(p.currency, p.fx);
  const warnings: string[] = [];
  const acc = { taxable: 0, igst: 0, cgst: 0, sgst: 0, zero: 0, nil: 0 };
  const walk = (docs: RDoc[], sign: number) => {
    for (const d of docs) {
      if (!inPeriod(d.date, p)) continue;
      for (const s of gstSlices(d, sign, conv)) {
        if (isExport(d)) acc.zero += s.taxable;
        else if (d.reverse_charge) continue;
        else if (s.gst_bp === 0 && s.igst + s.cgst + s.sgst === 0) acc.nil += s.taxable;
        else { acc.taxable += s.taxable; acc.igst += s.igst; acc.cgst += s.cgst; acc.sgst += s.sgst; }
      }
    }
  };
  walk(invoices, 1);
  walk(credits, -1);
  let itc = 0, purchases = 0;
  const itcRows: Cell[][] = [];
  for (const r of inputs) {
    if (!inPeriod(r.date, p)) continue;
    const t = conv.to(r.tax_minor, r.currency, r.date);
    itc += t;
    purchases += conv.to(r.net_minor, r.currency, r.date);
    if (t !== 0) itcRows.push([r.source, r.number, r.supplier, r.date.slice(0, 10), conv.to(r.net_minor, r.currency, r.date), t]);
  }
  if (itc > 0) warnings.push("ITC is not split by IGST/CGST/SGST (supplier bills carry a single tax amount) and eligibility (blocked credits, Rule 42/43) is not assessed.");
  const outTax = acc.igst + acc.cgst + acc.sgst;
  const sections: Section[] = [
    { key: "outward", title: "3.1 - Outward supplies and tax liability", columns: ["Nature", "Taxable value", "IGST", "CGST", "SGST"], rows: [
      ["(a) Taxable outward supplies (net of credit notes)", acc.taxable, acc.igst, acc.cgst, acc.sgst],
      ["(b) Zero-rated (exports / SEZ)", acc.zero, null, null, null],
      ["(c) Nil-rated / exempt", acc.nil, null, null, null],
    ] },
    { key: "itc", title: "4 - Input tax credit (from supplier bills and expenses)", columns: ["Source", "Number", "Supplier", "Date", "Net", "Tax"], rows: itcRows },
    { key: "liability", title: "6 - Tax payable", columns: ["Item", "Amount"], rows: [["Outward tax", outTax], ["ITC available", itc], ["Net payable (negative = carry forward)", outTax - itc]] },
  ];
  const totals = { taxable: acc.taxable, igst: acc.igst, cgst: acc.cgst, sgst: acc.sgst, outward_tax: outTax, zero_rated: acc.zero, nil_rated: acc.nil, itc, purchases, net_payable: outTax - itc };
  return finish(p, "gstr3b", "GSTR-3B style summary", conv, totals, sections, warnings);
}

/* ---------- EU / UK ---------- */

function docCountry(d: RDoc): string | null {
  const c = (d.contact.country ?? d.place_of_supply ?? "").toUpperCase();
  return /^[A-Z]{2}$/.test(c) ? (c === "EL" ? "GR" : c) : null;
}

export function buildVatReturn(invoices: RDoc[], credits: RDoc[], inputs: RInput[], p: ReportParams): Report {
  const conv = new Conv(p.currency, p.fx);
  const warnings: string[] = [];
  const seller = (p.sellerCountry ?? "").toUpperCase();
  let salesNet = 0, salesVat = 0, euB2bNet = 0;
  const ecl = new Map<string, { vat: string; country: string; goods: number; services: number }>();
  const oss = new Map<string, { country: string; rate: number; taxable: number; vat: number }>();
  const walk = (docs: RDoc[], sign: number) => {
    for (const d of docs) {
      if (!inPeriod(d.date, p)) continue;
      const net = sign * conv.to(d.subtotal_minor, d.currency, d.date);
      const vat = sign * conv.to(d.tax_minor, d.currency, d.date);
      salesNet += net;
      salesVat += vat;
      const country = docCountry(d);
      const vatId = d.contact.tax_number ? d.contact.tax_number.replace(/\s/g, "").toUpperCase() : null;
      const isEu = country !== null && country !== seller && EU_MEMBER_STATES.includes(vatPrefixForCountry(country));
      if (p.regime === "eu_vat" && isEu && d.tax_minor === 0 && vatId && validateEuVat(vatId).valid) {
        euB2bNet += net;
        const e = ecl.get(vatId) ?? { vat: vatId, country: country!, goods: 0, services: 0 };
        if (d.reverse_charge) e.services += net; else e.goods += net;
        ecl.set(vatId, e);
      } else if (p.regime === "eu_vat" && isEu && !vatId && d.breakdown.some((b) => /OSS/i.test(b.name))) {
        for (const b of d.breakdown) {
          const k = `${country}|${b.rate_bp}`;
          const o = oss.get(k) ?? { country: country!, rate: b.rate_bp, taxable: 0, vat: 0 };
          o.taxable += sign * conv.to(b.taxable_minor, d.currency, d.date);
          o.vat += sign * conv.to(b.tax_minor, d.currency, d.date);
          oss.set(k, o);
        }
      } else if (!country) warnings.push(`${d.number}: customer country unknown.`);
      if (p.regime === "eu_vat" && isEu && d.contact.type === "b2b" && !vatId) warnings.push(`${d.number}: B2B customer ${d.contact.name ?? ""} has no VAT ID.`);
    }
  };
  walk(invoices, 1);
  walk(credits, -1);
  let inVat = 0, inNet = 0;
  for (const r of inputs) {
    if (!inPeriod(r.date, p)) continue;
    inVat += conv.to(r.tax_minor, r.currency, r.date);
    inNet += conv.to(r.net_minor, r.currency, r.date);
  }
  const uk = p.regime === "uk_vat";
  const boxes: Cell[][] = [
    ["Box 1", "VAT due on sales and other outputs", salesVat],
    ["Box 2", uk ? "VAT due on acquisitions from EU (Northern Ireland only; not tracked)" : "VAT due on intra-EU acquisitions (not tracked)", 0],
    ["Box 3", "Total VAT due", salesVat],
    ["Box 4", "VAT reclaimed on purchases and other inputs", inVat],
    ["Box 5", "Net VAT to pay (negative = reclaim)", salesVat - inVat],
    ["Box 6", "Total value of sales excl. VAT", salesNet],
    ["Box 7", "Total value of purchases excl. VAT", inNet],
    ["Box 8", uk ? "Total value of supplies to EU (NI goods)" : "Total value of intra-EU B2B supplies", uk ? 0 : euB2bNet],
    ["Box 9", "Total value of intra-EU acquisitions (not tracked)", 0],
  ];
  const sections: Section[] = [{ key: "boxes", title: uk ? "UK VAT return - 9 boxes" : "VAT return - box summary (generic EU layout; member-state forms differ)", columns: ["Box", "Description", "Amount"], rows: boxes }];
  if (!uk) {
    sections.push({ key: "ecl", title: "EC Sales List - reverse-charge / intra-Community supplies by customer VAT ID", columns: ["Customer VAT ID", "Country", "Goods", "Services"], rows: [...ecl.values()].sort((a, b) => a.vat.localeCompare(b.vat)).map((e) => [e.vat, e.country, e.goods, e.services]) });
    sections.push({ key: "oss", title: "OSS summary - B2C sales by destination country", columns: ["Country", "Rate %", "Taxable", "VAT"], rows: [...oss.values()].sort((a, b) => a.country.localeCompare(b.country) || a.rate - b.rate).map((o) => [o.country, pct(o.rate), o.taxable, o.vat]) });
  }
  if (inVat > 0) warnings.push("Input VAT is taken as stated on supplier bills and expenses; deductibility is not assessed.");
  const totals = { sales_net: salesNet, vat_due: salesVat, vat_reclaimed: inVat, net_vat: salesVat - inVat, purchases_net: inNet, eu_b2b_net: euB2bNet, oss_vat: [...oss.values()].reduce((s, o) => s + o.vat, 0) };
  return finish(p, uk ? "uk_vat9" : "eu_vat", uk ? "UK VAT 9-box summary" : "EU VAT return summary", conv, totals, sections, warnings);
}

/* ---------- US ---------- */

export function buildUsSales(invoices: RDoc[], credits: RDoc[], p: ReportParams): Report {
  const conv = new Conv(p.currency, p.fx);
  const warnings: string[] = [];
  const j = new Map<string, { st: string; gross: number; taxable: number; exempt: number; tax: number }>();
  const walk = (docs: RDoc[], sign: number) => {
    for (const d of docs) {
      if (!inPeriod(d.date, p)) continue;
      const st = d.place_of_supply ?? "UNKNOWN";
      if (st === "UNKNOWN") warnings.push(`${d.number}: ship-to state is not recorded.`);
      const g = j.get(st) ?? { st, gross: 0, taxable: 0, exempt: 0, tax: 0 };
      const net = sign * conv.to(d.subtotal_minor, d.currency, d.date);
      const tax = sign * conv.to(d.tax_minor, d.currency, d.date);
      g.gross += net;
      g.tax += tax;
      if (d.tax_minor > 0) g.taxable += net; else g.exempt += net;
      j.set(st, g);
      if (p.nexusStates && st !== "UNKNOWN" && !p.nexusStates.includes(st) && d.tax_minor > 0) warnings.push(`${d.number}: tax charged in ${st} where no nexus is configured.`);
    }
  };
  walk(invoices, 1);
  walk(credits, -1);
  const rows = [...j.values()].sort((a, b) => a.st.localeCompare(b.st));
  const totals = { gross_sales: rows.reduce((s, r) => s + r.gross, 0), taxable_sales: rows.reduce((s, r) => s + r.taxable, 0), exempt_or_nontaxable: rows.reduce((s, r) => s + r.exempt, 0), tax_collected: rows.reduce((s, r) => s + r.tax, 0) };
  const sections: Section[] = [{ key: "jurisdictions", title: "Sales tax liability by jurisdiction", columns: ["State", "Gross sales", "Taxable sales", "Exempt / non-taxable", "Tax collected"], rows: rows.map((r) => [r.st, r.gross, r.taxable, r.exempt, r.tax]) }];
  warnings.push("Tax is reported as collected on documents; sub-state (county/city/district) split is not available.");
  return finish(p, "us_sales", "US sales tax liability by jurisdiction", conv, totals, sections, warnings);
}

/** Dispatcher. India returns GSTR-1 and GSTR-3B combined in one report (3B sections appended). */
export function buildRegimeReport(invoices: RDoc[], credits: RDoc[], inputs: RInput[], p: ReportParams): Report {
  switch (p.regime) {
    case "india_gst": {
      const a = buildGstr1(invoices, credits, p);
      const b = buildGstr3b(invoices, credits, inputs, p);
      const base: Omit<Report, "report_hash"> = {
        ...a, kind: "gst", title: "GST: GSTR-1 and GSTR-3B style reports", totals: { ...a.totals, ...Object.fromEntries(Object.entries(b.totals).map(([k, v]) => [`gstr3b_${k}`, v])) },
        sections: [...a.sections, ...b.sections], warnings: [...new Set([...a.warnings, ...b.warnings])], fx_notes: [...new Set([...a.fx_notes, ...b.fx_notes])],
      };
      return { ...base, report_hash: hashReport(base) };
    }
    case "eu_vat":
    case "uk_vat": return buildVatReturn(invoices, credits, inputs, p);
    case "us_sales": return buildUsSales(invoices, credits, p);
    default: return buildVatReturn(invoices, credits, inputs, { ...p, regime: "eu_vat" });
  }
}

/* ---------- CSV ---------- */

function csvCell(v: Cell, money: boolean): string {
  if (v === null || v === undefined) return "";
  let s = typeof v === "number" ? (money && Number.isInteger(v) ? (v / 100).toFixed(2) : String(v)) : String(v);
  if (/^[=+\-@\t\r]/.test(s) && typeof v === "string") s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const MONEYISH = /value|taxable|igst|cgst|sgst|amount|net|tax$|goods|services|sales|collected|exempt|vat$|gross/i;
export function reportToCsv(r: Report): string {
  const out: string[] = [`# ${r.title}`, `# period ${r.period.from} to ${r.period.to}, currency ${r.currency}, hash ${r.report_hash}`];
  for (const s of r.sections) {
    out.push("", `# ${s.title}`, s.columns.map((c) => csvCell(c, false)).join(","));
    for (const row of s.rows) out.push(row.map((v, i) => csvCell(v, MONEYISH.test(s.columns[i] ?? "") && !/rate/i.test(s.columns[i] ?? ""))).join(","));
  }
  return out.join("\n") + "\n";
}

export { splitGstTotal };
