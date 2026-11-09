import { describe, expect, it } from "vitest";
import { AutomationDefinitionSchema } from "@/lib/automations/schema";
import { AUTOMATION_TEMPLATES } from "@/lib/automations/templates";
import { EVENT_TYPES } from "@/lib/events/bus";

describe("automation templates", () => {
  it("ships at least 12 templates with unique keys", () => {
    expect(AUTOMATION_TEMPLATES.length).toBeGreaterThanOrEqual(12);
    expect(new Set(AUTOMATION_TEMPLATES.map((t) => t.key)).size).toBe(AUTOMATION_TEMPLATES.length);
  });
  it("every template validates against the v2 schema and installs paused", () => {
    for (const t of AUTOMATION_TEMPLATES) {
      const r = AutomationDefinitionSchema.safeParse(t.definition);
      expect(r.success, `${t.key}: ${r.success ? "" : JSON.stringify(r.error.issues)}`).toBe(true);
      expect(t.definition.enabled).toBe(false);
    }
  });
  it("event triggers point at known event types", () => {
    const known = new Set<string>(EVENT_TYPES);
    for (const t of AUTOMATION_TEMPLATES) {
      if (t.definition.trigger_type !== "event") continue;
      expect(known.has(t.definition.trigger_config.event_type ?? ""), `${t.key} → ${t.definition.trigger_config.event_type}`).toBe(true);
    }
  });
});
