/** Document / template types and constants (client-safe: no DB imports). */

export const DOCUMENT_KINDS = ["contract", "proposal", "nda", "letter", "form", "other"] as const;
export type DocumentKind = (typeof DOCUMENT_KINDS)[number];

export const DOCUMENT_STATUSES = ["draft", "sent", "viewed", "signed", "declined", "expired", "void"] as const;
export type DocumentStatus = (typeof DOCUMENT_STATUSES)[number];

export const SIGNER_STATUSES = ["pending", "viewed", "signed", "declined"] as const;
export type SignerStatus = (typeof SIGNER_STATUSES)[number];

export const SIGNING_ORDERS = ["parallel", "sequential"] as const;
export type SigningOrder = (typeof SIGNING_ORDERS)[number];

export const MERGE_SOURCES = ["contact", "org", "custom"] as const;
export type MergeSource = (typeof MERGE_SOURCES)[number];

export interface MergeField {
  /** `{{key}}` in the body, e.g. "contact.full_name" or "project_name". */
  key: string;
  label: string;
  source: MergeSource;
  required?: boolean;
}

export interface DocumentTemplateDTO {
  id: string;
  name: string;
  kind: DocumentKind;
  body_md: string;
  fields: MergeField[];
  requires_signature: boolean;
  signer_roles: string[];
  version: number;
  starter_slug: string | null;
  created_at: string;
  updated_at: string;
}

export interface DocumentSignerDTO {
  id: string;
  name: string;
  email: string;
  role: string | null;
  order_index: number;
  status: SignerStatus;
  signed_at: string | null;
  signature_text: string | null;
  decline_reason: string | null;
}

export interface DocumentDTO {
  id: string;
  template_id: string | null;
  title: string;
  kind: DocumentKind;
  body_md: string;
  merge_data: Record<string, string>;
  status: DocumentStatus;
  signing_order: SigningOrder;
  contact_id: string | null;
  contact_name: string | null;
  record_id: string | null;
  quote_id: string | null;
  pdf_hash: string | null;
  signed_pdf_hash: string | null;
  sent_at: string | null;
  viewed_at: string | null;
  completed_at: string | null;
  expires_at: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  signers: DocumentSignerDTO[];
}

/** What a signer sees on the public page: no other signers' emails, no internal ids beyond what the token names. */
export interface PublicDocument {
  title: string;
  kind: DocumentKind;
  business: string;
  body_md: string;
  status: DocumentStatus;
  expires_at: string | null;
  completed_at: string | null;
  signer: { name: string; email_hint: string; role: string | null; status: SignerStatus; signed_at: string | null };
  /** False while an earlier signer in a sequential flow has not signed yet. */
  your_turn: boolean;
  waiting_on: string | null;
  others: Array<{ name: string; role: string | null; status: SignerStatus }>;
  pdf_hash: string | null;
  signed_pdf_hash: string | null;
}

export const DOCUMENT_STATUS_TONE: Record<DocumentStatus, "neutral" | "info" | "success" | "warning" | "danger" | "accent" | "violet"> = {
  draft: "neutral",
  sent: "info",
  viewed: "accent",
  signed: "success",
  declined: "danger",
  expired: "warning",
  void: "neutral",
};

/** Built-in merge keys offered by the template editor; custom keys are free text. */
export const STANDARD_MERGE_FIELDS: MergeField[] = [
  { key: "contact.full_name", label: "Contact name", source: "contact" },
  { key: "contact.email", label: "Contact email", source: "contact" },
  { key: "contact.phone", label: "Contact phone", source: "contact" },
  { key: "contact.company", label: "Contact company", source: "contact" },
  { key: "contact.billing_address", label: "Contact address", source: "contact" },
  { key: "org.name", label: "Your business name", source: "org" },
  { key: "org.support_email", label: "Your support email", source: "org" },
  { key: "org.today", label: "Today's date", source: "org" },
];

export function emailHint(email: string): string {
  const [user, domain] = email.split("@");
  if (!domain) return "•••";
  const head = user.slice(0, Math.min(2, user.length));
  return `${head}${"•".repeat(Math.max(1, Math.min(6, user.length - head.length)))}@${domain}`;
}
