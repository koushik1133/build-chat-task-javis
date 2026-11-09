import { describe, expect, it } from "vitest";
import { convertLegacyTemplate, legacyToV2, type LegacyRow } from "@/lib/automations/legacy";
import { AutomationDefinitionSchema } from "@/lib/automations/schema";

const base: LegacyRow = { id: "a1", name: "Nudge", trigger_event: "Kanban Card Moved", action_type: "Send Notification", kanban_label: "Review", action_config: JSON.stringify({ message: "Card {{task_title}} moved {{from_column}} → {{to_column}}" }), schedule_time: null, schedule_timezone: null, schedule_days: null, status: "active" };

describe("legacyToV2", () => {
  it("converts a kanban automation into an event trigger with a label condition and a notify step", () => {
    const def = legacyToV2(base);
    expect(def.trigger_type).toBe("event");
    expect(def.trigger_config.event_type).toBe("production.card.moved");
    expect(def.conditions).toEqual({ any: [{ field: "event.data.label", op: "eq", value: "Review" }, { field: "entity.label", op: "eq", value: "Review" }] });
    expect(def.steps[0].kind).toBe("notify");
    expect(def.enabled).toBe(true);
    expect(AutomationDefinitionSchema.safeParse(def).success).toBe(true);
  });
  it("converts a scheduled 'Create Task' automation", () => {
    const def = legacyToV2({ ...base, trigger_event: "Scheduled (Daily)", action_type: "Create Task", kanban_label: null, schedule_time: "08:30", schedule_timezone: "Asia/Kolkata", schedule_days: "weekdays", status: "paused", action_config: "{}" });
    expect(def.trigger_type).toBe("schedule");
    expect(def.trigger_config.schedule).toEqual({ time: "08:30", timezone: "Asia/Kolkata", days: "weekdays" });
    expect(def.conditions).toBeNull();
    expect(def.steps[0]).toMatchObject({ kind: "tool", config: { tool: "tasks.create" } });
    expect(def.enabled).toBe(false);
    expect(AutomationDefinitionSchema.safeParse(def).success).toBe(true);
  });
  it("maps email / webhook / slack / agent actions", () => {
    expect(legacyToV2({ ...base, action_type: "Send Email", action_config: JSON.stringify({ to: "a@b.co", subject: "S {{workflow}}" }) }).steps[0]).toMatchObject({ kind: "notify", config: { channel: "email", to: "a@b.co", subject: "S Nudge" } });
    expect(legacyToV2({ ...base, action_type: "Trigger Webhook", action_config: JSON.stringify({ url: "https://x.test/h" }) }).steps[0]).toMatchObject({ kind: "webhook", config: { url: "https://x.test/h" } });
    expect(legacyToV2({ ...base, action_type: "Send Slack Message", action_config: JSON.stringify({ webhook_url: "https://hooks.slack.com/x" }) }).steps[0]).toMatchObject({ kind: "webhook", config: { url: "https://hooks.slack.com/x", payload: { text: expect.any(String) } } });
    expect(legacyToV2({ ...base, action_type: "Run Agent (queued)", action_config: JSON.stringify({ agent_id: "ag1", prompt: "Go" }) }).steps[0]).toMatchObject({ kind: "agent", config: { agent_id: "ag1", prompt: "Go" } });
  });
  it("tolerates broken config JSON", () => {
    expect(() => legacyToV2({ ...base, action_config: "{not json" })).not.toThrow();
  });
});

describe("convertLegacyTemplate", () => {
  it("rewrites legacy placeholders to v2 paths", () => {
    const out = convertLegacyTemplate("{{task_title}} {{from_column}} {{to_column}} {{label}} {{workflow}} {{date}}", "WF");
    expect(out).toContain("{{entity.title ?? event.data.task_title");
    expect(out).toContain("{{event.data.from");
    expect(out).toContain("WF");
    expect(out).toContain("{{now | date}}");
    expect(convertLegacyTemplate(undefined, "x")).toBe("");
  });
});
