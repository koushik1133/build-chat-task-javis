import { z } from "zod";
import { query, queryOne } from "@/lib/dsql";
import { registerTool } from "@/lib/agents/registry";
import { sendEmailUnified } from "@/lib/email-sender";
import type { ToolResult } from "@/lib/agents/types";

/** Outbound communication tools: email drafts/sends and in-app notifications. */

function fail(error: string): ToolResult {
  return { ok: false, summary: error, error };
}
function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Plain text → minimal HTML (paragraphs on blank lines, <br> on newlines). */
function textToHtml(body: string): string {
  return body
    .trim()
    .split(/\n{2,}/)
    .map((p) => `<p>${escapeHtml(p).replace(/\n/g, "<br/>")}</p>`)
    .join("\n");
}

const EmailInput = z.object({
  to: z.string().email().max(200),
  subject: z.string().min(1).max(200),
  body: z.string().min(1).max(10000),
});
type EmailInputT = z.infer<typeof EmailInput>;

const EMAIL_PARAMS = {
  type: "object",
  properties: {
    to: { type: "string", description: "Recipient email address" },
    subject: { type: "string" },
    body: { type: "string", description: "Plain-text body; blank lines separate paragraphs" },
  },
  required: ["to", "subject", "body"],
} as const;

/* ---------- comms.draft_email ---------- */
registerTool<EmailInputT>({
  name: "comms.draft_email",
  module: "comms",
  description: "Compose an email draft for the user to review. Nothing is sent.",
  input: EmailInput,
  parameters: { ...EMAIL_PARAMS },
  scope: "read",
  preview: (i) => `Draft email to ${i.to}: ${i.subject}`,
  async run(_ctx, input) {
    return {
      ok: true,
      data: { to: input.to, subject: input.subject, body: input.body, html: textToHtml(input.body) },
      summary: `Drafted email to ${input.to} — "${input.subject}"`,
    };
  },
});

/* ---------- comms.send_email ---------- */
registerTool<EmailInputT>({
  name: "comms.send_email",
  module: "comms",
  description: "Send an email to an external recipient. Always requires human approval.",
  input: EmailInput,
  parameters: { ...EMAIL_PARAMS },
  scope: "write",
  requiresApproval: true,
  preview: (i) => `Send email to ${i.to}: "${i.subject}" (${i.body.length} chars)`,
  async run(ctx, input) {
    try {
      const profile = await queryOne<{ company_name: string | null }>(
        `SELECT company_name FROM business_profile WHERE user_id = $1`,
        [ctx.userId]
      ).catch(() => null);
      const res = await sendEmailUnified({
        to: input.to,
        subject: input.subject,
        html: textToHtml(input.body),
        fromName: profile?.company_name ?? null,
      });
      if (!res.success) return fail(`${res.message}${res.detail ? `: ${res.detail}` : ""}`);
      return { ok: true, data: { to: input.to, subject: input.subject, message: res.message }, summary: `Sent email to ${input.to}` };
    } catch (err) {
      return fail(`Send failed: ${errMsg(err)}`);
    }
  },
});

/* ---------- comms.notify ---------- */
const NotifyInput = z.object({
  title: z.string().min(1).max(200),
  message: z.string().max(2000).optional(),
});
type NotifyInputT = z.infer<typeof NotifyInput>;

registerTool<NotifyInputT>({
  name: "comms.notify",
  module: "comms",
  description: "Post an in-app notification to the user's notification bell.",
  input: NotifyInput,
  parameters: {
    type: "object",
    properties: { title: { type: "string" }, message: { type: "string" } },
    required: ["title"],
  },
  scope: "write",
  requiresApproval: false,
  preview: (i) => `Notify: ${i.title}`,
  async run(ctx, input) {
    try {
      const rows = await query<{ id: string }>(
        `INSERT INTO notifications (user_id, title, body) VALUES ($1, $2, $3) RETURNING id`,
        [ctx.userId, input.title, input.message ?? null]
      );
      return { ok: true, data: { id: rows[0]?.id ?? null }, summary: `Notification posted: ${input.title}` };
    } catch (err) {
      return fail(`Notify failed: ${errMsg(err)}`);
    }
  },
});

/* ---------- messaging.reply ---------- */
/**
 * The receptionist queues its drafts as `messaging.reply` approvals (and as a
 * hidden pending turn in the thread). Approving executes this tool, which
 * releases the turn and sends it through the channel.
 */
const ReplyInput = z.object({
  to: z.string().min(1).max(200).describe("Conversation address: phone number, email or web:<session>"),
  channel: z.enum(["sms", "whatsapp", "email", "webchat"]),
  text: z.string().min(1).max(1600),
});
type ReplyInputT = z.infer<typeof ReplyInput>;

registerTool<ReplyInputT>({
  name: "messaging.reply",
  module: "comms",
  description: "Send a reply in an inbox conversation (SMS, WhatsApp, email or web chat). Drafted replies wait for approval; approving sends them.",
  input: ReplyInput,
  parameters: {
    type: "object",
    properties: {
      to: { type: "string", description: "Phone number (sms/whatsapp), email address or web:<sessionId>" },
      channel: { type: "string", enum: ["sms", "whatsapp", "email", "webchat"] },
      text: { type: "string", description: "Plain-text reply (max 1600 chars)" },
    },
    required: ["to", "channel", "text"],
  },
  scope: "write",
  requiresApproval: true,
  preview: (i) => `Reply to ${i.to} via ${i.channel}: ${i.text.slice(0, 160)}`,
  async run(ctx, input) {
    try {
      const { deliverApprovedReply } = await import("@/lib/messaging/reply");
      const r = await deliverApprovedReply(ctx.userId, input);
      const how = r.sent ? `sent via ${input.channel}` : r.simulated ? `recorded (${input.channel} not configured${r.error ? `: ${r.error}` : ""})` : "delivered";
      return { ok: true, data: { conversation_id: r.conversationId, sent: r.sent, simulated: r.simulated, released_draft: r.released }, summary: `Reply to ${input.to} ${how}` };
    } catch (err) {
      return fail(`Reply failed: ${errMsg(err)}`);
    }
  },
});
