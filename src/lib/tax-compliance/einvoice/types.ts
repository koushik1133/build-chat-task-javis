import type { VatCategory } from "../resolver";

/** Format-neutral invoice view that both e-invoice builders consume (pure, client-safe). */

export interface EParty {
  name: string;
  legal_name?: string | null;
  tax_id: string | null;
  /** ISO 3166-1 alpha-2 */
  country: string | null;
  /** India: 2-digit state code; elsewhere free text region. */
  state?: string | null;
  address_line1: string | null;
  city: string | null;
  postal_code: string | null;
  email?: string | null;
}

export interface ELineTaxPart { name: string; rate_bp: number; tax_minor: number }

export interface ELine {
  id: string;
  description: string;
  qty: number;
  unit_minor: number;
  net_minor: number;
  hsn_sac: string | null;
  is_service: boolean;
  category: VatCategory;
  /** Combined effective rate in basis points. */
  rate_bp: number;
  tax_minor: number;
  parts: ELineTaxPart[];
}

export interface ETaxSubtotal { category: VatCategory; rate_bp: number; taxable_minor: number; tax_minor: number }

export interface EDoc {
  kind: "invoice" | "credit_note";
  number: string;
  /** YYYY-MM-DD */
  issue_date: string;
  due_date: string | null;
  currency: string;
  seller: EParty;
  buyer: EParty;
  buyer_type: "b2b" | "b2c" | "exempt" | null;
  lines: ELine[];
  tax_subtotals: ETaxSubtotal[];
  subtotal_minor: number;
  tax_minor: number;
  total_minor: number;
  paid_minor: number;
  reverse_charge: boolean;
  exempt_reason_code: string | null;
  exempt_reason_text: string | null;
  place_of_supply: string | null;
  supply_kind: string | null;
  notes: string | null;
  payment_iban?: string | null;
  buyer_reference?: string | null;
}

export interface BuildResult<T> {
  ok: boolean;
  /** One entry per missing/invalid field. */
  errors: string[];
  warnings: string[];
  output: T | null;
}
