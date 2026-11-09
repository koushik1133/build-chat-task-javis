/**
 * Pure (client-safe) rules for the customer portal: message validation,
 * booking change window, and public-safe DTO mappers. No DB imports.
 */

export const PORTAL_MESSAGE_MAX = 2000;

export type MessageCheck = { ok: true; body: string } | { ok: false; error: string };

/** Plain text only: strips control characters, trims, enforces 1..2000 chars. */
export function validateMessageBody(raw: unknown): MessageCheck {
  if (typeof raw !== "string") return { ok: false, error: "Message must be text." };
  const body = raw.replace(/\r\n/g, "\n").replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "").trim();
  if (!body) return { ok: false, error: "Message cannot be empty." };
  if (body.length > PORTAL_MESSAGE_MAX) return { ok: false, error: `Message is too long (max ${PORTAL_MESSAGE_MAX} characters).` };
  return { ok: true, body };
}

/** True when a customer may still change (move/cancel) a booking starting at `startsAtIso`. */
export function withinChangeWindow(startsAtIso: string, windowHours: number, now = new Date()): boolean {
  return new Date(startsAtIso).getTime() - now.getTime() >= windowHours * 3_600_000;
}

export interface PortalProject {
  id: string;
  name: string;
  status: string;
  percent: number;
  dueOn: string | null;
  nextMilestone: { name: string; dueOn: string | null } | null;
  milestones: Array<{ name: string; dueOn: string | null; done: boolean }>;
}

export interface PortalOrder {
  id: string;
  number: string;
  status: string;
  currency: string;
  totalMinor: number;
  createdAt: string;
  /** Public order status page (/shop/<slug>/order/<token>) when a link could be issued. */
  path: string | null;
}

export interface PortalDocumentItem {
  id: string;
  title: string;
  status: string;
  /** Per-signer signing link for the pending signer, when known. */
  signPath: string | null;
}

/** Whitelist mapper: the only way internal project fields reach the portal (no budget, rates, notes, owner). */
export function toPortalProject(
  p: { id: string; name: string; status: string; due_on: string | null },
  progress: { percent: number; next_milestone: { name: string; due_on: string | null } | null },
  milestones: Array<{ name: string; due_on: string | null; status: string }>
): PortalProject {
  return {
    id: p.id,
    name: p.name,
    status: p.status,
    percent: Math.max(0, Math.min(100, Math.round(progress.percent))),
    dueOn: p.due_on,
    nextMilestone: progress.next_milestone ? { name: progress.next_milestone.name, dueOn: progress.next_milestone.due_on } : null,
    milestones: milestones.slice(0, 20).map((m) => ({ name: m.name, dueOn: m.due_on, done: m.status === "done" })),
  };
}

/** Keys that must never appear anywhere in a portal payload. */
export const PORTAL_FORBIDDEN_KEYS = ["budget_minor", "hourly_rate_minor", "billing_mode", "owner_member_id", "notes", "internal_notes", "description_md", "user_id", "cost_minor", "customer_email", "shipping_address", "payment_ref"] as const;

/** Returns the first forbidden key found in a JSON-like value (for tests and a defensive check), else null. */
export function findForbiddenKey(value: unknown): string | null {
  if (Array.isArray(value)) {
    for (const v of value) {
      const f = findForbiddenKey(v);
      if (f) return f;
    }
    return null;
  }
  if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if ((PORTAL_FORBIDDEN_KEYS as readonly string[]).includes(k)) return k;
      const f = findForbiddenKey(v);
      if (f) return f;
    }
  }
  return null;
}
