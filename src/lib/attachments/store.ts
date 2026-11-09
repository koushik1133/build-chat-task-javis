import { createHash, randomUUID } from "crypto";
import { query, queryOne } from "@/lib/dsql";
import { recordAudit } from "@/lib/audit";
import { emitEvent } from "@/lib/events/bus";
import { sniffImage } from "@/lib/image-sniff";
import { verifyDeclaredType } from "./sniff";
import { tableExists } from "@/lib/table-exists";
import { getObject, objectKey, putObject, removeObject, signedUrl } from "./storage";
import {
  ATTACHMENT_ENTITY_KINDS,
  MAX_ATTACHMENT_BYTES,
  resolveAttachmentType,
  safeFileName,
  type AttachmentDTO,
  type AttachmentEntityKind,
  type AttachmentVisibility,
} from "./types";

/**
 * Attachment metadata rows + the upload/download glue. Bytes live in the
 * storage backend; the row keeps the sha256 so a downloaded file can be
 * verified against what was uploaded.
 */

export class AttachmentError extends Error {
  constructor(message: string, public readonly status = 400) {
    super(message);
    this.name = "AttachmentError";
  }
}

const COLS = `id, entity_kind, entity_id, file_name, content_type, size_bytes, sha256, uploaded_by, visibility, created_at`;

interface Row {
  id: string;
  entity_kind: AttachmentEntityKind;
  entity_id: string;
  file_name: string;
  content_type: string;
  size_bytes: string | number;
  sha256: string;
  uploaded_by: string | null;
  visibility: AttachmentVisibility;
  created_at: string | Date;
}

function toDto(r: Row): AttachmentDTO {
  return {
    id: r.id,
    entity_kind: r.entity_kind,
    entity_id: r.entity_id,
    file_name: r.file_name,
    content_type: r.content_type,
    size_bytes: Number(r.size_bytes),
    sha256: r.sha256,
    uploaded_by: r.uploaded_by,
    visibility: r.visibility,
    created_at: new Date(r.created_at).toISOString(),
  };
}

export function isEntityKind(v: unknown): v is AttachmentEntityKind {
  return typeof v === "string" && (ATTACHMENT_ENTITY_KINDS as readonly string[]).includes(v);
}

export interface UploadInput {
  entityKind: AttachmentEntityKind;
  entityId: string;
  fileName: string;
  declaredType: string | null;
  bytes: Buffer;
  visibility?: AttachmentVisibility;
  uploadedBy?: string | null;
}

/**
 * Validate (size, allowed type, image magic bytes), store the bytes and
 * insert the row. Images must sniff as the declared image type; a PNG named
 * `.jpg` is stored under its real type.
 */
export async function uploadAttachment(dataId: string, input: UploadInput): Promise<AttachmentDTO> {
  const fileName = safeFileName(input.fileName);
  if (input.bytes.length === 0) throw new AttachmentError("File is empty");
  if (input.bytes.length > MAX_ATTACHMENT_BYTES) throw new AttachmentError("File must be 20 MB or smaller", 413);
  const resolved = resolveAttachmentType(input.declaredType, fileName);
  if (!resolved) throw new AttachmentError("Allowed types: PDF, DOC, DOCX, XLSX, CSV, TXT, PNG, JPG, WebP", 415);
  let contentType = resolved.mime;
  if (contentType.startsWith("image/")) {
    const sniffed = sniffImage(input.bytes, null);
    if (!sniffed || !["image/png", "image/jpeg", "image/webp"].includes(sniffed.mime)) throw new AttachmentError("Image bytes do not match a PNG, JPEG or WebP file", 415);
    contentType = sniffed.mime;
  } else {
    const mismatch = verifyDeclaredType(contentType, input.bytes);
    if (mismatch) throw new AttachmentError(mismatch, 415);
  }
  const id = randomUUID();
  const storagePath = objectKey(dataId, input.entityKind, input.entityId, id);
  const sha256 = createHash("sha256").update(input.bytes).digest("hex");
  await putObject(storagePath, input.bytes, contentType);
  const row = await queryOne<Row>(
    `INSERT INTO attachments (id, user_id, entity_kind, entity_id, file_name, content_type, size_bytes, storage_path, sha256, uploaded_by, visibility)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING ${COLS}`,
    [id, dataId, input.entityKind, input.entityId, fileName, contentType, input.bytes.length, storagePath, sha256, input.uploadedBy ?? null, input.visibility ?? "internal"]
  ).catch(async (err: unknown) => {
    await removeObject(storagePath);
    throw err;
  });
  if (!row) throw new Error("attachment insert returned no row");
  const dto = toDto(row);
  void recordAudit({ dataId, userId: input.uploadedBy ?? null }, { action: "attachment.added", entity: input.entityKind, entityId: input.entityId, after: { attachment_id: id, file_name: fileName, size_bytes: dto.size_bytes } });
  void emitEvent(dataId, { type: "attachment.added", entity: input.entityKind, entityId: input.entityId, data: { attachment_id: id, file_name: fileName, content_type: contentType, size_bytes: dto.size_bytes, visibility: dto.visibility } });
  return dto;
}

export async function listAttachments(dataId: string, entityKind: AttachmentEntityKind, entityId: string, opts: { visibility?: AttachmentVisibility } = {}): Promise<AttachmentDTO[]> {
  const params: unknown[] = [dataId, entityKind, entityId];
  let where = `user_id = $1 AND entity_kind = $2 AND entity_id = $3 AND deleted_at IS NULL`;
  if (opts.visibility) {
    params.push(opts.visibility);
    where += ` AND visibility = $${params.length}`;
  }
  const rows = await query<Row>(`SELECT ${COLS} FROM attachments WHERE ${where} ORDER BY created_at DESC LIMIT 200`, params);
  return rows.map(toDto);
}

export async function getAttachment(dataId: string, id: string): Promise<(AttachmentDTO & { storage_path: string }) | null> {
  const row = await queryOne<Row & { storage_path: string }>(`SELECT ${COLS}, storage_path FROM attachments WHERE user_id = $1 AND id = $2 AND deleted_at IS NULL`, [dataId, id]);
  return row ? { ...toDto(row), storage_path: row.storage_path } : null;
}

/** Signed URL (10 min) or, in local mode, the bytes to stream. */
export async function openAttachment(dataId: string, id: string): Promise<{ attachment: AttachmentDTO; url: string | null; bytes: Buffer | null } | null> {
  const a = await getAttachment(dataId, id);
  if (!a) return null;
  const url = await signedUrl(a.storage_path, a.file_name);
  if (url) return { attachment: a, url, bytes: null };
  const obj = await getObject(a.storage_path, a.content_type);
  if (!obj) return null;
  return { attachment: a, url: null, bytes: obj.bytes };
}

/** Soft delete; the object stays for the retention window (purged by a later sweep). */
export async function deleteAttachment(dataId: string, id: string, actorId?: string | null): Promise<boolean> {
  const rows = await query<{ id: string }>(`UPDATE attachments SET deleted_at = NOW() WHERE user_id = $1 AND id = $2 AND deleted_at IS NULL RETURNING id`, [dataId, id]);
  if (rows.length === 0) return false;
  void recordAudit({ dataId, userId: actorId ?? null }, { action: "attachment.deleted", entity: "attachment", entityId: id });
  return true;
}

/**
 * Retention sweep (cron, hourly block): delete storage objects for rows soft-
 * deleted more than `days` ago, then drop the rows. The object is removed
 * before the row so a crash never leaves an orphaned blob behind a vanished row.
 */
export async function purgeDeletedAttachments(days = 30, limit = 200): Promise<{ purged: number; failed: number }> {
  if (!(await tableExists("attachments"))) return { purged: 0, failed: 0 };
  const rows = await query<{ id: string; user_id: string; storage_path: string }>(
    `SELECT id, user_id, storage_path FROM attachments WHERE deleted_at IS NOT NULL AND deleted_at < NOW() - make_interval(days => $1) ORDER BY deleted_at ASC LIMIT $2`,
    [Math.max(0, Math.floor(days)), Math.min(Math.max(limit, 1), 1000)]
  );
  let purged = 0;
  let failed = 0;
  for (const r of rows) {
    try {
      await removeObject(r.storage_path);
      await query(`DELETE FROM attachments WHERE id = $1 AND user_id = $2 AND deleted_at IS NOT NULL`, [r.id, r.user_id]);
      purged++;
    } catch (err) {
      failed++;
      console.error(`[attachments] purge failed for ${r.id}:`, err);
    }
  }
  return { purged, failed };
}

/* ---------- portal + DSR ---------- */

/**
 * Entities that belong to a contact, so the portal / a subject export can
 * list "their" files: the contact itself plus their quotes, invoices,
 * tickets, bookings, records and documents.
 */
export async function entityRefsForContact(dataId: string, contactId: string): Promise<Array<{ kind: AttachmentEntityKind; id: string }>> {
  const refs: Array<{ kind: AttachmentEntityKind; id: string }> = [{ kind: "contact", id: contactId }];
  const sources: Array<[string, AttachmentEntityKind, string]> = [
    ["quotes", "quote", `SELECT id FROM quotes WHERE user_id = $1 AND contact_id = $2`],
    ["invoices", "invoice", `SELECT id FROM invoices WHERE user_id = $1 AND contact_id = $2`],
    ["tickets", "ticket", `SELECT id FROM tickets WHERE user_id = $1 AND contact_id = $2`],
    ["bookings", "booking", `SELECT id FROM bookings WHERE user_id = $1 AND contact_id = $2`],
    ["records", "record", `SELECT id FROM records WHERE user_id = $1 AND contact_id = $2`],
    ["documents", "document", `SELECT id FROM documents WHERE user_id = $1 AND contact_id = $2`],
  ];
  for (const [table, kind, sql] of sources) {
    if (!(await tableExists(table))) continue;
    const rows = await query<{ id: string }>(`${sql} LIMIT 500`, [dataId, contactId]).catch(() => []);
    for (const r of rows) refs.push({ kind, id: String(r.id) });
  }
  return refs;
}

async function rowsForRefs(dataId: string, refs: Array<{ kind: AttachmentEntityKind; id: string }>, opts: { visibility?: AttachmentVisibility } = {}): Promise<Row[]> {
  if (refs.length === 0 || !(await tableExists("attachments"))) return [];
  const params: unknown[] = [dataId, refs.map((r) => r.kind), refs.map((r) => r.id)];
  let where = `a.user_id = $1 AND a.deleted_at IS NULL AND (a.entity_kind, a.entity_id) IN (SELECT * FROM unnest($2::text[], $3::text[]))`;
  if (opts.visibility) {
    params.push(opts.visibility);
    where += ` AND a.visibility = $${params.length}`;
  }
  return query<Row>(`SELECT ${COLS.split(", ").map((c) => `a.${c}`).join(", ")} FROM attachments a WHERE ${where} ORDER BY a.created_at DESC LIMIT 500`, params).catch(() => []);
}

/** Every live attachment reachable from a contact (DSR export: metadata only, never bytes). */
export async function attachmentsForSubject(dataId: string, contactId: string): Promise<AttachmentDTO[]> {
  const refs = await entityRefsForContact(dataId, contactId);
  return (await rowsForRefs(dataId, refs)).map(toDto);
}

/** Portal-visible attachments for a contact's entities. */
export async function portalAttachmentsForContact(dataId: string, contactId: string): Promise<AttachmentDTO[]> {
  const refs = await entityRefsForContact(dataId, contactId);
  return (await rowsForRefs(dataId, refs, { visibility: "portal" })).map(toDto);
}

/** Erase: delete the bytes and the rows for everything attached to the subject's entities. */
export async function eraseAttachmentsForSubject(dataId: string, contactId: string): Promise<number> {
  const refs = await entityRefsForContact(dataId, contactId);
  if (refs.length === 0 || !(await tableExists("attachments"))) return 0;
  const rows = await query<{ id: string; storage_path: string }>(
    `SELECT id, storage_path FROM attachments WHERE user_id = $1 AND (entity_kind, entity_id) IN (SELECT * FROM unnest($2::text[], $3::text[]))`,
    [dataId, refs.map((r) => r.kind), refs.map((r) => r.id)]
  );
  for (const r of rows) await removeObject(r.storage_path).catch(() => undefined);
  if (rows.length) await query(`DELETE FROM attachments WHERE user_id = $1 AND id = ANY($2)`, [dataId, rows.map((r) => r.id)]);
  return rows.length;
}

/** Ownership check for the generic routes: the entity must exist in this org. Unknown tables are tolerated. */
export async function entityExists(dataId: string, kind: AttachmentEntityKind, id: string): Promise<boolean> {
  const table: Record<AttachmentEntityKind, [string, string] | null> = {
    contact: ["crm_contacts", "id"],
    lead: ["site_leads", "id::text"],
    quote: ["quotes", "id"],
    invoice: ["invoices", "id"],
    ticket: ["tickets", "id"],
    record: ["records", "id"],
    booking: ["bookings", "id"],
    task: ["tasks", "id::text"],
    product: ["products", "id"],
    purchase_order: ["purchase_orders", "id"],
    document: ["documents", "id"],
    project: ["projects", "id"],
    order: ["orders", "id"],
    shipment: ["shipments", "id"],
  };
  const t = table[kind];
  if (!t) return false;
  if (!(await tableExists(t[0]))) return false;
  const row = await queryOne<{ ok: number }>(`SELECT 1 AS ok FROM ${t[0]} WHERE user_id = $1 AND ${t[1]} = $2 LIMIT 1`, [dataId, id]).catch(() => null);
  return Boolean(row);
}
