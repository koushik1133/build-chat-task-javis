import { z } from "zod";
import { registerTool } from "@/lib/agents/registry";
import type { ToolResult } from "@/lib/agents/types";
import { canSendMarketing, currentConsent } from "@/lib/privacy/consent";
import { CONSENT_PURPOSES, DSR_KINDS } from "@/lib/privacy/constants";
import { DsrError, openRequest, resolveSubject } from "@/lib/privacy/dsr";

/** Privacy tools: read consent state; open a data-subject request (always needs approval). */

function fail(error: string): ToolResult {
  return { ok: false, summary: error, error };
}

/* ---------- privacy.consent_status ---------- */
const StatusInput = z.object({
  contact_id: z.string().min(1).max(80),
});
type StatusInputT = z.infer<typeof StatusInput>;

registerTool<StatusInputT>({
  name: "privacy.consent_status",
  module: "privacy",
  description: "Current consent per purpose for a CRM contact plus whether marketing email / SMS / voice may be sent (consent + opt-outs + erasure tombstones). Call before any marketing outreach.",
  input: StatusInput,
  parameters: { type: "object", properties: { contact_id: { type: "string", description: "CRM contact id" } }, required: ["contact_id"] },
  scope: "read",
  preview: (i) => `Consent status for contact ${i.contact_id}`,
  async run(ctx, input) {
    try {
      const identity = await resolveSubject(ctx.userId, { kind: "contact", id: input.contact_id });
      if (!identity) return fail("Contact not found");
      const current = await currentConsent(ctx.userId, { kind: "contact", id: input.contact_id });
      const [email, sms, voice] = await Promise.all([
        canSendMarketing(ctx.userId, input.contact_id, "email"),
        canSendMarketing(ctx.userId, input.contact_id, "sms"),
        canSendMarketing(ctx.userId, input.contact_id, "voice"),
      ]);
      const purposes = Object.fromEntries(CONSENT_PURPOSES.map((p) => [p, current[p]?.status ?? "unknown"]));
      const allowed = [email.allowed && "email", sms.allowed && "sms", voice.allowed && "voice"].filter(Boolean);
      return {
        ok: true,
        summary: allowed.length ? `${identity.name ?? "Contact"} may be contacted via ${allowed.join(", ")}` : `${identity.name ?? "Contact"} has not consented to marketing on any channel`,
        data: { contact: { id: input.contact_id, name: identity.name }, purposes, marketing: { email, sms, voice } },
      };
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  },
});

/* ---------- privacy.open_request ---------- */
const OpenInput = z.object({
  subject_kind: z.enum(["contact", "lead"]),
  subject_id: z.string().min(1).max(80),
  kind: z.enum(DSR_KINDS),
  notes: z.string().max(2000).optional(),
});
type OpenInputT = z.infer<typeof OpenInput>;

registerTool<OpenInputT>({
  name: "privacy.open_request",
  module: "privacy",
  description: "Open a data-subject request (access, erasure, correction, portability, nomination) for a contact or lead. Staff then verify and fulfil it under Settings → Privacy & data.",
  input: OpenInput,
  parameters: {
    type: "object",
    properties: {
      subject_kind: { type: "string", enum: ["contact", "lead"] },
      subject_id: { type: "string" },
      kind: { type: "string", enum: [...DSR_KINDS] },
      notes: { type: "string" },
    },
    required: ["subject_kind", "subject_id", "kind"],
  },
  scope: "write",
  requiresApproval: true,
  preview: (i) => `Open ${i.kind} request for ${i.subject_kind} ${i.subject_id}`,
  async run(ctx, input) {
    try {
      const r = await openRequest(ctx.userId, { subject: { kind: input.subject_kind, id: input.subject_id }, kind: input.kind, source: "agent", notes: input.notes ?? null });
      return { ok: true, summary: `Opened ${r.kind} request, due ${new Date(r.due_at).toDateString()}`, data: { id: r.id, status: r.status, due_at: r.due_at } };
    } catch (err) {
      if (err instanceof DsrError) return fail(err.message);
      return fail(err instanceof Error ? err.message : String(err));
    }
  },
});
