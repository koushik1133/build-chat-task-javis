import type { ChatMessage, ChatProviderId } from "./types";

/** Pure formatters: platform event / message -> provider payloads. No I/O. */

const ZWSP = "\u200b";

/** Slack mrkdwn: escape control chars (&, <, >) and defuse formatting characters with a zero-width space. */
export function escapeSlack(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/([*_~`])/g, `$1${ZWSP}`);
}

/** Discord / Teams markdown: backslash-escape markdown characters and defuse @mentions. */
export function escapeMarkdown(s: string): string {
  return s.replace(/([\\*_~`|>#\[\]()])/g, "\\$1").replace(/@(everyone|here)/gi, `@${ZWSP}$1`);
}

function clip(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

export function formatSlack(msg: ChatMessage): { text: string; blocks: Array<Record<string, unknown>> } {
  const title = escapeSlack(clip(msg.title, 150));
  const blocks: Array<Record<string, unknown>> = [{ type: "header", text: { type: "plain_text", text: clip(msg.title, 150), emoji: false } }];
  if (msg.text) blocks.push({ type: "section", text: { type: "mrkdwn", text: clip(escapeSlack(msg.text), 2900) } });
  if (msg.fields?.length) {
    blocks.push({ type: "section", fields: msg.fields.slice(0, 10).map((f) => ({ type: "mrkdwn", text: `*${escapeSlack(clip(f.label, 40))}*\n${escapeSlack(clip(f.value, 200))}` })) });
  }
  if (msg.url) blocks.push({ type: "actions", elements: [{ type: "button", text: { type: "plain_text", text: "Open in KernelHub" }, url: msg.url }] });
  return { text: title, blocks };
}

export function formatTeams(msg: ChatMessage): Record<string, unknown> {
  const body: Array<Record<string, unknown>> = [{ type: "TextBlock", text: escapeMarkdown(clip(msg.title, 200)), weight: "Bolder", size: "Medium", wrap: true }];
  if (msg.text) body.push({ type: "TextBlock", text: escapeMarkdown(clip(msg.text, 3000)), wrap: true });
  if (msg.fields?.length) body.push({ type: "FactSet", facts: msg.fields.slice(0, 10).map((f) => ({ title: escapeMarkdown(clip(f.label, 40)), value: escapeMarkdown(clip(f.value, 200)) })) });
  const content: Record<string, unknown> = { $schema: "http://adaptivecards.io/schemas/adaptive-card.json", type: "AdaptiveCard", version: "1.4", body };
  if (msg.url) content.actions = [{ type: "Action.OpenUrl", title: "Open in KernelHub", url: msg.url }];
  return { type: "message", attachments: [{ contentType: "application/vnd.microsoft.card.adaptive", contentUrl: null, content }] };
}

export function formatDiscord(msg: ChatMessage): Record<string, unknown> {
  const embed: Record<string, unknown> = { title: clip(escapeMarkdown(msg.title), 256), description: clip(escapeMarkdown(msg.text), 4000), color: 0x4f46e5, timestamp: new Date().toISOString() };
  if (msg.url) embed.url = msg.url;
  if (msg.fields?.length) embed.fields = msg.fields.slice(0, 10).map((f) => ({ name: clip(escapeMarkdown(f.label), 256), value: clip(escapeMarkdown(f.value) || "-", 1000), inline: true }));
  return { content: "", embeds: [embed], allowed_mentions: { parse: [] } };
}

export function formatWebhook(msg: ChatMessage): Record<string, unknown> {
  return { source: "kernelhub", event: msg.eventType ?? null, title: msg.title, text: msg.text, url: msg.url ?? null, fields: msg.fields ?? [], sent_at: new Date().toISOString() };
}

export function formatForProvider(provider: ChatProviderId, msg: ChatMessage): Record<string, unknown> {
  switch (provider) {
    case "slack":
      return formatSlack(msg);
    case "teams":
      return formatTeams(msg);
    case "discord":
      return formatDiscord(msg);
    case "webhook":
      return formatWebhook(msg);
  }
}

/* ---------- event -> message ---------- */

const PATHS: Record<string, string> = {
  booking: "/calendar", invoice: "/invoices", quote: "/quotes", ticket: "/helpdesk", order: "/orders", crm: "/crm", lead: "/leads",
  task: "/tasks", project: "/projects", record: "/r", product: "/inventory", document: "/documents", message: "/messaging", automation: "/automations",
  campaign: "/marketing", sequence: "/marketing", snapshot: "/settings/snapshots", calsync: "/settings/calendar-sync", chat: "/settings/chat-apps",
};

export interface EventLike {
  type: string;
  entity: string;
  entity_id: string;
  data: Record<string, unknown>;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : typeof v === "number" ? String(v) : null;
}

function humanize(type: string): string {
  const t = type.replace(/[._]/g, " ").trim();
  return t.charAt(0).toUpperCase() + t.slice(1);
}

/** Short human message for an event. Uses only the event payload (no extra queries). */
export function describeEvent(evt: EventLike, appOrigin: string): ChatMessage {
  const d = evt.data ?? {};
  const who = str(d.name) ?? str(d.title) ?? str(d.subject) ?? str(d.number);
  const fields: Array<{ label: string; value: string }> = [];
  const when = str(d.startsAt) ?? str(d.to);
  if (when) fields.push({ label: "When", value: when });
  const total = typeof d.total_minor === "number" ? d.total_minor : null;
  if (total !== null) fields.push({ label: "Total", value: `${(total / 100).toFixed(2)} ${str(d.currency) ?? ""}`.trim() });
  const email = str(d.email) ?? str(d.to_email) ?? str(d.requester_email);
  if (email && !str(d.name)) fields.push({ label: "Contact", value: email });
  const err = str(d.error);
  if (err) fields.push({ label: "Error", value: err });
  const prefix = evt.type.split(".")[0];
  const path = PATHS[prefix] ?? PATHS[evt.entity] ?? null;
  return {
    title: humanize(evt.type) + (who ? `: ${who}` : ""),
    text: str(d.reason) ?? "",
    url: path ? `${appOrigin.replace(/\/$/, "")}${path}` : null,
    fields,
    eventType: evt.type,
  };
}
