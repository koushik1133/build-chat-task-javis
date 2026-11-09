import { describe, expect, it } from "vitest";
import { REDACTED_SECRET, redactAutomationSecrets } from "@/lib/automations/store";
import type { AutomationDTO } from "@/lib/automations/types";

const base: AutomationDTO = {
  id: "a1",
  name: "Hook",
  description: null,
  trigger_type: "webhook",
  trigger_config: { webhook: { token: "super-secret-token" } },
  conditions: null,
  steps: [
    { id: "s1", kind: "webhook", config: { url: "https://example.com/hook", secret: "signing-secret", payload: { a: 1 } } },
    { id: "s2", kind: "notify", config: { channel: "email", to: "{{entity.email}}", body: "hi" } },
  ],
  autonomy: "approve",
  enabled: true,
  legacy: false,
  version: 1,
  template_key: null,
  run_count: 0,
  error_count: 0,
  last_run_at: null,
  last_error: null,
  created_at: "",
  updated_at: null,
};

describe("redactAutomationSecrets (SEC: viewers must not read credentials)", () => {
  it("masks the inbound webhook token and outbound signing secrets, keeps everything else", () => {
    const out = redactAutomationSecrets(base);
    expect(out.trigger_config.webhook?.token).toBe(REDACTED_SECRET);
    const hook = out.steps[0];
    expect(hook.kind === "webhook" && hook.config.secret).toBe(REDACTED_SECRET);
    expect(hook.kind === "webhook" && hook.config.url).toBe("https://example.com/hook");
    expect(out.steps[1]).toEqual(base.steps[1]);
    expect(JSON.stringify(out)).not.toContain("super-secret-token");
    expect(JSON.stringify(out)).not.toContain("signing-secret");
  });

  it("does not mutate the input and leaves automations without secrets untouched", () => {
    redactAutomationSecrets(base);
    expect(base.trigger_config.webhook?.token).toBe("super-secret-token");
    const plain: AutomationDTO = { ...base, trigger_type: "manual", trigger_config: {}, steps: [base.steps[1]] };
    expect(redactAutomationSecrets(plain)).toEqual(plain);
  });
});
