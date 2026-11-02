import { createHash, randomInt, randomUUID } from "crypto";
import { query, queryOne } from "@/lib/dsql";
import { enqueueNotification } from "@/lib/notifications/outbox";
import { businessName, getQuoteById, quoteIsExpired, type QuoteDTO } from "./quotes";
import { createInvoiceFromQuote } from "./invoices";
import { reserveForQuote } from "@/lib/inventory/stock";

/**
 * Public quote acceptance: email OTP (6 digits, sha256-hashed, 10 min, 5
 * attempts) then an accept call that snapshots the consent (terms version +
 * text, IP, UA) so what the client agreed to is provable later.
 */

export const OTP_TTL_MS = 10 * 60_000;
export const OTP_MAX_ATTEMPTS = 5;

export function hashOtp(quoteId: string, email: string, otp: string): string {
  return createHash("sha256").update(`${quoteId}:${email.toLowerCase()}:${otp}`, "utf8").digest("hex");
}

function assertAcceptable(q: QuoteDTO): void {
  if (q.status === "accepted") throw new Error("This quote has already been accepted");
  if (q.status === "declined") throw new Error("This quote was declined");
  if (q.status === "draft") throw new Error("This quote has not been sent yet");
  if (quoteIsExpired(q) || q.status === "expired") throw new Error("This quote has expired");
}

export async function requestAcceptanceOtp(quoteId: string, email: string): Promise<{ ok: true; expiresAt: string }> {
  const q = await getQuoteById(quoteId);
  if (!q) throw new Error("Quote not found");
  assertAcceptable(q);
  const otp = String(randomInt(0, 1_000_000)).padStart(6, "0");
  const expiresAt = new Date(Date.now() + OTP_TTL_MS).toISOString();
  // One live challenge per quote+version+email: replace prior pending rows.
  await query(
    `DELETE FROM quote_acceptances WHERE quote_id = $1 AND accepted_at IS NULL AND lower(accepted_email) = lower($2)`,
    [quoteId, email]
  );
  await query(
    `INSERT INTO quote_acceptances (id, quote_id, version, otp_hash, otp_expires_at, otp_attempts, accepted_email)
     VALUES ($1, $2, $3, $4, $5, 0, $6)`,
    [randomUUID(), quoteId, q.current_version, hashOtp(quoteId, email, otp), expiresAt, email]
  );
  const owner = await ownerOf(quoteId);
  if (!owner) throw new Error("Quote not found");
  const from = await businessName(owner);
  await enqueueNotification(owner, {
    channel: "email",
    recipient: email,
    subject: `Your verification code for quote ${q.number}`,
    body: `Your one-time code to accept quote ${q.number} from ${from} is: ${otp}\n\nIt expires in 10 minutes. If you did not request this, ignore this email.`,
    data: { kind: "quote_otp", quote_id: quoteId, number: q.number },
  });
  return { ok: true, expiresAt };
}

async function ownerOf(quoteId: string): Promise<string | null> {
  const r = await queryOne<{ user_id: string }>(`SELECT user_id FROM quotes WHERE id = $1`, [quoteId]);
  return r?.user_id ?? null;
}

export interface AcceptInput {
  otp: string;
  name: string;
  email: string;
  ip: string | null;
  userAgent: string | null;
}

export async function acceptQuote(quoteId: string, input: AcceptInput): Promise<{ quote: QuoteDTO; invoiceId: string | null }> {
  const q = await getQuoteById(quoteId);
  if (!q) throw new Error("Quote not found");
  assertAcceptable(q);

  const row = await queryOne<{ id: string; otp_hash: string | null; otp_expires_at: string | null; otp_attempts: number; version: number }>(
    `SELECT id, otp_hash, otp_expires_at, otp_attempts, version FROM quote_acceptances
      WHERE quote_id = $1 AND accepted_at IS NULL AND lower(accepted_email) = lower($2)
      ORDER BY created_at DESC LIMIT 1`,
    [quoteId, input.email]
  );
  if (!row || !row.otp_hash) throw new Error("Request a verification code first");
  if (Number(row.version) !== q.current_version) throw new Error("The quote changed since the code was sent; request a new code");
  if (row.otp_expires_at && new Date(row.otp_expires_at).getTime() < Date.now()) throw new Error("Verification code expired; request a new one");
  if (Number(row.otp_attempts) >= OTP_MAX_ATTEMPTS) throw new Error("Too many attempts; request a new code");

  const good = hashOtp(quoteId, input.email, input.otp) === row.otp_hash;
  if (!good) {
    await query(`UPDATE quote_acceptances SET otp_attempts = otp_attempts + 1 WHERE id = $1`, [row.id]);
    throw new Error("Incorrect verification code");
  }

  await query(
    `UPDATE quote_acceptances
        SET accepted_at = NOW(), accepted_name = $2, accepted_email = $3, consent_terms_version = $4, consent_terms_text = $5,
            ip = $6, user_agent = $7, otp_hash = NULL
      WHERE id = $1`,
    [row.id, input.name, input.email, q.terms_version, q.terms_text, input.ip, input.userAgent?.slice(0, 500) ?? null]
  );
  await query(`UPDATE quotes SET status = 'accepted', accepted_at = NOW(), updated_at = NOW() WHERE id = $1`, [quoteId]);

  let invoiceId: string | null = null;
  const owner = await ownerOf(quoteId);
  if (owner) {
    try {
      await reserveForQuote(owner, quoteId, q.items);
    } catch (err) {
      // Insufficient stock or DB error: the quote stays accepted; surface to the owner via logs.
      console.error("[acceptance] stock reservation failed", err);
    }
    try {
      const inv = await createInvoiceFromQuote(owner, quoteId);
      invoiceId = inv.id;
    } catch (err) {
      console.error("[acceptance] auto-invoice failed", err);
    }
    await enqueueNotification(owner, {
      channel: "in_app",
      recipient: owner,
      subject: `Quote ${q.number} accepted`,
      body: `${input.name} (${input.email}) accepted quote ${q.number}.${invoiceId ? " A draft invoice was created." : ""}`,
      data: { kind: "quote_accepted", quote_id: quoteId, invoice_id: invoiceId },
    }).catch(() => undefined);
  }
  const out = await getQuoteById(quoteId);
  return { quote: out ?? q, invoiceId };
}
