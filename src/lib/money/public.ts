import { businessName, type QuoteDTO } from "./quotes";
import type { InvoiceDTO } from "./invoices";

/** Whitelisted shapes for anonymous share-link viewers. Never leak ids of other entities. */

export interface PublicQuote {
  number: string;
  status: QuoteDTO["status"];
  business: string;
  currency: string;
  items: QuoteDTO["items"];
  subtotal_minor: number;
  tax_minor: number;
  total_minor: number;
  valid_until: string | null;
  terms_version: string | null;
  terms_text: string | null;
  notes: string | null;
  contact_name: string | null;
  sent_at: string | null;
  accepted_at: string | null;
  expired: boolean;
}

export async function toPublicQuote(q: QuoteDTO, ownerId: string, expired: boolean): Promise<PublicQuote> {
  return {
    number: q.number,
    status: q.status,
    business: await businessName(ownerId),
    currency: q.currency,
    items: q.items,
    subtotal_minor: q.subtotal_minor,
    tax_minor: q.tax_minor,
    total_minor: q.total_minor,
    valid_until: q.valid_until,
    terms_version: q.terms_version,
    terms_text: q.terms_text,
    notes: q.notes,
    contact_name: q.contact_name,
    sent_at: q.sent_at,
    accepted_at: q.accepted_at,
    expired,
  };
}

export interface PublicInvoice {
  number: string;
  status: InvoiceDTO["status"];
  business: string;
  currency: string;
  items: InvoiceDTO["items"];
  subtotal_minor: number;
  tax_minor: number;
  total_minor: number;
  paid_minor: number;
  due_at: string | null;
  notes: string | null;
  contact_name: string | null;
  sent_at: string | null;
  paid_at: string | null;
}

export async function toPublicInvoice(inv: InvoiceDTO, ownerId: string): Promise<PublicInvoice> {
  return {
    number: inv.number,
    status: inv.status,
    business: await businessName(ownerId),
    currency: inv.currency,
    items: inv.items,
    subtotal_minor: inv.subtotal_minor,
    tax_minor: inv.tax_minor,
    total_minor: inv.total_minor,
    paid_minor: inv.paid_minor,
    due_at: inv.due_at,
    notes: inv.notes,
    contact_name: inv.contact_name,
    sent_at: inv.sent_at,
    paid_at: inv.paid_at,
  };
}
