import { query, queryOne } from "@/lib/dsql";
import { getBranding } from "@/lib/branding";
import { businessName, type QuoteDTO } from "@/lib/money/quotes";
import type { InvoiceDTO } from "@/lib/money/invoices";
import { documentHash, renderInvoicePdf, renderQuotePdf, type SignatureStamp } from "./quote-document";

/**
 * Server-side glue between the money tables and the pure PDF renderers:
 * loads branding, the org timezone and the acceptance record, then renders.
 */

export interface AcceptanceRow {
  id: string;
  accepted_at: string;
  accepted_name: string | null;
  accepted_email: string | null;
  signature_text: string | null;
  ip: string | null;
  user_agent: string | null;
  consent_terms_version: string | null;
  consent_terms_text: string | null;
  document_hash: string | null;
  signed_document_hash: string | null;
}

/** Latest completed acceptance for a quote, or null. Tolerates the pre-migration column set. */
export async function getQuoteAcceptance(quoteId: string): Promise<AcceptanceRow | null> {
  const full = await queryOne<AcceptanceRow>(
    `SELECT id, accepted_at, accepted_name, accepted_email, signature_text, ip, user_agent,
            consent_terms_version, consent_terms_text, document_hash, signed_document_hash
       FROM quote_acceptances WHERE quote_id = $1 AND accepted_at IS NOT NULL
      ORDER BY accepted_at DESC LIMIT 1`,
    [quoteId]
  ).catch(() => undefined);
  if (full !== undefined) return full;
  const legacy = await queryOne<Omit<AcceptanceRow, "signature_text" | "document_hash" | "signed_document_hash">>(
    `SELECT id, accepted_at, accepted_name, accepted_email, ip, user_agent, consent_terms_version, consent_terms_text
       FROM quote_acceptances WHERE quote_id = $1 AND accepted_at IS NOT NULL
      ORDER BY accepted_at DESC LIMIT 1`,
    [quoteId]
  ).catch(() => null);
  return legacy ? { ...legacy, signature_text: null, document_hash: null, signed_document_hash: null } : null;
}

/** Timezone from organizations.settings JSON, falling back to UTC. */
export async function orgTimezone(dataId: string): Promise<string> {
  try {
    const org = await queryOne<{ settings: string | null }>(`SELECT settings FROM organizations WHERE owner_user_id = $1`, [dataId]);
    if (org?.settings) {
      const parsed: unknown = JSON.parse(org.settings);
      const tz = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>).timezone : null;
      if (typeof tz === "string" && tz.length <= 64) {
        new Intl.DateTimeFormat("en-US", { timeZone: tz });
        return tz;
      }
    }
  } catch {
    // invalid zone or settings → UTC
  }
  return "UTC";
}

async function docContext(dataId: string) {
  const [branding, timezone, business] = await Promise.all([getBranding(dataId), orgTimezone(dataId), businessName(dataId)]);
  return { branding, timezone, business };
}

function toStamp(a: AcceptanceRow, unsignedHash: string): SignatureStamp {
  return {
    name: a.accepted_name ?? "",
    email: a.accepted_email ?? "",
    signature_text: a.signature_text,
    signed_at: new Date(a.accepted_at).toISOString(),
    ip: a.ip,
    user_agent: a.user_agent,
    consent_terms_version: a.consent_terms_version,
    consent_terms_text: a.consent_terms_text,
    document_hash: a.document_hash ?? unsignedHash,
  };
}

export interface BuiltPdf {
  bytes: Uint8Array;
  filename: string;
  hash: string;
  signed: boolean;
}

/** Quote PDF for its owner org; stamped when an acceptance exists. */
export async function buildQuotePdf(dataId: string, quote: QuoteDTO, opts: { redactEvidence?: boolean } = {}): Promise<BuiltPdf> {
  const [{ branding, timezone, business }, acceptance] = await Promise.all([docContext(dataId), getQuoteAcceptance(quote.id)]);
  const unsigned = renderQuotePdf(quote, null, branding, { business, timezone });
  if (!acceptance) return { bytes: unsigned, filename: `Quote-${quote.number}.pdf`, hash: documentHash(unsigned), signed: false };
  // The fingerprint is always of the unsigned document, so redaction never changes what was signed.
  const stamped = renderQuotePdf(quote, toStamp(acceptance, documentHash(unsigned)), branding, { business, timezone, redactEvidence: opts.redactEvidence });
  return { bytes: stamped, filename: `Quote-${quote.number}-signed.pdf`, hash: documentHash(stamped), signed: true };
}

export async function buildInvoicePdf(dataId: string, invoice: InvoiceDTO): Promise<BuiltPdf> {
  const { branding, timezone, business } = await docContext(dataId);
  let quote_number: string | null = null;
  if (invoice.quote_id) {
    const q = await queryOne<{ number: string }>(`SELECT number FROM quotes WHERE id = $1`, [invoice.quote_id]).catch(() => null);
    quote_number = q?.number ?? null;
  }
  const bytes = renderInvoicePdf({ ...invoice, quote_number }, branding, { business, timezone });
  return { bytes, filename: `Invoice-${invoice.number}.pdf`, hash: documentHash(bytes), signed: false };
}

/**
 * Called from the acceptance flow right after the row is marked accepted:
 * fingerprints the unsigned document, renders the stamped version and stores
 * both hashes (plus the typed signature) on the acceptance row.
 */
export async function fingerprintAcceptance(dataId: string, quote: QuoteDTO, acceptanceId: string, signatureText: string | null): Promise<{ document_hash: string; signed_document_hash: string } | null> {
  const { branding, timezone, business } = await docContext(dataId);
  const row = await queryOne<AcceptanceRow>(
    `SELECT id, accepted_at, accepted_name, accepted_email, NULL::text AS signature_text, ip, user_agent,
            consent_terms_version, consent_terms_text, NULL::text AS document_hash, NULL::text AS signed_document_hash
       FROM quote_acceptances WHERE id = $1`,
    [acceptanceId]
  );
  if (!row || !row.accepted_at) return null;
  const unsigned = renderQuotePdf(quote, null, branding, { business, timezone });
  const document_hash = documentHash(unsigned);
  const stamp = toStamp({ ...row, signature_text: signatureText, document_hash }, document_hash);
  const signed = renderQuotePdf({ ...quote, status: "accepted" }, stamp, branding, { business, timezone });
  const signed_document_hash = documentHash(signed);
  await query(
    `UPDATE quote_acceptances SET signature_text = $2, document_hash = $3, signed_document_hash = $4 WHERE id = $1`,
    [acceptanceId, signatureText, document_hash, signed_document_hash]
  );
  return { document_hash, signed_document_hash };
}

/** Standard PDF response headers. */
export function pdfResponse(built: BuiltPdf, disposition: "inline" | "attachment" = "inline"): Response {
  const safe = built.filename.replace(/[^A-Za-z0-9._-]/g, "_");
  return new Response(Buffer.from(built.bytes), {
    status: 200,
    headers: {
      "Content-Type": "application/pdf",
      "Content-Length": String(built.bytes.byteLength),
      "Content-Disposition": `${disposition}; filename="${safe}"`,
      "Cache-Control": "private, no-store",
      "X-Document-SHA256": built.hash,
    },
  });
}
