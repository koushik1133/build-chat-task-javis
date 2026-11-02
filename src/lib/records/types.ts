/**
 * Records primitive: configurable record types (fields + stages) and the
 * records that live in them. Replaces the one-screen vertical hubs.
 */

export const FIELD_TYPES = [
  "text",
  "number",
  "money",
  "date",
  "select",
  "multiselect",
  "boolean",
  "email",
  "phone",
  "url",
  "textarea",
  "contact_ref",
] as const;
export type FieldType = (typeof FIELD_TYPES)[number];

export interface FieldDef {
  key: string;
  label: string;
  type: FieldType;
  required?: boolean;
  options?: string[];
}

export interface StageDef {
  key: string;
  label: string;
  color?: string;
}

export interface RecordTypeViews {
  /** Field keys shown as columns in table view (defaults to first 4 fields). */
  tableColumns?: string[];
  /** Field keys shown on board cards. */
  cardFields?: string[];
  /** Field key used to populate `amount_minor` (must be a money field). */
  amountField?: string;
  /** Field key used to populate `due_at` (must be a date field). */
  dueField?: string;
  /** Field key used to populate `contact_id` (must be a contact_ref field). */
  contactField?: string;
}

export interface RecordTypeRow {
  id: string;
  user_id: string;
  slug: string;
  name: string;
  icon: string | null;
  description: string | null;
  fields: string;
  stages: string;
  views: string;
  copilot_prompt: string | null;
  pack_slug: string | null;
  created_at: string;
  updated_at: string;
}

export interface RecordType {
  id: string;
  slug: string;
  name: string;
  icon: string | null;
  description: string | null;
  fields: FieldDef[];
  stages: StageDef[];
  views: RecordTypeViews;
  copilot_prompt: string | null;
  pack_slug: string | null;
  created_at: string;
  updated_at: string;
}

export type RecordData = Record<string, unknown>;

export interface RecordRow {
  id: string;
  user_id: string;
  type_id: string;
  title: string;
  stage: string;
  data: string;
  summary: string | null;
  contact_id: string | null;
  amount_minor: string | number | null;
  currency: string | null;
  due_at: string | null;
  assigned_to: string | null;
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface RecordItem {
  id: string;
  type_id: string;
  title: string;
  stage: string;
  data: RecordData;
  summary: string | null;
  contact_id: string | null;
  amount_minor: number | null;
  currency: string | null;
  due_at: string | null;
  assigned_to: string | null;
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
}

export const ACTIVITY_KINDS = ["created", "moved", "updated", "comment", "linked"] as const;
export type ActivityKind = (typeof ACTIVITY_KINDS)[number];

export interface ActivityRow {
  id: string;
  record_id: string;
  actor_id: string | null;
  kind: ActivityKind;
  body: string | null;
  diff: string | null;
  created_at: string;
}

export const LINK_KINDS = ["contact", "task", "quote", "invoice", "booking", "record"] as const;
export type LinkKind = (typeof LINK_KINDS)[number];

export interface LinkRow {
  id: string;
  record_id: string;
  target_kind: LinkKind;
  target_id: string;
  created_at: string;
}

/** A template pack: a bundle of record types that mirrors one vertical. */
export interface PackTypeTemplate {
  slug: string;
  name: string;
  icon: string;
  description: string;
  fields: FieldDef[];
  stages: StageDef[];
  views?: RecordTypeViews;
  copilot_prompt: string;
}

export interface Pack {
  slug: string;
  name: string;
  description: string;
  icon: string;
  recordTypes: PackTypeTemplate[];
}
