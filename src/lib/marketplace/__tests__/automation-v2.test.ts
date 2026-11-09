import { describe, expect, it } from "vitest";
import { AutomationDefinitionSchema, isV2AutomationDefinition, NOTIFY_TO_PLACEHOLDER, parseDefinition, scrubAutomationV2, WEBHOOK_URL_PLACEHOLDER } from "@/lib/marketplace/types";
import { legacyToV2 } from "@/lib/automations/legacy";
import type { AutomationDefinition } from "@/lib/automations/types";

const engineDef: AutomationDefinition = {
  name: "Ticket escalation",
  description: "Escalate hot tickets",
  trigger_type: "webhook",
  trigger_config: { event_type: "ticket.created", filter: { priority: "high" }, webhook: { token: "inbound-secret-token-xyz" } },
  conditions: { all: [{ field: "event.data.priority", op: "eq", value: "high" }] },
  autonomy: "auto",
  enabled: true,
  steps: [
    { id: "t1", kind: "tool", config: { tool: "tasks.create", input: { title: "Follow up {{entity.title}}", assignee_id: "6b2c8a7e-1b1c-4c1a-9b7a-9d7e0b2c4f10", note: "ok" } } },
    { id: "a1", kind: "agent", config: { agent_id: "agent-123", prompt: "Summarise the ticket" } },
    { id: "n1", kind: "notify", config: { channel: "email", to: "ceo@example.com", subject: "Hot ticket", body: "See {{entity.title}}" } },
    { id: "n2", kind: "notify", config: { channel: "in_app", to: "{{org.id}}", body: "Escalated" } },
    { id: "w1", kind: "webhook", config: { url: "https://hooks.slack.com/services/T000/B000/XXXX", secret: "signing-secret", payload: { text: "{{event.type}}", channel: "#ops" } } },
    { id: "ap", kind: "approval", config: { title: "Approve refund" } },
  ],
};

describe("v2 automation listings", () => {
  it("exports the v2 definition scrubbed of ids, secrets, recipients and webhook URLs via the allow-list", () => {
    const { definition, removed } = scrubAutomationV2(engineDef);
    expect(definition.schema).toBe(2);
    expect(definition.trigger_type).toBe("webhook");
    expect(definition.trigger_config).toEqual({ event_type: "ticket.created", filter: { priority: "high" } });
    expect(JSON.stringify(definition)).not.toContain("inbound-secret-token-xyz");
    expect(JSON.stringify(definition)).not.toContain("hooks.slack.com");
    expect(JSON.stringify(definition)).not.toContain("signing-secret");
    expect(JSON.stringify(definition)).not.toContain("ceo@example.com");
    expect(JSON.stringify(definition)).not.toContain("agent-123");
    expect(JSON.stringify(definition)).not.toContain("6b2c8a7e");
    const tool = definition.steps[0];
    expect(tool.kind === "tool" && tool.config.input).toEqual({ title: "Follow up {{entity.title}}", note: "ok" });
    const agent = definition.steps[1];
    expect(agent.kind === "agent" && agent.config).toEqual({ agent_id: "", prompt: "Summarise the ticket" });
    const notify = definition.steps[2];
    expect(notify.kind === "notify" && notify.config).toEqual({ channel: "email", to: NOTIFY_TO_PLACEHOLDER, body: "See {{entity.title}}", subject: "Hot ticket" });
    const templated = definition.steps[3];
    expect(templated.kind === "notify" && templated.config.to).toBe("{{org.id}}");
    const hook = definition.steps[4];
    expect(hook.kind === "webhook" && hook.config).toEqual({ url: WEBHOOK_URL_PLACEHOLDER, payload: { text: "{{event.type}}", channel: "#ops" } });
    expect(removed.sort()).toEqual(["steps.a1.agent_id", "steps.n1.to", "steps.t1.input.assignee_id", "steps.w1.secret", "steps.w1.url", "trigger_config.webhook"].sort());
    // Round-trips through the listing schema.
    const parsed = parseDefinition("automation", definition);
    expect(parsed.kind === "automation" && isV2AutomationDefinition(parsed.definition)).toBe(true);
  });

  it("still accepts legacy listings and converts them with legacyToV2 for install", () => {
    const legacy = { name: "Daily digest", trigger_event: "Scheduled (Daily)", action_type: "Send Notification", kanban_label: null, action_config: { message: "Morning!" }, schedule_time: "09:00", schedule_timezone: "UTC", schedule_days: "daily" };
    const parsed = AutomationDefinitionSchema.parse(legacy);
    expect(isV2AutomationDefinition(parsed)).toBe(false);
    const v2 = legacyToV2({ id: "", status: "paused", ...legacy, action_config: JSON.stringify(legacy.action_config) });
    expect(v2.trigger_type).toBe("schedule");
    expect(v2.steps[0].kind).toBe("notify");
    expect(() => AutomationDefinitionSchema.parse({ schema: 2, name: "x", trigger_type: "event", steps: "nope" })).toThrow();
  });
});
