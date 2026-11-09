import type { AutomationDefinition, TriggerConfig } from "./types";

/**
 * Secret redaction for automation DTOs (client-safe: no DB).
 *
 * Viewers see `REDACTED_SECRET` in place of the inbound webhook token and
 * outbound webhook signing secrets. The editor round-trips that DTO, so a
 * PATCH carrying the placeholder means "unchanged" and the stored value is kept.
 */
export const REDACTED_SECRET = "••••••••";

export function restoreRedactedSecrets<T extends { trigger_config?: TriggerConfig; steps?: AutomationDefinition["steps"] }>(
  patch: T,
  current: Pick<AutomationDefinition, "trigger_config" | "steps">
): T {
  const out: T = { ...patch };
  if (out.trigger_config?.webhook && out.trigger_config.webhook.token === REDACTED_SECRET) {
    const kept = current.trigger_config.webhook?.token;
    const { webhook: _w, ...rest } = out.trigger_config;
    void _w;
    out.trigger_config = kept ? { ...rest, webhook: { token: kept } } : rest;
  }
  if (out.steps) {
    out.steps = out.steps.map((s) => {
      if (s.kind !== "webhook" || s.config.secret !== REDACTED_SECRET) return s;
      const prev = current.steps.find((c) => c.id === s.id && c.kind === "webhook");
      const kept = prev && prev.kind === "webhook" ? prev.config.secret : undefined;
      const { secret: _s, ...config } = s.config;
      void _s;
      return { ...s, config: kept ? { ...config, secret: kept } : config };
    });
  }
  return out;
}
