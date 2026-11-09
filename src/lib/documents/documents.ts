import { randomUUID } from "crypto";
import { query, queryOne } from "@/lib/dsql";
import { recordAudit } from "@/lib/audit";
import { emitEvent } from "@/lib/events/bus";
import { getBranding } from "@/lib/branding";
import { businessName } from "@/lib/money/quotes";
import { orgTimezone, type BuiltPdf } from "@/lib/pdf/documents";
import { tableExists } from "@/lib/table-exists";
import { entityExists } from "@/lib/attachments/store";
import { getObject } from "@/lib/attachments/storage";
import type { AttachmentEntityKind } from "@/lib/attachments/types";
import { keysetClause, keysetOrder, type Cursor } from "@/lib/public-api/pagination";
import { DocumentError, getTemplate } from "./templates";
import { documentHash, missingRequired, renderDocumentPdf, renderMerge, type SignerStamp } from "./render";
import {
  DOCUMENT_KINDS,
  DOCUMENT_STATUSES,
  type DocumentDTO,
  type DocumentKind,
  type DocumentSignerDTO,
  type DocumentStatus,
  type MergeField,
  type SignerStatus,
  type SigningOrder,
} from "./types";
import { deleteInBatches } from "@/lib/db/batch";

export { DocumentError };

/* ─── rows ───────────────────────────────────────────────────────────────── */

const DOC_COLS = `d.id, d.template_id, d.title, d.kind, d.body_md, d.merge_data, d.status, d.signing_order, d.contact_id, d.record_id, d.quote_id,
  d.pdf_hash, d.signed_pdf_hash, d.sent_at, d.viewed_at, d.completed_at, d.expires_at, d.created_by, d.created_at, d.updated_at, c.full_name AS contact_name`;
const DOC_FROM = `documents d LEFT JOIN crm_contacts c ON c.id = d.contact_id AND c.user_id = d.user_id`;

interface DocRow {
  id: string;
  template_id: string | null;
  title: string;
  kind: DocumentKind;
  body_md: string;
  merge_data: string | null;
  status: DocumentStatus;
  signing_order: SigningOrder;
  contact_id: string | null;
  record_id: string | null;
  quote_id: string | null;
  pdf_hash: string | null;
  signed_pdf_hash: string | null;
  sent_at: string | Date | null;
  viewed_at: string | Date | null;
  completed_at: string | Date | null;
  expires_at: string | Date | null;
  created_by: string | null;
  created_at: string | Date;
  updated_at: string | Date;
  contact_name: string | null;
}

export const SIGNER_COLS = `id, name, email, role, order_index, status, signed_at, signature_text, decline_reason`;
export interface SignerRow {
  id: string;
  name: string;
  email: string;
  role: string | null;
  order_index: number;
  status: SignerStatus;
  signed_at: string | Date | null;
  signature_text: string | null;
  decline_reason: string | null;
}

/** Full signer row incl. evidence (never sent to the browser as-is). */
export interface SignerEvidenceRow extends SignerRow {
  ip: string | null;
  user_agent: string | null;
  consent_text: string | null;
}

const iso = (v: string | Date | null | undefined): string | null => (v ? new Date(v).toISOString() : null);

export function signerToDto(r: SignerRow): DocumentSignerDTO {
  return { id: r.id, name: r.name, email: r.email, role: r.role, order_index: Number(r.order_index), status: r.status, signed_at: iso(r.signed_at), signature_text: r.signature_text, decline_reason: r.decline_reason };
}

function parseMerge(raw: string | null): Record<string, string> {
  if (!raw) return {};
  try {
    const v: unknown = JSON.parse(raw);
    if (!v || typeof v !== "object" || Array.isArray(v)) return {};
    const out: Record<string, string> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) if (typeof val === "string") out[k] = val;
    return out;
  } catch {
    return {};
  }
}

function toDto(r: DocRow, signers: SignerRow[]): DocumentDTO {
  return {
    id: r.id,
    template_id: r.template_id,
    title: r.title,
    kind: DOCUMENT_KINDS.includes(r.kind) ? r.kind : "other",
    body_md: r.body_md,
    merge_data: parseMerge(r.merge_data),
    status: DOCUMENT_STATUSES.includes(r.status) ? r.status : "draft",
    signing_order: r.signing_order === "sequential" ? "sequential" : "parallel",
    contact_id: r.contact_id,
    contact_name: r.contact_name,
    record_id: r.record_id,
    quote_id: r.quote_id,
    pdf_hash: r.pdf_hash,
    signed_pdf_hash: r.signed_pdf_hash,
    sent_at: iso(r.sent_at),
    viewed_at: iso(r.viewed_at),
    completed_at: iso(r.completed_at),
    expires_at: iso(r.expires_at),
    created_by: r.created_by,
    created_at: new Date(r.created_at).toISOString(),
    updated_at: new Date(r.updated_at).toISOString(),
    signers: signers.map(signerToDto),
  };
}

export async function listSigners(documentId: string): Promise<SignerRow[]> {
  return query<SignerRow>(`SELECT ${SIGNER_COLS} FROM document_signers WHERE document_id = $1 ORDER BY order_index ASC, created_at ASC`, [documentId]);
}

export async function listSignersWithEvidence(documentId: string): Promise<SignerEvidenceRow[]> {
  return query<SignerEvidenceRow>(`SELECT ${SIGNER_COLS}, ip, user_agent, consent_text FROM document_signers WHERE document_id = $1 ORDER BY order_index ASC, created_at ASC`, [documentId]);
}

/* ─── merge defaults ─────────────────────────────────────────────────────── */

/** Values for contact.* and org.* merge keys; custom keys start blank. */
export async function mergeDefaults(dataId: string, contactId: string | null | undefined): Promise<Record<string, string>> {
  const [branding, business] = await Promise.all([getBranding(dataId), businessName(dataId)]);
  const out: Record<string, string> = {
    "org.name": branding.configured && branding.brand_name ? branding.brand_name : business,
    "org.support_email": branding.support_email ?? "",
    "org.today": new Date().toISOString().slice(0, 10),
  };
  if (contactId) {
    const c = await queryOne<{ full_name: string; email: string | null; phone: string | null; company: string | null; billing_address: string | null }>(
      `SELECT full_name, email, phone, company, billing_address FROM crm_contacts WHERE user_id = $1 AND id = $2`,
      [dataId, contactId]
    ).catch(() => queryOne<{ full_name: string; email: string | null; phone: string | null; company: string | null; billing_address: string | null }>(`SELECT full_name, email, phone, company, NULL::text AS billing_address FROM crm_contacts WHERE user_id = $1 AND id = $2`, [dataId, contactId]));
    if (c) {
      out["contact.full_name"] = c.full_name;
      out["contact.email"] = c.email ?? "";
      out["contact.phone"] = c.phone ?? "";
      out["contact.company"] = c.company ? ` of ${c.company}` : "";
      out["contact.billing_address"] = c.billing_address ?? "";
    }
  }
  return out;
}

/* ─── CRUD ───────────────────────────────────────────────────────────────── */

export interface ListDocumentsOptions {
  status?: DocumentStatus | null;
  contactId?: string | null;
  q?: string | null;
  cursor?: Cursor | null;
  limit?: number;
}

export async function listDocuments(dataId: string, opts: ListDocumentsOptions = {}): Promise<DocumentDTO[]> {
  const params: unknown[] = [dataId];
  const where = [`d.user_id = $1`];
  if (opts.status) {
    params.push(opts.status);
    where.push(`d.status = $${params.length}`);
  }
  if (opts.contactId) {
    params.push(opts.contactId);
    where.push(`d.contact_id = $${params.length}`);
  }
  if (opts.q?.trim()) {
    params.push(`%${opts.q.trim().toLowerCase()}%`);
    where.push(`lower(d.title) LIKE $${params.length}`);
  }
  const ks = keysetClause(opts.cursor ?? null, params, { alias: "d." });
  params.push(Math.max(1, Math.min(201, opts.limit ?? 100)));
  const rows = await query<DocRow>(`SELECT ${DOC_COLS} FROM ${DOC_FROM} WHERE ${where.join(" AND ")}${ks} ORDER BY ${keysetOrder("d.")} LIMIT $${params.length}`, params);
  if (rows.length === 0) return [];
  const signers = await query<SignerRow & { document_id: string }>(`SELECT document_id, ${SIGNER_COLS} FROM document_signers WHERE document_id = ANY($1) ORDER BY order_index ASC`, [rows.map((r) => r.id)]);
  return rows.map((r) => toDto(r, signers.filter((s) => s.document_id === r.id)));
}

export async function getDocument(dataId: string, id: string): Promise<DocumentDTO | null> {
  const row = await queryOne<DocRow>(`SELECT ${DOC_COLS} FROM ${DOC_FROM} WHERE d.user_id = $1 AND d.id = $2`, [dataId, id]);
  if (!row) return null;
  return toDto(row, await listSigners(id));
}

/** Document by id without the org (public signer routes know the org from the token row). */
export async function getDocumentById(id: string): Promise<(DocumentDTO & { user_id: string }) | null> {
  const row = await queryOne<DocRow & { user_id: string }>(`SELECT d.user_id, ${DOC_COLS} FROM ${DOC_FROM} WHERE d.id = $1`, [id]);
  if (!row) return null;
  return { ...toDto(row, await listSigners(id)), user_id: row.user_id };
}

export interface CreateDocumentInput {
  template_id?: string | null;
  title?: string | null;
  kind?: DocumentKind | null;
  body_md?: string | null;
  merge_data?: Record<string, string> | null;
  contact_id?: string | null;
  record_id?: string | null;
  quote_id?: string | null;
  signing_order?: SigningOrder | null;
  expires_in_days?: number | null;
  signers?: Array<{ name: string; email: string; role?: string | null }> | null;
}

/**
 * Create a draft. With a template the body is the template body with merge
 * fields rendered from (defaults ∪ merge_data); without one the caller
 * supplies `body_md` directly (AI drafts, free-form letters).
 */
export async function createDocument(dataId: string, input: CreateDocumentInput, actorId?: string | null): Promise<DocumentDTO> {
  let template = null;
  if (input.template_id) {
    template = await getTemplate(dataId, input.template_id);
    if (!template) throw new DocumentError("Template not found", 404);
  }
  await assertLinkedEntities(dataId, input);
  const defaults = await mergeDefaults(dataId, input.contact_id);
  const mergeData: Record<string, string> = { ...defaults, ...(input.merge_data ?? {}) };
  const fields: MergeField[] = template?.fields ?? [];
  const missing = missingRequired(fields, mergeData);
  if (missing.length) throw new DocumentError(`Missing required fields: ${missing.join(", ")}`);
  const source = template?.body_md ?? input.body_md ?? "";
  if (!source.trim()) throw new DocumentError("A template or body is required");
  const rendered = renderMerge(source, mergeData);
  const title = (input.title ?? template?.name ?? "Untitled document").trim().slice(0, 200);
  const kind: DocumentKind = input.kind ?? template?.kind ?? "other";
  const id = randomUUID();
  const expiresAt = input.expires_in_days ? new Date(Date.now() + input.expires_in_days * 86_400_000).toISOString() : null;
  await query(
    `INSERT INTO documents (id, user_id, template_id, title, kind, body_md, merge_data, status, signing_order, contact_id, record_id, quote_id, expires_at, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'draft', $8, $9, $10, $11, $12, $13)`,
    [id, dataId, template?.id ?? null, title, kind, rendered.body, JSON.stringify(mergeData), input.signing_order ?? "parallel", input.contact_id ?? null, input.record_id ?? null, input.quote_id ?? null, expiresAt, actorId ?? null]
  );
  if (input.signers?.length) await replaceSigners(dataId, id, input.signers);
  void recordAudit({ dataId, userId: actorId ?? null }, { action: "document.created", entity: "document", entityId: id, after: { title, kind, template_id: template?.id ?? null, missing_merge: rendered.missing } });
  const doc = await getDocument(dataId, id);
  if (!doc) throw new Error("document insert vanished");
  return doc;
}

/** Linked contact/record/quote ids must belong to this org (they also become storage path segments). */
async function assertLinkedEntities(dataId: string, ids: { contact_id?: string | null; record_id?: string | null; quote_id?: string | null }): Promise<void> {
  const checks: Array<[AttachmentEntityKind, string | null | undefined, string]> = [
    ["contact", ids.contact_id, "Contact not found"],
    ["record", ids.record_id, "Record not found"],
    ["quote", ids.quote_id, "Quote not found"],
  ];
  for (const [kind, id, msg] of checks) {
    if (!id) continue;
    if (!(await entityExists(dataId, kind, id))) throw new DocumentError(msg, 404);
  }
}

export interface UpdateDocumentInput {
  title?: string;
  body_md?: string;
  merge_data?: Record<string, string>;
  signing_order?: SigningOrder;
  expires_at?: string | null;
  contact_id?: string | null;
  signers?: Array<{ name: string; email: string; role?: string | null }>;
}

/** Drafts only: once sent the body is frozen (its hash is what signers agree to). */
export async function updateDocument(dataId: string, id: string, patch: UpdateDocumentInput, actorId?: string | null): Promise<DocumentDTO> {
  const before = await getDocument(dataId, id);
  if (!before) throw new DocumentError("Document not found", 404);
  if (before.status !== "draft") throw new DocumentError(`Only drafts can be edited (status is ${before.status})`);
  const sets: string[] = [];
  const values: unknown[] = [dataId, id];
  const set = (col: string, v: unknown) => {
    values.push(v);
    sets.push(`${col} = $${values.length}`);
  };
  if (patch.title !== undefined) set("title", patch.title.trim().slice(0, 200));
  if (patch.body_md !== undefined) set("body_md", patch.body_md);
  if (patch.merge_data !== undefined) set("merge_data", JSON.stringify({ ...before.merge_data, ...patch.merge_data }));
  if (patch.signing_order !== undefined) set("signing_order", patch.signing_order);
  if (patch.expires_at !== undefined) set("expires_at", patch.expires_at);
  if (patch.contact_id !== undefined) {
    await assertLinkedEntities(dataId, { contact_id: patch.contact_id });
    set("contact_id", patch.contact_id);
  }
  if (sets.length) {
    sets.push("updated_at = NOW()");
    await query(`UPDATE documents SET ${sets.join(", ")} WHERE user_id = $1 AND id = $2`, values);
  }
  if (patch.signers) await replaceSigners(dataId, id, patch.signers);
  void recordAudit({ dataId, userId: actorId ?? null }, { action: "document.updated", entity: "document", entityId: id });
  const after = await getDocument(dataId, id);
  if (!after) throw new DocumentError("Document not found", 404);
  return after;
}

export async function replaceSigners(dataId: string, documentId: string, signers: Array<{ name: string; email: string; role?: string | null }>): Promise<void> {
  const seen = new Set<string>();
  const clean = signers
    .map((s) => ({ name: s.name.trim().slice(0, 200), email: s.email.trim().toLowerCase().slice(0, 320), role: s.role?.trim().slice(0, 60) || null }))
    .filter((s) => s.name && s.email && !seen.has(s.email) && seen.add(s.email));
  if (clean.length === 0) throw new DocumentError("At least one signer with a name and email is required");
  if (clean.length > 10) throw new DocumentError("At most 10 signers");
  await deleteInBatches("document_signers", "user_id = $1 AND document_id = $2", [dataId, documentId]);
  for (let i = 0; i < clean.length; i++) {
    await query(`INSERT INTO document_signers (id, user_id, document_id, name, email, role, order_index, status) VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending')`, [randomUUID(), dataId, documentId, clean[i].name, clean[i].email, clean[i].role, i]);
  }
}

export async function voidDocument(dataId: string, id: string, actorId?: string | null): Promise<DocumentDTO> {
  const doc = await getDocument(dataId, id);
  if (!doc) throw new DocumentError("Document not found", 404);
  if (doc.status === "signed") throw new DocumentError("A signed document cannot be voided");
  if (doc.status === "void") return doc;
  await query(`UPDATE documents SET status = 'void', updated_at = NOW() WHERE user_id = $1 AND id = $2`, [dataId, id]);
  // Signing links are keyed by signer id: revoke every signer's link.
  const { revokeShareTokens } = await import("@/lib/share-tokens");
  for (const s of doc.signers) await revokeShareTokens("sign", s.id).catch(() => undefined);
  void recordAudit({ dataId, userId: actorId ?? null }, { action: "document.voided", entity: "document", entityId: id, before: { status: doc.status } });
  return (await getDocument(dataId, id)) ?? { ...doc, status: "void" };
}

export async function deleteDocument(dataId: string, id: string, actorId?: string | null): Promise<boolean> {
  const doc = await getDocument(dataId, id);
  if (!doc) return false;
  if (doc.status !== "draft" && doc.status !== "void") throw new DocumentError("Only drafts and voided documents can be deleted; void it first");
  await deleteInBatches("document_signers", "user_id = $1 AND document_id = $2", [dataId, id]);
  await query(`DELETE FROM documents WHERE user_id = $1 AND id = $2`, [dataId, id]);
  void recordAudit({ dataId, userId: actorId ?? null }, { action: "document.deleted", entity: "document", entityId: id });
  return true;
}

/* ─── PDF ────────────────────────────────────────────────────────────────── */

async function docContext(dataId: string) {
  const [branding, timezone, business] = await Promise.all([getBranding(dataId), orgTimezone(dataId), businessName(dataId)]);
  return { branding, timezone, business };
}

export function referenceFor(doc: Pick<DocumentDTO, "id">): string {
  return `DOC-${doc.id.replace(/-/g, "").slice(0, 8).toUpperCase()}`;
}

function toInput(doc: DocumentDTO) {
  return { title: doc.title, kind: doc.kind, body_md: doc.body_md, created_at: doc.created_at, sent_at: doc.sent_at, expires_at: doc.expires_at, completed_at: doc.completed_at, status: doc.status, reference: referenceFor(doc) };
}

function toStamp(s: SignerEvidenceRow): SignerStamp {
  return { name: s.name, email: s.email, role: s.role, signature_text: s.signature_text, signed_at: new Date(s.signed_at ?? Date.now()).toISOString(), ip: s.ip, user_agent: s.user_agent, consent_text: s.consent_text };
}

/** Unsigned PDF (always deterministic for a given document) and its hash. */
export async function buildUnsignedPdf(dataId: string, doc: DocumentDTO): Promise<BuiltPdf> {
  const { branding, timezone, business } = await docContext(dataId);
  // The fingerprint must not drift with the mutable in-flight status (sent → viewed), so every non-draft copy renders as "sent".
  const fingerprinted: DocumentDTO = doc.status === "draft" ? doc : { ...doc, status: "sent" };
  const bytes = renderDocumentPdf(toInput(fingerprinted), null, branding, { business, timezone });
  return { bytes, filename: `${safeName(doc.title)}.pdf`, hash: documentHash(bytes), signed: false };
}

/** Signed when every signer has signed: stamps every signer + the unsigned hash. */
export async function buildDocumentPdf(dataId: string, doc: DocumentDTO, opts: { redactEvidence?: boolean } = {}): Promise<BuiltPdf> {
  if (doc.status !== "signed") return buildUnsignedPdf(dataId, doc);
  const [{ branding, timezone, business }, signers] = await Promise.all([docContext(dataId), listSignersWithEvidence(doc.id)]);
  const unsignedHash = doc.pdf_hash ?? documentHash(renderDocumentPdf(toInput({ ...doc, status: "sent" }), null, branding, { business, timezone }));
  const stamps = signers.filter((s) => s.status === "signed").map(toStamp);
  const bytes = renderDocumentPdf(toInput(doc), stamps, branding, { business, timezone, documentHash: unsignedHash, redactEvidence: opts.redactEvidence });
  return { bytes, filename: `${safeName(doc.title)}-signed.pdf`, hash: documentHash(bytes), signed: true };
}

/** Raised when the stored signed PDF no longer matches `signed_pdf_hash` (tampering or storage corruption). */
export class SignedPdfIntegrityError extends Error {
  constructor(public readonly documentId: string, public readonly expected: string, public readonly actual: string | null) {
    super(`Signed PDF for document ${documentId} failed its integrity check`);
    this.name = "SignedPdfIntegrityError";
  }
}

/** File-name suffix of the signer-facing copy (evidence redacted) stored next to the full signed PDF. */
export const PUBLIC_SIGNED_SUFFIX = "-signed-public.pdf";

/** File names reserved for the completion writer; user uploads on a document may not use them. */
export function isReservedSignedPdfName(fileName: string): boolean {
  return /-signed(-public)?\.pdf$/i.test(fileName.trim());
}

/**
 * The immutable signed copy: the attachment written at completion, verified
 * against its recorded hash (`signed_pdf_hash` for the full copy; the
 * attachment's own sha256 for the redacted signer copy). Re-rendering a signed
 * document is never done — render changes would silently alter a legal record —
 * so when the attachment is missing the document is unavailable, not regenerated.
 */
export async function loadSignedPdf(dataId: string, doc: DocumentDTO, opts: { redacted?: boolean } = {}): Promise<BuiltPdf> {
  if (doc.status !== "signed") throw new DocumentError("Document is not fully signed", 409);
  if (!doc.signed_pdf_hash) throw new SignedPdfIntegrityError(doc.id, "", null);
  // The signer copy is selected by the system-written marker (`uploaded_by IS NULL`: only
  // completion writes attachments without an actor) so a member upload named
  // "*-signed-public.pdf" can never be served as the hash-verified signed copy.
  const row = opts.redacted
    ? await queryOne<{ storage_path: string; content_type: string; file_name: string; sha256: string }>(
        `SELECT storage_path, content_type, file_name, sha256 FROM attachments
          WHERE user_id = $1 AND entity_kind = 'document' AND entity_id = $2 AND deleted_at IS NULL AND uploaded_by IS NULL
            AND visibility = 'internal' AND file_name LIKE $3 AND created_at >= COALESCE($4::timestamptz, created_at)
          ORDER BY created_at ASC LIMIT 1`,
        [dataId, doc.id, `%${PUBLIC_SIGNED_SUFFIX}`, doc.completed_at ?? null]
      )
    : await queryOne<{ storage_path: string; content_type: string; file_name: string; sha256: string }>(
        `SELECT storage_path, content_type, file_name, sha256 FROM attachments
          WHERE user_id = $1 AND entity_kind = 'document' AND entity_id = $2 AND deleted_at IS NULL AND sha256 = $3
          ORDER BY created_at ASC LIMIT 1`,
        [dataId, doc.id, doc.signed_pdf_hash]
      );
  if (!row && opts.redacted) {
    // Documents completed before the redacted signer copy was stored only have the
    // full signed PDF. Verify that legal record is intact, then render the redacted
    // view from it (the full copy is never re-rendered or replaced).
    await loadSignedPdf(dataId, doc);
    console.warn(`[documents] no stored public signed copy for ${doc.id}; rendering redacted view from the verified signed record`);
    return buildDocumentPdf(dataId, doc, { redactEvidence: true });
  }
  if (!row) throw new SignedPdfIntegrityError(doc.id, doc.signed_pdf_hash, null);
  const expected = opts.redacted ? row.sha256 : doc.signed_pdf_hash;
  const obj = await getObject(row.storage_path, row.content_type);
  if (!obj) throw new SignedPdfIntegrityError(doc.id, expected, null);
  const actual = documentHash(obj.bytes);
  if (actual !== expected) throw new SignedPdfIntegrityError(doc.id, expected, actual);
  return { bytes: new Uint8Array(obj.bytes), filename: row.file_name, hash: actual, signed: true };
}

/** Unsigned → fresh render; signed → the verified stored copy (redacted variant for signers). */
export async function servePdf(dataId: string, doc: DocumentDTO, opts: { redacted?: boolean } = {}): Promise<BuiltPdf> {
  return doc.status === "signed" ? loadSignedPdf(dataId, doc, opts) : buildUnsignedPdf(dataId, doc);
}

function safeName(title: string): string {
  return title.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "Document";
}

/* ─── expiry sweep (cron) ────────────────────────────────────────────────── */

export async function expireDocuments(limit = 200): Promise<{ expired: number }> {
  if (!(await tableExists("documents"))) return { expired: 0 };
  const rows = await query<{ id: string; user_id: string; title: string }>(
    `UPDATE documents SET status = 'expired', updated_at = NOW()
      WHERE id IN (SELECT id FROM documents WHERE status IN ('sent','viewed') AND expires_at IS NOT NULL AND expires_at < NOW() ORDER BY expires_at ASC LIMIT $1)
      RETURNING id, user_id, title`,
    [Math.max(1, Math.min(1000, limit))]
  );
  for (const r of rows) {
    void emitEvent(r.user_id, { type: "document.expired", entity: "document", entityId: r.id, data: { title: r.title } });
  }
  return { expired: rows.length };
}
