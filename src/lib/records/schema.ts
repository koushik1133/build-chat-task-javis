import { z } from "zod";
import { FIELD_TYPES, type FieldDef, type RecordData, type RecordTypeViews, type StageDef } from "./types";

const keyRe = /^[a-z][a-z0-9_]{0,39}$/;

export const FieldDefSchema = z
  .object({
    key: z.string().regex(keyRe, "key must be snake_case"),
    label: z.string().min(1).max(80),
    type: z.enum(FIELD_TYPES),
    required: z.boolean().optional(),
    options: z.array(z.string().min(1).max(80)).max(50).optional(),
  })
  .superRefine((f, ctx) => {
    if ((f.type === "select" || f.type === "multiselect") && (!f.options || f.options.length === 0)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `${f.key}: select fields need options` });
    }
  });

export const StageDefSchema = z.object({
  key: z.string().regex(keyRe, "stage key must be snake_case"),
  label: z.string().min(1).max(60),
  color: z.string().max(30).optional(),
});

export const ViewsSchema = z.object({
  tableColumns: z.array(z.string()).max(20).optional(),
  cardFields: z.array(z.string()).max(8).optional(),
  amountField: z.string().optional(),
  dueField: z.string().optional(),
  contactField: z.string().optional(),
});

function uniqueKeys<T extends { key: string }>(items: T[]): boolean {
  return new Set(items.map((i) => i.key)).size === items.length;
}

export const FieldsSchema = z.array(FieldDefSchema).max(60).refine(uniqueKeys, "field keys must be unique");
export const StagesSchema = z.array(StageDefSchema).min(1).max(20).refine(uniqueKeys, "stage keys must be unique");

export const RESERVED_TYPE_SLUGS = ["types", "packs", "migrate-legacy"] as const;

export const RecordTypeInputSchema = z.object({
  slug: z
    .string()
    .regex(/^[a-z][a-z0-9-]{0,39}$/)
    .refine((s) => !(RESERVED_TYPE_SLUGS as readonly string[]).includes(s), "reserved slug")
    .optional(),
  name: z.string().min(1).max(80),
  icon: z.string().max(40).optional().nullable(),
  description: z.string().max(1000).optional().nullable(),
  fields: FieldsSchema,
  stages: StagesSchema,
  views: ViewsSchema.optional(),
  copilot_prompt: z.string().max(4000).optional().nullable(),
});
export type RecordTypeInput = z.infer<typeof RecordTypeInputSchema>;

export const RecordTypePatchSchema = RecordTypeInputSchema.partial();

export function slugifyRecordType(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "").slice(0, 40);
}

/** Validate view field references against the field list. */
export function validateViews(views: RecordTypeViews, fields: FieldDef[]): string[] {
  const byKey = new Map(fields.map((f) => [f.key, f]));
  const errors: string[] = [];
  for (const k of [...(views.tableColumns ?? []), ...(views.cardFields ?? [])]) {
    if (!byKey.has(k)) errors.push(`view references unknown field "${k}"`);
  }
  const check = (key: string | undefined, type: FieldDef["type"], label: string) => {
    if (!key) return;
    const f = byKey.get(key);
    if (!f) errors.push(`${label} references unknown field "${key}"`);
    else if (f.type !== type) errors.push(`${label} must point at a ${type} field`);
  };
  check(views.amountField, "money", "amountField");
  check(views.dueField, "date", "dueField");
  check(views.contactField, "contact_ref", "contactField");
  return errors;
}

export class RecordValidationError extends Error {
  constructor(public readonly issues: string[]) {
    super(issues.join("; "));
    this.name = "RecordValidationError";
  }
}

const isBlank = (v: unknown) => v === undefined || v === null || v === "" || (Array.isArray(v) && v.length === 0);

/** Parse a money input (number of major units or "12.34") to minor units. */
export function toMinor(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? Math.round(v * 100) : null;
  if (typeof v === "string") {
    const cleaned = v.replace(/[^0-9.\-]/g, "");
    if (!cleaned) return null;
    const n = Number(cleaned);
    return Number.isFinite(n) ? Math.round(n * 100) : null;
  }
  return null;
}

function coerceOne(field: FieldDef, raw: unknown): { value: unknown; error?: string } {
  const err = (m: string) => ({ value: undefined, error: `${field.label}: ${m}` });
  switch (field.type) {
    case "text":
    case "textarea":
    case "phone":
    case "contact_ref":
      return typeof raw === "string" ? { value: raw.trim().slice(0, field.type === "textarea" ? 20000 : 500) } : { value: String(raw).slice(0, 500) };
    case "email": {
      const s = String(raw).trim().toLowerCase();
      return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s) ? { value: s } : err("invalid email");
    }
    case "url": {
      const s = String(raw).trim();
      try {
        new URL(s.includes("://") ? s : `https://${s}`);
        return { value: s };
      } catch {
        return err("invalid url");
      }
    }
    case "number": {
      if (typeof raw === "number") return Number.isFinite(raw) ? { value: raw } : err("must be a number");
      const cleaned = String(raw).replace(/[^0-9.\-eE]/g, "");
      const n = cleaned ? Number(cleaned) : NaN;
      return Number.isFinite(n) ? { value: n } : err("must be a number");
    }
    case "money": {
      if (typeof raw === "object" && raw !== null && "minor" in raw) {
        const m = Number((raw as { minor: unknown }).minor);
        return Number.isInteger(m) ? { value: m } : err("invalid amount");
      }
      const m = toMinor(raw);
      return m === null ? err("must be an amount") : { value: m };
    }
    case "date": {
      const d = raw instanceof Date ? raw : new Date(String(raw));
      return Number.isNaN(d.getTime()) ? err("invalid date") : { value: d.toISOString() };
    }
    case "boolean": {
      if (typeof raw === "boolean") return { value: raw };
      const s = String(raw).toLowerCase();
      if (["true", "1", "yes", "on"].includes(s)) return { value: true };
      if (["false", "0", "no", "off"].includes(s)) return { value: false };
      return err("must be true/false");
    }
    case "select": {
      const s = String(raw);
      return field.options?.includes(s) ? { value: s } : err(`must be one of ${field.options?.join(", ")}`);
    }
    case "multiselect": {
      const arr = Array.isArray(raw) ? raw.map(String) : String(raw).split(",").map((x) => x.trim()).filter(Boolean);
      const bad = arr.find((x) => !field.options?.includes(x));
      return bad ? err(`"${bad}" is not an option`) : { value: arr };
    }
  }
}

/**
 * Validate + coerce a data object against a type's fields.
 * Unknown keys are dropped (except `_legacy_id`, kept for migrations).
 * When `partial`, missing required fields are not an error.
 */
export function validateRecordData(fields: FieldDef[], input: unknown, partial = false): RecordData {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new RecordValidationError(["data must be an object"]);
  }
  const src = input as Record<string, unknown>;
  const out: RecordData = {};
  const issues: string[] = [];
  for (const f of fields) {
    const raw = src[f.key];
    if (isBlank(raw)) {
      // Full validation: a required field must be present. Partial (update):
      // it may be omitted, but it cannot be explicitly cleared to blank.
      if (f.required && (!partial || f.key in src)) issues.push(`${f.label} is required`);
      else if (f.key in src) out[f.key] = null;
      continue;
    }
    const r = coerceOne(f, raw);
    if (r.error) issues.push(r.error);
    else out[f.key] = r.value;
  }
  if (typeof src._legacy_id === "string") out._legacy_id = src._legacy_id;
  if (issues.length) throw new RecordValidationError(issues);
  return out;
}

/** Pick the stage key, defaulting to the first stage. */
export function resolveStage(stages: StageDef[], wanted: unknown): string {
  if (typeof wanted === "string" && stages.some((s) => s.key === wanted)) return wanted;
  if (typeof wanted === "string" && wanted) throw new RecordValidationError([`unknown stage "${wanted}"`]);
  return stages[0]?.key ?? "new";
}
