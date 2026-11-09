import { createHash } from "crypto";
import { IN_STATE_CODES, validateGstin } from "../validators";
import type { BuildResult, EDoc } from "./types";

/**
 * India e-invoice payload in the shape of the NIC/IRP schema (v1.1) - generation only.
 * Amounts are decimal rupees (two places). Submission is SIMULATED (see simulateIrpSubmission);
 * no government endpoint is ever called.
 */

const inr = (minor: number): number => Math.round(minor) / 100;
const ddmmyyyy = (iso: string): string => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;

export interface IrpPayload {
  Version: string;
  TranDtls: { TaxSch: "GST"; SupTyp: string; RegRev: "Y" | "N"; IgstOnIntra: "N" };
  DocDtls: { Typ: "INV" | "CRN"; No: string; Dt: string };
  SellerDtls: { Gstin: string; LglNm: string; Addr1: string; Loc: string; Pin: number; Stcd: string };
  BuyerDtls: { Gstin: string; LglNm: string; Pos: string; Addr1: string; Loc: string; Pin: number; Stcd: string };
  ItemList: Array<{
    SlNo: string; PrdDesc: string; IsServc: "Y" | "N"; HsnCd: string; Qty: number; Unit: string; UnitPrice: number; TotAmt: number; Discount: number;
    AssAmt: number; GstRt: number; IgstAmt: number; CgstAmt: number; SgstAmt: number; CesRt: number; CesAmt: number; TotItemVal: number;
  }>;
  ValDtls: { AssVal: number; CgstVal: number; SgstVal: number; IgstVal: number; CesVal: number; Discount: number; OthChrg: number; RndOffAmt: number; TotInvVal: number };
}

const DOC_NO_RE = /^[A-Za-z1-9][A-Za-z0-9/-]{0,15}$/;

export function validateForIrp(d: EDoc): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!DOC_NO_RE.test(d.number)) errors.push("Document number must be 1-16 characters (letters, digits, / and -) and not start with 0");
  if (!d.issue_date) errors.push("Document date is missing");
  const sg = d.seller.tax_id ? validateGstin(d.seller.tax_id) : null;
  if (!d.seller.tax_id) errors.push("Seller GSTIN is missing");
  else if (!sg?.valid) errors.push(`Seller GSTIN invalid: ${sg?.reason}`);
  if (!d.seller.address_line1) errors.push("Seller address line is missing");
  if (!d.seller.city) errors.push("Seller location (city) is missing");
  if (!/^\d{6}$/.test(d.seller.postal_code ?? "")) errors.push("Seller PIN code must be 6 digits");
  const isExport = d.supply_kind === "export";
  if (d.buyer_type === "b2c") errors.push("E-invoicing applies to B2B, SEZ and export supplies; this buyer is marked B2C");
  const bg = d.buyer.tax_id ? validateGstin(d.buyer.tax_id) : null;
  if (!isExport) {
    if (!d.buyer.tax_id) errors.push("Buyer GSTIN is missing (required for B2B e-invoices)");
    else if (!bg?.valid) errors.push(`Buyer GSTIN invalid: ${bg?.reason}`);
  }
  if (!d.buyer.name) errors.push("Buyer legal name is missing");
  if (!d.buyer.address_line1) errors.push("Buyer address line is missing");
  if (!d.buyer.city) errors.push("Buyer location (city) is missing");
  if (!isExport && !/^\d{6}$/.test(d.buyer.postal_code ?? "")) errors.push("Buyer PIN code must be 6 digits");
  if (!d.place_of_supply || (!isExport && !IN_STATE_CODES[d.place_of_supply])) errors.push("Place of supply (state code) is missing");
  if (d.lines.length === 0) errors.push("At least one item is required");
  d.lines.forEach((l, i) => {
    if (!l.hsn_sac) errors.push(`Item ${i + 1} (${l.description.slice(0, 30)}): HSN/SAC code is missing`);
    else if (!/^\d{4,8}$/.test(l.hsn_sac)) errors.push(`Item ${i + 1}: HSN/SAC must be 4-8 digits`);
  });
  if (d.currency !== "INR") warnings.push("Document currency is not INR: IRP expects values in INR; verify conversion.");
  return { errors, warnings };
}

function supplyType(d: EDoc): string {
  if (d.supply_kind === "export") return d.tax_minor === 0 ? "EXPWOP" : "EXPWP";
  if (d.supply_kind === "sez") return d.tax_minor === 0 ? "SEZWOP" : "SEZWP";
  return "B2B";
}

export function buildIrpJson(d: EDoc): BuildResult<IrpPayload> {
  const { errors, warnings } = validateForIrp(d);
  if (errors.length > 0) return { ok: false, errors, warnings, output: null };
  const sellerState = d.seller.tax_id!.slice(0, 2);
  const items: IrpPayload["ItemList"] = d.lines.map((l, i) => {
    const part = (n: string) => l.parts.filter((p) => p.name === n).reduce((s, p) => s + p.tax_minor, 0);
    const cg = part("CGST");
    const sg = part("SGST");
    const ig = part("IGST");
    return {
      SlNo: String(i + 1), PrdDesc: l.description.slice(0, 300), IsServc: l.is_service ? "Y" : "N", HsnCd: l.hsn_sac!, Qty: l.qty, Unit: "OTH",
      UnitPrice: inr(l.unit_minor), TotAmt: inr(l.net_minor), Discount: 0, AssAmt: inr(l.net_minor), GstRt: l.rate_bp / 100,
      IgstAmt: inr(ig), CgstAmt: inr(cg), SgstAmt: inr(sg), CesRt: 0, CesAmt: 0, TotItemVal: inr(l.net_minor + l.tax_minor),
    };
  });
  const sum = (k: "AssAmt" | "CgstAmt" | "SgstAmt" | "IgstAmt" | "TotItemVal") => Math.round(items.reduce((s, it) => s + it[k], 0) * 100) / 100;
  const totItems = sum("TotItemVal");
  const out: IrpPayload = {
    Version: "1.1",
    TranDtls: { TaxSch: "GST", SupTyp: supplyType(d), RegRev: d.reverse_charge ? "Y" : "N", IgstOnIntra: "N" },
    DocDtls: { Typ: d.kind === "credit_note" ? "CRN" : "INV", No: d.number, Dt: ddmmyyyy(d.issue_date) },
    SellerDtls: { Gstin: d.seller.tax_id!, LglNm: d.seller.legal_name ?? d.seller.name, Addr1: d.seller.address_line1!, Loc: d.seller.city!, Pin: Number(d.seller.postal_code), Stcd: sellerState },
    BuyerDtls: {
      Gstin: d.supply_kind === "export" ? "URP" : d.buyer.tax_id!, LglNm: d.buyer.legal_name ?? d.buyer.name, Pos: d.supply_kind === "export" ? "96" : d.place_of_supply!,
      Addr1: d.buyer.address_line1!, Loc: d.buyer.city!, Pin: d.supply_kind === "export" ? 999999 : Number(d.buyer.postal_code), Stcd: d.supply_kind === "export" ? "96" : (d.buyer.tax_id ?? d.place_of_supply!).slice(0, 2),
    },
    ItemList: items,
    ValDtls: {
      AssVal: sum("AssAmt"), CgstVal: sum("CgstAmt"), SgstVal: sum("SgstAmt"), IgstVal: sum("IgstAmt"), CesVal: 0, Discount: 0, OthChrg: 0,
      RndOffAmt: Math.round((inr(d.total_minor) - totItems) * 100) / 100, TotInvVal: inr(d.total_minor),
    },
  };
  return { ok: true, errors: [], warnings, output: out };
}

/** Indian financial year label, e.g. 2025-04-10 -> "2025-26". */
export function financialYear(isoDate: string): string {
  const y = Number(isoDate.slice(0, 4));
  const m = Number(isoDate.slice(5, 7));
  const start = m >= 4 ? y : y - 1;
  return `${start}-${String((start + 1) % 100).padStart(2, "0")}`;
}

export interface IrpAck { irn: string; ack_no: string; ack_dt: string; qr: string; simulated: true }

/** SIMULATED IRP response: IRN = SHA-256(GSTIN + FY + doc type + doc no) as the scheme defines; ack/QR are fake. */
export function simulateIrpSubmission(p: IrpPayload, isoDate: string, now: Date = new Date()): IrpAck {
  const irn = createHash("sha256").update(`${p.SellerDtls.Gstin}${financialYear(isoDate)}${p.DocDtls.Typ}${p.DocDtls.No}`).digest("hex");
  const ack_no = String(BigInt("0x" + irn.slice(0, 12)) % 1_000_000_000_000_000n).padStart(15, "1");
  const ack_dt = now.toISOString().replace("T", " ").slice(0, 19);
  const qr = JSON.stringify({
    SellerGstin: p.SellerDtls.Gstin, BuyerGstin: p.BuyerDtls.Gstin, DocNo: p.DocDtls.No, DocTyp: p.DocDtls.Typ, DocDt: p.DocDtls.Dt,
    TotInvVal: p.ValDtls.TotInvVal, ItemCnt: p.ItemList.length, MainHsnCode: p.ItemList[0]?.HsnCd ?? "", Irn: irn, IrnDt: ack_dt, Simulated: true,
  });
  return { irn, ack_no, ack_dt, qr, simulated: true };
}
