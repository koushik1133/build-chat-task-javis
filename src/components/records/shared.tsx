"use client";

import type { LucideIcon } from "lucide-react";
import {
  Boxes,
  BookOpen,
  Briefcase,
  Building2,
  Calendar,
  DollarSign,
  FileText,
  FolderKanban,
  GraduationCap,
  HandHeart,
  Heart,
  Home,
  Key,
  Landmark,
  Megaphone,
  Package,
  Repeat,
  Rocket,
  Scale,
  ShoppingBag,
  ShoppingCart,
  TrendingUp,
  Truck,
  Users,
  Wrench,
} from "lucide-react";
import { Checkbox, Input, Select, Textarea } from "@/components/ui/input";
import { TONE, type Tone } from "@/components/ui/pill";
import { cn } from "@/lib/utils";
import { fmtDate, fmtMoney } from "@/lib/money/format";
import type { FieldDef, RecordItem, RecordType, StageDef } from "@/lib/records/types";

/** Client-safe helpers shared by the records pages. */

export { Banner, Empty, ErrorState, Loading, Skeleton, SkeletonList } from "@/components/ui/feedback";

const ICONS: Record<string, LucideIcon> = {
  heart: Heart,
  calendar: Calendar,
  "graduation-cap": GraduationCap,
  "book-open": BookOpen,
  scale: Scale,
  "file-text": FileText,
  "dollar-sign": DollarSign,
  "trending-up": TrendingUp,
  landmark: Landmark,
  home: Home,
  key: Key,
  "shopping-bag": ShoppingBag,
  package: Package,
  "shopping-cart": ShoppingCart,
  "hand-heart": HandHeart,
  megaphone: Megaphone,
  rocket: Rocket,
  briefcase: Briefcase,
  building: Building2,
  repeat: Repeat,
  "folder-kanban": FolderKanban,
  users: Users,
  truck: Truck,
  wrench: Wrench,
};

export function TypeIcon({ name, className }: { name: string | null | undefined; className?: string }) {
  const Icon = (name && ICONS[name]) || Boxes;
  return <Icon className={cn("h-4 w-4", className)} aria-hidden />;
}

/** Stage colours map onto the shared pill tones so a "green" stage looks like every other success state. */
const STAGE_TONE: Record<string, Tone> = {
  gray: "neutral",
  blue: "info",
  amber: "warning",
  green: "success",
  red: "danger",
  purple: "violet",
  orange: "accent",
};
const STAGE_DOTS: Record<string, string> = {
  gray: "bg-muted-foreground",
  blue: "bg-blue-500",
  amber: "bg-amber-500",
  green: "bg-emerald-500",
  red: "bg-red-500",
  purple: "bg-violet-500",
  orange: "bg-orange-500",
};

export function stageTone(color?: string): string {
  return TONE[STAGE_TONE[color ?? "gray"] ?? "neutral"];
}
export function stageDot(color?: string): string {
  return STAGE_DOTS[color ?? "gray"] ?? STAGE_DOTS.gray;
}

export function StagePill({ stage, stages, className }: { stage: string; stages: StageDef[]; className?: string }) {
  const def = stages.find((s) => s.key === stage);
  return (
    <span className={cn("inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-medium", stageTone(def?.color), className)}>
      <span className={cn("h-1.5 w-1.5 rounded-full", stageDot(def?.color))} aria-hidden />
      {def?.label ?? stage}
    </span>
  );
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, { ...init, headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) } });
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const detail = data?.detail;
    const msg = Array.isArray(detail)
      ? detail.join("; ")
      : typeof detail === "string"
        ? detail
        : detail?.formErrors?.[0] ?? (detail?.fieldErrors ? Object.values(detail.fieldErrors).flat()[0] : null) ?? data?.error ?? `Request failed (${res.status})`;
    throw new Error(String(msg));
  }
  return data as T;
}

/** Render a stored field value for display. */
export function formatValue(field: FieldDef, value: unknown, currency?: string | null): string {
  if (value === null || value === undefined || value === "") return "—";
  switch (field.type) {
    case "money":
      return typeof value === "number" ? fmtMoney(value, currency || "USD") : String(value);
    case "date":
      return fmtDate(String(value));
    case "boolean":
      return value ? "Yes" : "No";
    case "multiselect":
      return Array.isArray(value) ? value.join(", ") : String(value);
    default:
      return String(value);
  }
}

/** Convert a stored value into the string a form input should show. */
export function toInputValue(field: FieldDef, value: unknown): string | boolean | string[] {
  if (field.type === "boolean") return Boolean(value);
  if (field.type === "multiselect") return Array.isArray(value) ? value.map(String) : [];
  if (value === null || value === undefined) return "";
  if (field.type === "money" && typeof value === "number") return (value / 100).toFixed(2);
  if (field.type === "date" && typeof value === "string") {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? "" : d.toISOString().slice(0, 10);
  }
  return String(value);
}

export type FormValues = Record<string, string | boolean | string[]>;

export function emptyForm(type: RecordType): FormValues {
  const out: FormValues = {};
  for (const f of type.fields) out[f.key] = f.type === "boolean" ? false : f.type === "multiselect" ? [] : "";
  return out;
}

export function formFromRecord(type: RecordType, rec: RecordItem): FormValues {
  const out: FormValues = {};
  for (const f of type.fields) out[f.key] = toInputValue(f, rec.data[f.key]);
  return out;
}

/** Turn form values into the API `data` payload (blank strings become null so they clear). */
export function formToData(type: RecordType, values: FormValues): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of type.fields) {
    const v = values[f.key];
    if (f.type === "boolean") out[f.key] = Boolean(v);
    else if (f.type === "multiselect") out[f.key] = Array.isArray(v) ? v : [];
    else out[f.key] = typeof v === "string" && v.trim() === "" ? null : v;
  }
  return out;
}

/** One generated form control for a field definition. */
export function FieldInput({
  field,
  value,
  onChange,
  id,
  disabled,
}: {
  field: FieldDef;
  value: string | boolean | string[];
  onChange: (v: string | boolean | string[]) => void;
  id: string;
  disabled?: boolean;
}) {
  const text = String(value ?? "");
  switch (field.type) {
    case "textarea":
      return <Textarea id={id} value={text} onChange={(e) => onChange(e.target.value)} rows={3} disabled={disabled} required={field.required} />;
    case "boolean":
      return <Checkbox id={id} checked={Boolean(value)} onChange={(e) => onChange(e.target.checked)} disabled={disabled} label={<span className="text-muted-foreground">{Boolean(value) ? "Yes" : "No"}</span>} />;
    case "select":
      return (
        <Select id={id} value={text} onChange={(e) => onChange(e.target.value)} disabled={disabled} required={field.required}>
          <option value="">—</option>
          {(field.options ?? []).map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </Select>
      );
    case "multiselect": {
      const selected = Array.isArray(value) ? value : [];
      return (
        <div id={id} role="group" aria-label={field.label} className="flex flex-wrap gap-1.5 py-1">
          {(field.options ?? []).map((o) => {
            const on = selected.includes(o);
            return (
              <button
                key={o}
                type="button"
                aria-pressed={on}
                disabled={disabled}
                onClick={() => onChange(on ? selected.filter((x) => x !== o) : [...selected, o])}
                className={cn(
                  "inline-flex min-h-11 items-center rounded-full border px-3 text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50 motion-reduce:transition-none sm:min-h-8",
                  on ? "border-primary bg-primary text-primary-foreground" : "border-border hover:bg-secondary/60"
                )}
              >
                {o}
              </button>
            );
          })}
        </div>
      );
    }
    case "number":
      return <Input id={id} type="number" step="any" inputMode="decimal" value={text} onChange={(e) => onChange(e.target.value)} disabled={disabled} required={field.required} />;
    case "money":
      return <Input id={id} type="number" step="0.01" min="0" inputMode="decimal" placeholder="0.00" value={text} onChange={(e) => onChange(e.target.value)} disabled={disabled} required={field.required} />;
    case "date":
      return <Input id={id} type="date" value={text} onChange={(e) => onChange(e.target.value)} disabled={disabled} required={field.required} />;
    case "email":
      return <Input id={id} type="email" autoComplete="off" spellCheck={false} value={text} onChange={(e) => onChange(e.target.value)} disabled={disabled} required={field.required} />;
    case "phone":
      return <Input id={id} type="tel" autoComplete="off" value={text} onChange={(e) => onChange(e.target.value)} disabled={disabled} required={field.required} />;
    case "url":
      return <Input id={id} type="text" inputMode="url" spellCheck={false} placeholder="example.com" value={text} onChange={(e) => onChange(e.target.value)} disabled={disabled} required={field.required} />;
    case "contact_ref":
      return <Input id={id} type="text" placeholder="Contact ID or name" value={text} onChange={(e) => onChange(e.target.value)} disabled={disabled} required={field.required} />;
    default:
      return <Input id={id} type="text" value={text} onChange={(e) => onChange(e.target.value)} disabled={disabled} required={field.required} />;
  }
}
