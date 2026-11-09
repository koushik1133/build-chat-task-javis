import { describe, expect, it } from "vitest";
import { describeEvent, escapeMarkdown, escapeSlack, formatDiscord, formatForProvider, formatSlack, formatTeams, formatWebhook } from "../format";
import { chatUrlRefusal, maskWebhookUrl } from "../providers";
import { integrationMatches } from "../subscriptions";

const msg = { title: "Booking <b>: A & B", text: "Hello *world* _x_ @everyone", url: "https://app.example.com/calendar", fields: [{ label: "When", value: "Tue" }], eventType: "booking.created" };

describe("formatters", () => {
  it("escapes slack control characters and defuses formatting", () => {
    const s = escapeSlack("<!channel> a & b *bold*");
    expect(s).toContain("&lt;!channel&gt;");
    expect(s).toContain("&amp;");
    expect(s).not.toContain("*bold*");
    expect(s).toContain("*​");
  });
  it("builds slack block kit", () => {
    const out = formatSlack(msg);
    expect(out.text).toContain("&lt;b&gt;");
    expect(out.blocks[0]).toMatchObject({ type: "header" });
    expect(out.blocks.some((b) => b.type === "section")).toBe(true);
    expect(JSON.stringify(out.blocks)).toContain("Open in KernelHub");
  });
  it("builds a teams adaptive card", () => {
    const out = formatTeams(msg) as { type: string; attachments: Array<{ contentType: string; content: { type: string; body: unknown[]; actions?: unknown[] } }> };
    expect(out.type).toBe("message");
    expect(out.attachments[0].contentType).toBe("application/vnd.microsoft.card.adaptive");
    expect(out.attachments[0].content.type).toBe("AdaptiveCard");
    expect(out.attachments[0].content.actions).toHaveLength(1);
  });
  it("builds a discord embed with mentions disabled", () => {
    const out = formatDiscord(msg) as { embeds: Array<{ description: string; url: string }>; allowed_mentions: { parse: string[] } };
    expect(out.allowed_mentions.parse).toEqual([]);
    expect(out.embeds[0].description).toContain("\\*world\\*");
    expect(out.embeds[0].description).not.toContain("@everyone");
    expect(out.embeds[0].url).toBe(msg.url);
  });
  it("builds a generic webhook body", () => {
    expect(formatWebhook(msg)).toMatchObject({ source: "kernelhub", event: "booking.created", title: msg.title });
    expect(formatForProvider("webhook", msg)).toMatchObject({ source: "kernelhub" });
    expect(escapeMarkdown("a_b*c")).toBe("a\\_b\\*c");
  });
  it("describes events from their payload", () => {
    const m = describeEvent({ type: "booking.created", entity: "booking", entity_id: "b1", data: { name: "Ada", startsAt: "2026-11-10T15:00:00Z" } }, "https://app.example.com/");
    expect(m.title).toBe("Booking created: Ada");
    expect(m.url).toBe("https://app.example.com/calendar");
    expect(m.fields?.[0]).toEqual({ label: "When", value: "2026-11-10T15:00:00Z" });
  });
});

describe("webhook host allow-lists", () => {
  it("accepts only the provider hosts", () => {
    expect(chatUrlRefusal("slack", "https://hooks.slack.com/services/T/B/x")).toBeNull();
    expect(chatUrlRefusal("slack", "https://evil.example.com/services/T/B/x")).not.toBeNull();
    expect(chatUrlRefusal("slack", "https://hooks.slack.com.evil.com/services/x")).not.toBeNull();
    expect(chatUrlRefusal("teams", "https://acme.webhook.office.com/webhookb2/abc")).toBeNull();
    expect(chatUrlRefusal("teams", "https://prod-12.westus.logic.azure.com/workflows/abc")).toBeNull();
    expect(chatUrlRefusal("teams", "https://outlook.office.com/webhook/abc")).toBeNull();
    expect(chatUrlRefusal("teams", "https://hooks.slack.com/services/x")).not.toBeNull();
    expect(chatUrlRefusal("discord", "https://discord.com/api/webhooks/1/abc")).toBeNull();
    expect(chatUrlRefusal("discord", "https://discord.com/other")).not.toBeNull();
  });
  it("lets the generic provider use any public https URL but not private ones", () => {
    expect(chatUrlRefusal("webhook", "https://hooks.example.com/in")).toBeNull();
    expect(chatUrlRefusal("webhook", "http://hooks.example.com/in")).not.toBeNull();
    expect(chatUrlRefusal("webhook", "https://169.254.169.254/latest")).not.toBeNull();
    expect(chatUrlRefusal("webhook", "http://localhost:9/x", {})).not.toBeNull();
    expect(chatUrlRefusal("webhook", "http://localhost:9/x", { WEBHOOKS_ALLOW_INSECURE: "1" })).toBeNull();
  });
  it("masks URLs", () => {
    const m = maskWebhookUrl("https://hooks.slack.com/services/T000/B000/SECRETSECRET");
    expect(m).not.toContain("T000");
    expect(m).toContain("hooks.slack.com");
  });
});

describe("event matching", () => {
  it("matches patterns", () => {
    expect(integrationMatches(["booking.*"], "booking.created")).toBe(true);
    expect(integrationMatches(["invoice.paid"], "booking.created")).toBe(false);
    expect(integrationMatches(["*"], "anything")).toBe(true);
    expect(integrationMatches([], "booking.created")).toBe(false);
  });
});

describe("sec9 chatops hardening", () => {
  it("refuses host-suffix and userinfo tricks", async () => {
    const { chatUrlRefusal } = await import("../providers");
    expect(chatUrlRefusal("slack", "https://hooks.slack.com.evil.com/services/T/B/x")).not.toBeNull();
    expect(chatUrlRefusal("slack", "https://hooks.slack.com@evil.com/services/T/B/x")).not.toBeNull();
    expect(chatUrlRefusal("slack", "https://evil.com/hooks.slack.com/services/x")).not.toBeNull();
    expect(chatUrlRefusal("discord", "https://discord.com.evil.com/api/webhooks/1/x")).not.toBeNull();
    expect(chatUrlRefusal("slack", "https://hooks.slack.com/services/T/B/x")).toBeNull();
  });
  it("does not honour plaintext stored urls in production", async () => {
    const { openUrl } = await import("../subscriptions");
    const prev = process.env.NODE_ENV;
    (process.env as Record<string, string>).NODE_ENV = "production";
    try {
      expect(openUrl("plain:https://hooks.slack.com/services/a")).toBeNull();
    } finally {
      (process.env as Record<string, string>).NODE_ENV = prev ?? "test";
    }
  });
});
