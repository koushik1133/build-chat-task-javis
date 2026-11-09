import type { AutomationDefinition } from "./types";

/**
 * Ready-made automations (client-safe). Each is a full v2 definition installed
 * paused with `autonomy: "approve"` unless the steps are harmless, so the
 * operator reviews recipients before anything leaves the workspace.
 *
 * Tools referenced here must exist in src/lib/agents/tools; templates that
 * depend on optional modules fall back to a task when the tool is missing
 * (the `requires_tool` hint drives that swap in installTemplate).
 */

export interface AutomationTemplate {
  key: string;
  title: string;
  summary: string;
  category: "billing" | "sales" | "support" | "operations" | "privacy" | "growth";
  /** Optional tool that, when not registered at install time, is replaced by the `fallback_step_id` → tasks.create swap. */
  requires_tool?: string;
  fallback_step_id?: string;
  definition: AutomationDefinition;
}

const OWNER = "{{org.id}}";

export const AUTOMATION_TEMPLATES: AutomationTemplate[] = [
  {
    key: "overdue-invoice-reminder",
    title: "Overdue invoice → reminder + follow-up task",
    summary: "When an invoice goes overdue, email the customer a reminder and open a task to chase it.",
    category: "billing",
    definition: {
      name: "Overdue invoice reminder",
      description: "Reminder email to the customer plus an internal follow-up task.",
      trigger_type: "event",
      trigger_config: { event_type: "invoice.overdue" },
      conditions: { all: [{ field: "entity.status", op: "neq", value: "paid" }] },
      steps: [
        {
          id: "remind",
          kind: "notify",
          name: "Email reminder",
          config: {
            channel: "email",
            to: "{{entity.customer_email ?? event.data.to}}",
            subject: "Invoice {{entity.number ?? event.data.number}} is overdue",
            body: "Hello {{entity.customer_name ?? \"there\"}},\n\nInvoice {{entity.number ?? event.data.number}} for {{entity.total_minor | money}} {{entity.currency}} is past due. Please settle it at your earliest convenience.\n\nThank you,\n{{org.name}}",
          },
        },
        { id: "task", kind: "tool", name: "Follow-up task", config: { tool: "tasks.create", input: { title: "Chase overdue invoice {{entity.number ?? event.data.number}}" } } },
      ],
      autonomy: "approve",
      enabled: false,
    },
  },
  {
    key: "new-lead-welcome",
    title: "New lead → enrich + assign + welcome email",
    summary: "Mark the lead as contacted, create a follow-up task and send a consent-checked welcome email.",
    category: "sales",
    definition: {
      name: "New lead welcome",
      description: "Enrich, assign and welcome new leads. The welcome email only sends when marketing consent exists.",
      trigger_type: "event",
      trigger_config: { event_type: "lead.captured" },
      conditions: null,
      steps: [
        { id: "status", kind: "tool", name: "Mark contacted", config: { tool: "leads.mark_status", input: { id: "{{event.entity_id}}", status: "contacted" } } },
        { id: "assign", kind: "tool", name: "Assign follow-up", config: { tool: "tasks.create", input: { title: "Follow up with lead {{event.data.email ?? event.entity_id}}" } } },
        {
          id: "welcome",
          kind: "notify",
          name: "Welcome email (consent)",
          config: {
            channel: "email",
            to: "{{event.data.email}}",
            subject: "Thanks for reaching out to {{org.name}}",
            body: "Hi,\n\nThanks for getting in touch. One of us will follow up shortly.\n\n{{org.name}}",
            marketing: true,
            contact_id: "{{event.data.contact_id ?? entity.contact_id}}",
          },
        },
      ],
      autonomy: "approve",
      enabled: false,
    },
  },
  {
    key: "booking-confirmation-crm",
    title: "Booking created → confirmation + add to CRM",
    summary: "Confirm the appointment by email and make sure the person exists as a contact.",
    category: "sales",
    definition: {
      name: "Booking confirmation + CRM",
      trigger_type: "event",
      trigger_config: { event_type: "booking.created" },
      conditions: null,
      steps: [
        {
          id: "confirm",
          kind: "notify",
          name: "Confirmation email",
          config: { channel: "email", to: "{{event.data.email}}", subject: "Your booking is confirmed", body: "Hi {{event.data.name ?? \"there\"}},\n\nYour appointment on {{event.data.startsAt | date}} is confirmed.\n\n{{org.name}}" },
        },
        { id: "has_contact", kind: "branch", name: "Already a contact?", config: { conditions: { field: "event.data.contactId", op: "exists" }, then: "end", else: null } },
        { id: "contact", kind: "tool", name: "Create contact", config: { tool: "crm.create_contact", input: { full_name: "{{event.data.name}}", email: "{{event.data.email}}", lifecycle: "lead" } } },
      ],
      autonomy: "approve",
      enabled: false,
    },
  },
  {
    key: "ticket-sla-escalation",
    title: "Ticket SLA breached → escalate + notify owner",
    summary: "Raise the ticket priority to urgent and alert the workspace owner in-app.",
    category: "support",
    definition: {
      name: "SLA breach escalation",
      trigger_type: "event",
      trigger_config: { event_type: "ticket.sla_breached" },
      conditions: null,
      steps: [
        { id: "escalate", kind: "tool", name: "Escalate ticket", config: { tool: "tasks.create", input: { title: "SLA breached on ticket #{{event.data.number}} ({{event.data.kind}}) — escalate" } } },
        {
          id: "notify",
          kind: "notify",
          name: "Alert owner",
          config: { channel: "in_app", to: OWNER, subject: "SLA breached: ticket #{{event.data.number}}", body: "{{entity.subject ?? \"A ticket\"}} breached its {{event.data.kind}} SLA." },
        },
      ],
      autonomy: "auto",
      enabled: false,
    },
  },
  {
    key: "quote-followup-agent",
    title: "Quote sent, no answer in 3 days → agent drafts follow-up",
    summary: "Three days after a quote goes out, if it is still open an agent drafts a friendly nudge.",
    category: "sales",
    definition: {
      name: "Quote follow-up draft",
      trigger_type: "event",
      trigger_config: { event_type: "quote.sent" },
      conditions: null,
      steps: [
        { id: "wait", kind: "delay", name: "Wait 3 days", config: { minutes: 3 * 24 * 60 } },
        { id: "still_open", kind: "branch", name: "Still not accepted?", config: { conditions: { all: [{ field: "entity.status", op: "neq", value: "accepted" }, { field: "entity.status", op: "neq", value: "declined" }] }, then: null, else: "end" } },
        { id: "draft", kind: "agent", name: "Draft follow-up", config: { agent_id: "", prompt: "Quote {{event.data.number}} for {{event.data.total_minor | money}} {{event.data.currency}} was sent to {{event.data.to}} three days ago with no reply. Draft a short, friendly follow-up email." } },
      ],
      autonomy: "approve",
      enabled: false,
    },
  },
  {
    key: "low-stock-po",
    title: "Low stock → draft purchase order (or task)",
    summary: "When a product dips below its reorder point, draft a purchase order — or a restock task when procurement is not installed.",
    category: "operations",
    requires_tool: "procurement.draft_purchase_order",
    fallback_step_id: "po",
    definition: {
      name: "Low stock reorder",
      trigger_type: "event",
      trigger_config: { event_type: "product.stock_changed" },
      conditions: { field: "event.data.low_stock", op: "eq", value: true },
      steps: [
        { id: "po", kind: "tool", name: "Draft purchase order", config: { tool: "procurement.draft_purchase_order", input: { product_id: "{{event.entity_id}}", note: "Auto-drafted: stock fell to {{event.data.stock_on_hand}}" } } },
        { id: "notify", kind: "notify", name: "Tell the owner", config: { channel: "in_app", to: OWNER, subject: "Low stock: {{entity.name ?? event.entity_id}}", body: "Stock on hand is {{event.data.stock_on_hand}} ({{event.data.stock_available}} available)." } },
      ],
      autonomy: "approve",
      enabled: false,
    },
  },
  {
    key: "record-stage-notify",
    title: "Record moved to a stage → notify",
    summary: "Tell the team when a record lands in a chosen stage (edit the stage in the condition).",
    category: "operations",
    definition: {
      name: "Record reached stage",
      trigger_type: "event",
      trigger_config: { event_type: "record.moved" },
      conditions: { field: "event.data.to", op: "changed_to", value: "won" },
      steps: [{ id: "notify", kind: "notify", name: "In-app notice", config: { channel: "in_app", to: OWNER, subject: "{{event.data.title ?? \"A record\"}} moved to {{event.data.to}}", body: "{{event.data.type}} record moved from {{event.data.from}} to {{event.data.to}}." } }],
      autonomy: "auto",
      enabled: false,
    },
  },
  {
    key: "payment-thankyou-accounting",
    title: "Payment received → thank-you + accounting push",
    summary: "Thank the customer and push the paid invoice to the connected accounting provider.",
    category: "billing",
    definition: {
      name: "Payment received",
      trigger_type: "event",
      trigger_config: { event_type: "invoice.paid" },
      conditions: null,
      steps: [
        {
          id: "thanks",
          kind: "notify",
          name: "Thank-you email",
          config: { channel: "email", to: "{{entity.customer_email}}", subject: "Thanks for your payment", body: "Hi {{entity.customer_name ?? \"there\"}},\n\nWe received your payment for invoice {{entity.number}}. Thank you!\n\n{{org.name}}" },
        },
        { id: "push", kind: "tool", name: "Push to accounting", config: { tool: "accounting.push_invoice", input: { invoice_id: "{{event.entity_id}}" } } },
      ],
      autonomy: "approve",
      enabled: false,
    },
  },
  {
    key: "webchat-handoff-ticket",
    title: "Webchat handoff → create ticket",
    summary: "When a website visitor asks for a human, open a helpdesk ticket with the transcript summary.",
    category: "support",
    definition: {
      name: "Webchat handoff to ticket",
      trigger_type: "event",
      trigger_config: { event_type: "webchat.handoff_requested" },
      conditions: null,
      steps: [
        {
          id: "ticket",
          kind: "tool",
          name: "Create ticket",
          config: { tool: "helpdesk.create_ticket", input: { subject: "Webchat handoff: {{event.data.reason ?? \"visitor asked for a human\"}}", body: "{{event.data.summary ?? event.data.last_message ?? \"See chat session \"}}{{event.entity_id}}", priority: "high", requester_email: "{{event.data.email}}" } },
        },
      ],
      autonomy: "auto",
      enabled: false,
    },
  },
  {
    key: "shift-published-notify",
    title: "Shift published → notify staff",
    summary: "Let the assigned team member know when a new shift is published (workforce module).",
    category: "operations",
    definition: {
      name: "Shift published notice",
      trigger_type: "event",
      trigger_config: { event_type: "shift.published" },
      conditions: { field: "event.data.member_id", op: "exists" },
      steps: [{ id: "notify", kind: "notify", name: "Notify member", config: { channel: "in_app", to: "{{event.data.member_id}}", subject: "New shift published", body: "You have a shift on {{event.data.starts_at | date}}." } }],
      autonomy: "auto",
      enabled: false,
    },
  },
  {
    key: "dsr-received-task",
    title: "Data request received → task + reminder",
    summary: "Open a task for every privacy request and remind the owner three days before it is due.",
    category: "privacy",
    definition: {
      name: "DSR received",
      trigger_type: "event",
      trigger_config: { event_type: "privacy.dsr.received" },
      conditions: null,
      steps: [
        { id: "task", kind: "tool", name: "Handle request", config: { tool: "tasks.create", input: { title: "Handle {{event.data.kind}} request {{event.entity_id}} (due {{event.data.due_at | date}})" } } },
        { id: "wait", kind: "delay", name: "Wait 7 days", config: { minutes: 7 * 24 * 60 } },
        { id: "remind", kind: "notify", name: "Reminder", config: { channel: "in_app", to: OWNER, subject: "Privacy request due soon", body: "The {{event.data.kind}} request {{event.entity_id}} is due {{event.data.due_at | date}}." } },
      ],
      autonomy: "auto",
      enabled: false,
    },
  },
  {
    key: "marketplace-install-onboarding",
    title: "Marketplace install → onboarding note",
    summary: "After installing a listing, send the owner a getting-started note with next steps.",
    category: "growth",
    definition: {
      name: "Marketplace onboarding",
      trigger_type: "event",
      trigger_config: { event_type: "marketplace.installed" },
      conditions: null,
      steps: [{ id: "notify", kind: "notify", name: "Getting started", config: { channel: "in_app", to: OWNER, subject: "{{event.data.title}} is installed", body: "Open the {{event.data.kind}} you just installed, review its settings and switch it on when ready." } }],
      autonomy: "auto",
      enabled: false,
    },
  },
  {
    key: "new-ticket-ack",
    title: "New ticket → acknowledge + triage task",
    summary: "Acknowledge urgent tickets in-app and open a triage task.",
    category: "support",
    definition: {
      name: "New ticket triage",
      trigger_type: "event",
      trigger_config: { event_type: "ticket.created" },
      conditions: { any: [{ field: "event.data.priority", op: "in", value: ["high", "urgent"] }, { field: "entity.priority", op: "in", value: ["high", "urgent"] }] },
      steps: [
        { id: "task", kind: "tool", name: "Triage task", config: { tool: "tasks.create", input: { title: "Triage ticket #{{event.data.number}}: {{event.data.subject}}" } } },
        { id: "notify", kind: "notify", name: "Alert owner", config: { channel: "in_app", to: OWNER, subject: "Urgent ticket #{{event.data.number}}", body: "{{event.data.subject}} from {{event.data.requester_email ?? \"unknown\"}}." } },
      ],
      autonomy: "auto",
      enabled: false,
    },
  },
];

export function getTemplate(key: string): AutomationTemplate | undefined {
  return AUTOMATION_TEMPLATES.find((t) => t.key === key);
}
