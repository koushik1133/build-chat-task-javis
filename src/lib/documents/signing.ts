import { createHash, randomInt, timingSafeEqual } from "crypto";
import { query, queryOne } from "@/lib/dsql";
import { recordAudit } from "@/lib/audit";
import { emitEvent } from "@/lib/events/bus";
import { enqueueNotification } from "@/lib/notifications/outbox";
import { issueShareToken, resolveShareTokenDetailed, type ShareTokenRow } from "@/lib/share-tokens";
import { businessName } from "@/lib/money/quotes";
import { assertRecipientMatches, OTP_MAX_ATTEMPTS, OTP_TTL_MS } from "@/lib/money/acceptance";
import { CONSENT_TEXT } from "@/lib/pdf/quote-document";
import { uploadAttachment } from "@/lib/attachments/store";
import type { AttachmentEntityKind } from "@/lib/attachments/types";
import { buildDocumentPdf, buildUnsignedPdf, DocumentError, getDocument, getDocumentById, listSigners, referenceFor, signerToDto, type SignerRow } from "./documents";
import { emailHint, type DocumentDTO, type DocumentSignerDTO, type PublicDocument } from "./types";

/**
 * E-sign flow, mirroring quote acceptance: one recipient-bound share token
 * per signer, email OTP (purpose-scoped hash, 10 min, 5 attempts), typed
 * signature + consent snapshot (IP, UA, consent text), sequential or parallel
 * order, completion stamps a signature certificate and attaches the PDF.
 */

export type SignOtpPurpose = "sign" | "decline";
export const SIGN_OTP_PURPOSES: readonly SignOtpPurpose[] = ["sign", "decline"];
export const DEFAULT_SIGN_TTL_DAYS = 30;

/** Purpose is part of the hash so a sign code can never be replayed to decline (or vice versa). */
export function hashSignOtp(signerId: string, email: string, otp: string, purpose: SignOtpPurpose): string {
  return createHash("sha256").update(`${signerId}:${email.toLowerCase()}:${purpose}:${otp}`, "utf8").digest("hex");
}

/* ─── order logic (pure, exported for tests) ─────────────────────────────── */

export interface OrderSigner {
  id: string;
  order_index: number;
  status: string;
}

/** True when `signer` may act now: parallel → anyone pending; sequential → every lower index already signed. */
export function isSignersTurn(order: "sequential" | "parallel", signers: OrderSigner[], signerId: string): boolean {
  const me = signers.find((s) => s.id === signerId);
  if (!me || me.status === "signed" || me.status === "declined") return false;
  if (order === "parallel") return true;
  return signers.filter((s) => s.order_index < me.order_index).every((s) => s.status === "signed");
}

/** Signers who should receive their link right now (first unsigned in sequence, or everyone pending). */
export function signersToNotify(order: "sequential" | "parallel", signers: OrderSigner[]): OrderSigner[] {
  const pending = [...signers].filter((s) => s.status !== "signed" && s.status !== "declined").sort((a, b) => a.order_index - b.order_index);
  if (order === "parallel") return pending;
  return pending.length ? [pending[0]] : [];
}

export function allSigned(signers: OrderSigner[]): boolean {
  return signers.length > 0 && signers.every((s) => s.status === "signed");
}

/* ─── send ───────────────────────────────────────────────────────────────── */

async function notifySigner(dataId: string, doc: DocumentDTO, signer: SignerRow, message: string | null): Promise<{ url: string }> {
  const link = await issueShareToken(dataId, "sign", signer.id, ttlDays(doc), { recipient: signer.email });
  const from = await businessName(dataId);
  await enqueueNotification(dataId, {
    channel: "email",
    recipient: signer.email,
    subject: `Please sign: ${doc.title}`,
    body:
      `${message?.trim() ? message.trim() + "\n\n" : ""}` +
      `${from} has sent you "${doc.title}" to review and sign electronically.\n\n` +
      `Open and sign it here: ${link.url}\n\n` +
      (doc.expires_at ? `Please sign by ${new Date(doc.expires_at).toDateString()}.\n` : ""),
    data: { kind: "document_sign", document_id: doc.id, signer_id: signer.id, url: link.url },
  });
  return { url: link.url };
}

function ttlDays(doc: DocumentDTO): number {
  if (!doc.expires_at) return DEFAULT_SIGN_TTL_DAYS;
  return Math.max(1, Math.ceil((new Date(doc.expires_at).getTime() - Date.now()) / 86_400_000));
}

export interface SendOptions {
  message?: string | null;
  expires_in_days?: number | null;
}

/**
 * Freeze the body (fingerprint the unsigned PDF), mark sent and email the
 * signers whose turn it is. Re-sending a `sent`/`viewed` document re-emails
 * the current signers without changing the hash.
 */
export async function sendForSignature(dataId: string, documentId: string, opts: SendOptions = {}, actorId?: string | null): Promise<{ document: DocumentDTO; notified: Array<{ signer_id: string; email: string; url: string }> }> {
  const doc = await getDocument(dataId, documentId);
  if (!doc) throw new DocumentError("Document not found", 404);
  if (!["draft", "sent", "viewed"].includes(doc.status)) throw new DocumentError(`Document is ${doc.status} and cannot be sent`);
  if (doc.signers.length === 0) throw new DocumentError("Add at least one signer before sending");
  if (!doc.body_md.trim()) throw new DocumentError("Document body is empty");

  if (doc.status === "draft") {
    const built = await buildUnsignedPdf(dataId, doc);
    const expiresAt = opts.expires_in_days ? new Date(Date.now() + opts.expires_in_days * 86_400_000).toISOString() : (doc.expires_at ?? new Date(Date.now() + DEFAULT_SIGN_TTL_DAYS * 86_400_000).toISOString());
    await query(`UPDATE documents SET status = 'sent', sent_at = NOW(), pdf_hash = $3, expires_at = $4, updated_at = NOW() WHERE user_id = $1 AND id = $2`, [dataId, documentId, built.hash, expiresAt]);
  }
  const fresh = (await getDocument(dataId, documentId)) ?? doc;
  const signers = await listSigners(documentId);
  const targets = signersToNotify(fresh.signing_order, signers);
  const notified: Array<{ signer_id: string; email: string; url: string }> = [];
  for (const t of targets) {
    const s = signers.find((x) => x.id === t.id)!;
    const { url } = await notifySigner(dataId, fresh, s, opts.message ?? null);
    notified.push({ signer_id: s.id, email: s.email, url });
  }
  void recordAudit({ dataId, userId: actorId ?? null }, { action: "document.sent", entity: "document", entityId: documentId, after: { signers: notified.map((n) => n.email), order: fresh.signing_order } });
  if (doc.status === "draft") {
    void emitEvent(dataId, { type: "document.sent", entity: "document", entityId: documentId, data: { title: fresh.title, kind: fresh.kind, signers: notified.map((n) => n.email), contact_id: fresh.contact_id } });
  }
  return { document: fresh, notified };
}

/* ─── public (token) side ────────────────────────────────────────────────── */

export interface SignerContext {
  share: ShareTokenRow;
  signer: SignerRow;
  doc: DocumentDTO & { user_id: string };
}

export class SignLinkError extends Error {
  constructor(public readonly code: "not_found" | "expired", message: string) {
    super(message);
    this.name = "SignLinkError";
  }
}

export async function resolveSigner(token: string): Promise<SignerContext> {
  const lookup = await resolveShareTokenDetailed("sign", token);
  if (lookup.expired) throw new SignLinkError("expired", "This signing link has expired");
  if (!lookup.row) throw new SignLinkError("not_found", "This signing link is not valid");
  const signer = await queryOne<SignerRow & { document_id: string }>(`SELECT document_id, id, name, email, role, order_index, status, signed_at, signature_text, decline_reason FROM document_signers WHERE id = $1 AND user_id = $2`, [lookup.row.entity_id, lookup.row.user_id]);
  if (!signer) throw new SignLinkError("not_found", "This signing link is not valid");
  const doc = await getDocumentById(signer.document_id);
  if (!doc || doc.user_id !== lookup.row.user_id) throw new SignLinkError("not_found", "This signing link is not valid");
  return { share: lookup.row, signer, doc };
}

function docIsExpired(doc: DocumentDTO): boolean {
  return doc.status === "expired" || Boolean(doc.expires_at && new Date(doc.expires_at).getTime() < Date.now() && doc.status !== "signed");
}

function assertSignable(doc: DocumentDTO): void {
  if (doc.status === "signed") throw new DocumentError("This document has already been fully signed");
  if (doc.status === "declined") throw new DocumentError("This document was declined");
  if (doc.status === "void") throw new DocumentError("This document was withdrawn by the sender");
  if (doc.status === "draft") throw new DocumentError("This document has not been sent yet");
  if (docIsExpired(doc)) throw new DocumentError("This document has expired");
}

/** Whitelisted view for the signer page; marks viewed on first open. */
export async function publicDocumentForToken(token: string): Promise<PublicDocument> {
  const { share, signer, doc } = await resolveSigner(token);
  const business = await businessName(share.user_id);
  if (signer.status === "pending" && (doc.status === "sent" || doc.status === "viewed")) {
    await query(`UPDATE document_signers SET status = 'viewed' WHERE id = $1 AND status = 'pending'`, [signer.id]).catch(() => undefined);
    signer.status = "viewed";
  }
  if (doc.status === "sent") {
    await query(`UPDATE documents SET status = 'viewed', viewed_at = COALESCE(viewed_at, NOW()), updated_at = NOW() WHERE id = $1 AND status = 'sent'`, [doc.id]).catch(() => undefined);
    doc.status = "viewed";
    void emitEvent(share.user_id, { type: "document.viewed", entity: "document", entityId: doc.id, data: { title: doc.title, signer_email: signer.email } });
  }
  const signers = doc.signers.map((s) => (s.id === signer.id ? { ...s, status: signer.status } : s));
  const open = (["sent", "viewed"] as string[]).includes(doc.status);
  const turn = open && !docIsExpired(doc) && isSignersTurn(doc.signing_order, signers, signer.id);
  const waiting = doc.signing_order === "sequential" && !turn ? signers.filter((s) => s.order_index < signerOrder(signers, signer.id) && s.status !== "signed").sort((a, b) => a.order_index - b.order_index)[0] : null;
  return {
    title: doc.title,
    kind: doc.kind,
    business,
    body_md: doc.body_md,
    status: docIsExpired(doc) && doc.status !== "signed" ? "expired" : doc.status,
    expires_at: doc.expires_at,
    completed_at: doc.completed_at,
    signer: { name: signer.name, email_hint: emailHint(signer.email), role: signer.role, status: signer.status, signed_at: signer.signed_at ? new Date(signer.signed_at).toISOString() : null },
    your_turn: turn,
    waiting_on: waiting ? waiting.name : null,
    others: signers.filter((s) => s.id !== signer.id).map((s) => ({ name: s.name, role: s.role, status: s.status })),
    pdf_hash: doc.pdf_hash,
    signed_pdf_hash: doc.signed_pdf_hash,
  };
}

function signerOrder(signers: DocumentSignerDTO[], id: string): number {
  return signers.find((s) => s.id === id)?.order_index ?? 0;
}

/* ─── OTP ────────────────────────────────────────────────────────────────── */

export async function requestSignOtp(token: string, email: string, purpose: SignOtpPurpose): Promise<{ ok: true; expiresAt: string }> {
  const { share, signer, doc } = await resolveSigner(token);
  assertRecipientMatches(email, share.recipient ?? signer.email);
  assertSignable(doc);
  if (signer.status === "signed") throw new DocumentError("You have already signed this document");
  if (purpose === "sign" && !isSignersTurn(doc.signing_order, doc.signers, signer.id)) throw new DocumentError("It is not your turn to sign yet; you will be emailed when it is");
  const otp = String(randomInt(0, 1_000_000)).padStart(6, "0");
  const expiresAt = new Date(Date.now() + OTP_TTL_MS).toISOString();
  await query(`UPDATE document_signers SET otp_hash = $2, otp_expires_at = $3, otp_attempts = 0 WHERE id = $1`, [signer.id, hashSignOtp(signer.id, email, otp, purpose), expiresAt]);
  const from = await businessName(share.user_id);
  await enqueueNotification(share.user_id, {
    channel: "email",
    recipient: email,
    subject: `Your verification code for "${doc.title}"`,
    body: `Your one-time code to ${purpose} "${doc.title}" from ${from} is: ${otp}\n\nIt expires in 10 minutes. If you did not request this, ignore this email.`,
    data: { kind: "document_otp", document_id: doc.id, signer_id: signer.id, purpose },
  });
  return { ok: true, expiresAt };
}

async function verifySignOtp(signerId: string, email: string, otp: string, purpose: SignOtpPurpose): Promise<void> {
  const row = await queryOne<{ otp_hash: string | null; otp_expires_at: string | Date | null; otp_attempts: number }>(`SELECT otp_hash, otp_expires_at, otp_attempts FROM document_signers WHERE id = $1`, [signerId]);
  if (!row || !row.otp_hash) throw new DocumentError("Request a verification code first");
  if (row.otp_expires_at && new Date(row.otp_expires_at).getTime() < Date.now()) throw new DocumentError("Verification code expired; request a new one");
  if (Number(row.otp_attempts) >= OTP_MAX_ATTEMPTS) throw new DocumentError("Too many attempts; request a new code");
  const expected = hashSignOtp(signerId, email, otp, purpose);
  const good = expected.length === row.otp_hash.length && timingSafeEqual(Buffer.from(expected), Buffer.from(row.otp_hash));
  if (!good) {
    await query(`UPDATE document_signers SET otp_attempts = otp_attempts + 1 WHERE id = $1`, [signerId]);
    throw new DocumentError("Incorrect verification code");
  }
}

/* ─── sign / decline ─────────────────────────────────────────────────────── */

export interface SignInput {
  otp: string;
  email: string;
  signature_text: string;
  name?: string | null;
  ip: string | null;
  userAgent: string | null;
}

export async function signWithToken(token: string, input: SignInput): Promise<{ document: PublicDocument; completed: boolean }> {
  const { share, signer, doc } = await resolveSigner(token);
  assertRecipientMatches(input.email, share.recipient ?? signer.email);
  assertSignable(doc);
  if (signer.status === "signed") throw new DocumentError("You have already signed this document");
  if (!isSignersTurn(doc.signing_order, doc.signers, signer.id)) throw new DocumentError("It is not your turn to sign yet");
  await verifySignOtp(signer.id, input.email, input.otp, "sign");
  const signature = input.signature_text.trim().slice(0, 200) || signer.name;
  await query(
    `UPDATE document_signers SET status = 'signed', signed_at = NOW(), signature_text = $2, name = COALESCE(NULLIF($3, ''), name), ip = $4, user_agent = $5, consent_text = $6, otp_hash = NULL WHERE id = $1`,
    [signer.id, signature, input.name?.trim().slice(0, 200) ?? "", input.ip, input.userAgent?.slice(0, 500) ?? null, CONSENT_TEXT]
  );
  void recordAudit({ dataId: share.user_id, userId: null }, { action: "document.signer_signed", entity: "document", entityId: doc.id, after: { signer_id: signer.id, email: signer.email } });

  const signers = await listSigners(doc.id);
  let completed = false;
  if (allSigned(signers)) {
    completed = true;
    await completeDocument(share.user_id, doc.id);
  } else if (doc.signing_order === "sequential") {
    const next = signersToNotify("sequential", signers)[0];
    const nextRow = next ? signers.find((s) => s.id === next.id) : null;
    if (nextRow) {
      const fresh = (await getDocument(share.user_id, doc.id)) ?? doc;
      await notifySigner(share.user_id, fresh, nextRow, null).catch((err) => console.error("[documents] next signer notify failed", err));
    }
  }
  return { document: await publicDocumentForToken(token), completed };
}

/** All signers signed: stamp, hash, attach, notify. */
async function completeDocument(dataId: string, documentId: string): Promise<void> {
  await query(`UPDATE documents SET status = 'signed', completed_at = NOW(), updated_at = NOW() WHERE user_id = $1 AND id = $2`, [dataId, documentId]);
  const doc = await getDocument(dataId, documentId);
  if (!doc) return;
  try {
    const built = await buildDocumentPdf(dataId, doc);
    await query(`UPDATE documents SET signed_pdf_hash = $3 WHERE user_id = $1 AND id = $2`, [dataId, documentId, built.hash]);
    const targets: Array<{ kind: AttachmentEntityKind; id: string }> = [{ kind: "document", id: doc.id }];
    if (doc.contact_id) targets.push({ kind: "contact", id: doc.contact_id });
    if (doc.record_id) targets.push({ kind: "record", id: doc.record_id });
    if (doc.quote_id) targets.push({ kind: "quote", id: doc.quote_id });
    for (const t of targets) {
      await uploadAttachment(dataId, { entityKind: t.kind, entityId: t.id, fileName: built.filename, declaredType: "application/pdf", bytes: Buffer.from(built.bytes), visibility: "portal", uploadedBy: null }).catch((err) => console.error("[documents] attach signed pdf failed", err));
    }
  } catch (err) {
    console.error("[documents] signed pdf build failed", err);
  }
  void emitEvent(dataId, { type: "document.signed", entity: "document", entityId: documentId, data: { title: doc.title, kind: doc.kind, contact_id: doc.contact_id, signers: doc.signers.map((s) => s.email) } });
  await enqueueNotification(dataId, {
    channel: "in_app",
    recipient: dataId,
    subject: `"${doc.title}" fully signed`,
    body: `${doc.signers.map((s) => s.name).join(", ")} signed ${referenceFor(doc)}. The signed PDF is attached to the document${doc.contact_id ? " and the contact" : ""}.`,
    data: { kind: "document_signed", document_id: documentId, href: "/documents" },
  }).catch(() => undefined);
}

export interface DeclineInput {
  otp: string;
  email: string;
  reason: string | null;
}

export async function declineWithToken(token: string, input: DeclineInput): Promise<PublicDocument> {
  const { share, signer, doc } = await resolveSigner(token);
  assertRecipientMatches(input.email, share.recipient ?? signer.email);
  assertSignable(doc);
  if (signer.status === "signed") throw new DocumentError("You have already signed this document");
  await verifySignOtp(signer.id, input.email, input.otp, "decline");
  await query(`UPDATE document_signers SET status = 'declined', decline_reason = $2, otp_hash = NULL WHERE id = $1`, [signer.id, input.reason?.trim().slice(0, 1000) || null]);
  await query(`UPDATE documents SET status = 'declined', updated_at = NOW() WHERE id = $1`, [doc.id]);
  void recordAudit({ dataId: share.user_id, userId: null }, { action: "document.declined", entity: "document", entityId: doc.id, after: { signer_id: signer.id, reason: input.reason ?? null } });
  void emitEvent(share.user_id, { type: "document.declined", entity: "document", entityId: doc.id, data: { title: doc.title, signer_email: signer.email, reason: input.reason ?? null } });
  await enqueueNotification(share.user_id, {
    channel: "in_app",
    recipient: share.user_id,
    subject: `"${doc.title}" declined`,
    body: `${signer.name} (${signer.email}) declined to sign.${input.reason ? ` Reason: ${input.reason}` : ""}`,
    data: { kind: "document_declined", document_id: doc.id, href: "/documents" },
  }).catch(() => undefined);
  return publicDocumentForToken(token);
}

/** PDF for a signer: redacted evidence (no raw IP/UA on the public copy). */
export async function pdfForToken(token: string) {
  const { share, doc } = await resolveSigner(token);
  return buildDocumentPdf(share.user_id, doc, { redactEvidence: true });
}

export { signerToDto };
