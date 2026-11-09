import type { Area } from "@/lib/auth/roles";

/**
 * Attachment constants + validation (client-safe: no DB, no storage imports).
 * The panel component and the route share these so the browser can refuse a
 * file before uploading what the server would reject anyway.
 */

export const ATTACHMENT_ENTITY_KINDS = ["contact", "lead", "quote", "invoice", "ticket", "record", "booking", "task", "product", "purchase_order", "document", "order", "project", "shipment"] as const;
export type AttachmentEntityKind = (typeof ATTACHMENT_ENTITY_KINDS)[number];

export const ATTACHMENT_VISIBILITIES = ["internal", "portal"] as const;
export type AttachmentVisibility = (typeof ATTACHMENT_VISIBILITIES)[number];

export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;

/** Declared MIME → canonical type + extension. Anything else is refused. */
export const ALLOWED_ATTACHMENT_TYPES: Record<string, { mime: string; ext: string }> = {
  "application/pdf": { mime: "application/pdf", ext: "pdf" },
  "application/msword": { mime: "application/msword", ext: "doc" },
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": { mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", ext: "docx" },
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": { mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", ext: "xlsx" },
  "text/csv": { mime: "text/csv", ext: "csv" },
  "text/plain": { mime: "text/plain", ext: "txt" },
  "image/png": { mime: "image/png", ext: "png" },
  "image/jpeg": { mime: "image/jpeg", ext: "jpg" },
  "image/webp": { mime: "image/webp", ext: "webp" },
};

const EXT_TO_MIME: Record<string, string> = {
  pdf: "application/pdf",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  csv: "text/csv",
  txt: "text/plain",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
};

export const ATTACHMENT_ACCEPT = Object.keys(ALLOWED_ATTACHMENT_TYPES).join(",") + ",.pdf,.doc,.docx,.xlsx,.csv,.txt,.png,.jpg,.jpeg,.webp";

export interface AttachmentDTO {
  id: string;
  entity_kind: AttachmentEntityKind;
  entity_id: string;
  file_name: string;
  content_type: string;
  size_bytes: number;
  sha256: string;
  uploaded_by: string | null;
  visibility: AttachmentVisibility;
  created_at: string;
}

/**
 * Resolve the content type we will store from the declared type and the file
 * name. Browsers send "" or application/octet-stream for CSV/DOCX on some
 * platforms, so the extension is consulted as a fallback. Returns null when
 * the file is not an allowed kind.
 */
export function resolveAttachmentType(declared: string | null | undefined, fileName: string): { mime: string; ext: string } | null {
  const d = (declared ?? "").split(";")[0].trim().toLowerCase();
  const ext = fileName.toLowerCase().split(".").pop() ?? "";
  const byExt = EXT_TO_MIME[ext];
  if (d && ALLOWED_ATTACHMENT_TYPES[d]) {
    // The extension must agree with the declared type: "payload.html" declared as text/plain
    // (or "evil.html" declared as application/pdf) is refused rather than stored under a
    // name that opens as something else. Names without an extension follow the declared type.
    if (fileName.includes(".") && byExt !== ALLOWED_ATTACHMENT_TYPES[d].mime) return null;
    return ALLOWED_ATTACHMENT_TYPES[d];
  }
  if (byExt && (!d || d === "application/octet-stream" || d === "application/vnd.ms-excel" || d === "text/plain")) return ALLOWED_ATTACHMENT_TYPES[byExt];
  return null;
}

/** Client + server pre-check. Returns a human message or null when acceptable. */
export function validateAttachmentMeta(file: { name: string; size: number; type?: string | null }): string | null {
  if (!file.name || file.name.length > 255) return "File name must be 1–255 characters";
  if (file.size <= 0) return "File is empty";
  if (file.size > MAX_ATTACHMENT_BYTES) return "File must be 20 MB or smaller";
  if (!resolveAttachmentType(file.type, file.name)) return "Allowed types: PDF, DOC, DOCX, XLSX, CSV, TXT, PNG, JPG, WebP";
  return null;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** Strip path separators and control characters from a client-supplied file name. */
export function safeFileName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? "file";
  const cleaned = base.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  return (cleaned || "file").slice(0, 255);
}

/** Which permission area gates files on each entity kind. */
export const AREA_FOR_ENTITY: Record<AttachmentEntityKind, Area> = {
  contact: "crm",
  lead: "leads",
  quote: "billing",
  invoice: "billing",
  ticket: "helpdesk",
  record: "crm",
  booking: "calendar",
  task: "tasks",
  product: "billing",
  purchase_order: "billing",
  document: "crm",
  order: "billing",
  project: "tasks",
  shipment: "billing",
};
