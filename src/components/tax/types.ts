import type { Report } from "@/lib/tax-compliance/reports";
import type { TaxProfile } from "@/lib/tax-compliance/regimes";

export type { Report, TaxProfile };
export interface Filing { id: string; regime: string; period_start: string; period_end: string; status: "draft" | "prepared" | "filed" | "void"; report_hash: string | null; filed_ref: string | null; filed_at: string | null; notes: string | null; created_at: string }
export interface EInvoiceRow { id: string; invoice_id: string; invoice_number: string | null; format: string; status: string; provider_ref: string | null; error: string | null; updated_at: string }
export interface Exemption { id: string; contact_id: string; contact_name: string | null; jurisdiction: string; certificate_ref: string | null; expires_at: string | null }
export const SPIN = "h-4 w-4 animate-spin motion-reduce:animate-none";
