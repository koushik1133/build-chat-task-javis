import { describe, expect, it } from "vitest";
import { REDACTED_SECRET, restoreRedactedSecrets } from "@/lib/automations/secrets";
import type { AutomationDefinition } from "@/lib/automations/types";

const current: Pick<AutomationDefinition, "trigger_config" | "steps"> = {
  trigger_config: { webhook: { token: "real-inbound-token-123" } },
  steps: [
    { id: "hook", kind: "webhook", config: { url: "https://example.com/h", secret: "real-signing-secret" } },
    { id: "note", kind: "notify", config: { channel: "in_app", to: "{{org.id}}", body: "hi" } },
  ],
};

describe("redacted placeholder on PATCH", () => {
  it("keeps the stored webhook token and step secret when the body carries the placeholder", () => {
    const out = restoreRedactedSecrets(
      {
        trigger_config: { webhook: { token: REDACTED_SECRET } },
        steps: [{ id: "hook", kind: "webhook", config: { url: "https://example.com/h2", secret: REDACTED_SECRET } }],
      },
      current
    );
    expect(out.trigger_config?.webhook?.token).toBe("real-inbound-token-123");
    const hook = out.steps?.[0];
    expect(hook?.kind === "webhook" && hook.config.secret).toBe("real-signing-secret");
    expect(hook?.kind === "webhook" && hook.config.url).toBe("https://example.com/h2");
  });

  it("lets a real new value through and drops the placeholder when nothing was stored", () => {
    const out = restoreRedactedSecrets(
      { trigger_config: { webhook: { token: "brand-new-token-456" } }, steps: [{ id: "new", kind: "webhook", config: { url: "https://example.com/n", secret: REDACTED_SECRET } }] },
      current
    );
    expect(out.trigger_config?.webhook?.token).toBe("brand-new-token-456");
    const step = out.steps?.[0];
    expect(step?.kind === "webhook" ? step.config.secret : "x").toBeUndefined();
    const none = restoreRedactedSecrets({ trigger_config: { event_type: "x", webhook: { token: REDACTED_SECRET } } }, { trigger_config: {}, steps: [] });
    expect(none.trigger_config?.webhook).toBeUndefined();
    expect(none.trigger_config?.event_type).toBe("x");
  });
});
