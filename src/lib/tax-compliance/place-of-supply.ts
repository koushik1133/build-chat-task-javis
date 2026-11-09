import { IN_STATE_CODES, gstinState } from "./validators";

/** Place-of-supply determination (pure). Rules are summarised from IGST Act s.10-13; verify edge cases with an accountant. */

export type IndiaSupplyKind = "intra" | "inter" | "export" | "sez";

export interface IndiaPosInput {
  supplierState: string | null; // 2-digit code
  buyerGstin?: string | null;
  buyerState?: string | null; // code or name
  shipToState?: string | null; // code or name
  buyerCountry?: string | null; // ISO, non-IN => export
  buyerIsSez?: boolean;
  supply: "goods" | "services";
}

export interface IndiaPos {
  /** 2-digit state code, "96" = foreign country, null = undetermined */
  code: string | null;
  kind: IndiaSupplyKind;
  warning?: string;
}

/** Accept "29", "Karnataka" or a GSTIN-led code. */
export function indiaStateCode(v: string | null | undefined): string | null {
  const s = (v ?? "").trim();
  if (!s) return null;
  if (/^\d{2}$/.test(s) && IN_STATE_CODES[s]) return s;
  const lower = s.toLowerCase();
  for (const [code, name] of Object.entries(IN_STATE_CODES)) if (name.toLowerCase() === lower) return code;
  return null;
}

export function indiaPlaceOfSupply(i: IndiaPosInput): IndiaPos {
  const country = (i.buyerCountry ?? "").toUpperCase();
  if (country && country !== "IN") return { code: "96", kind: "export" };
  const fromGstin = gstinState(i.buyerGstin);
  const ship = indiaStateCode(i.shipToState);
  const buyer = fromGstin ?? indiaStateCode(i.buyerState);
  // Goods: where delivery ends; services: recipient location (registered) else recipient address, else supplier location.
  let code = i.supply === "goods" ? ship ?? buyer : buyer ?? ship;
  let warning: string | undefined;
  if (!code) {
    code = i.supplierState;
    warning = "Place of supply could not be determined; assumed same state as supplier (intra-state).";
  }
  if (i.buyerIsSez) return { code, kind: "sez", warning };
  if (!i.supplierState || !code) return { code, kind: "intra", warning: warning ?? "Supplier state unknown." };
  return { code, kind: code === i.supplierState ? "intra" : "inter", warning };
}
