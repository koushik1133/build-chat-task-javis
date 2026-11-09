import { describe, expect, it } from "vitest";
import { findSecretPaths, SECRET_KEY_RE } from "../types";
import { canonicalJson, SECTION_IMPLS, sha256, stripSecretKeys } from "../sections";
import { scrubAutomationV2 } from "@/lib/marketplace/types";
import type { AutomationDefinition } from "@/lib/automations/types";

const SECRET_KEYS = ["api_key", "apiKey", "access_token", "refresh_token", "client_secret", "password", "webhook_url", "webhook_secret", "Authorization", "bearer", "private_key", "token_hash", "key_hash", "otp_hash", "smtp_password_enc", "credentials"];

function rand(seed: number) {
  let s = seed;
  return () => ((s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296);
}

describe("secret denylist (fuzz)", () => {
  it("flags every secret-pattern key at any depth", () => {
    const r = rand(7);
    for (let n = 0; n < 200; n++) {
      const key = SECRET_KEYS[Math.floor(r() * SECRET_KEYS.length)];
      let v: unknown = { [key]: "value" };
      const depth = Math.floor(r() * 5);
      for (let d = 0; d < depth; d++) v = r() < 0.5 ? { wrap: v, name: "x" } : [{ ok: 1 }, v];
      expect(findSecretPaths(v).length).toBeGreaterThan(0);
      expect(findSecretPaths(stripSecretKeys(v))).toEqual([]);
    }
  });

  it("flags credential-shaped values under innocent keys", () => {
    for (const val of ["sk_live_abcdefgh12345678", "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdEFGH", "-----BEGIN RSA PRIVATE KEY-----", "xoxb-1234567890-abcdef", "AKIAABCDEFGHIJKLMNOP", "https://hooks.slack.com/services/T0/B0/xyz"]) {
      expect(findSecretPaths({ note: val }).length).toBe(1);
    }
    expect(findSecretPaths({ note: "just a sentence about tokens and keys" })).toEqual([]);
  });

  it("does not flag ordinary config keys", () => {
    for (const k of ["name", "slug", "fields", "rate_bp", "body_md", "report_name", "playbook_id", "keep_days", "tools", "model"]) expect(SECRET_KEY_RE.test(k)).toBe(false);
  });

  it("a scrubbed automation carries no secrets, ids, recipients or webhook URLs", () => {
    const def = {
      name: "Notify", description: null, trigger_type: "event", trigger_config: { event_type: "crm.contact.created", webhook: { secret: "whsec_abcdefghijklmnopqrstuvwxyz123456" } },
      conditions: null, autonomy: "auto", enabled: true,
      steps: [
        { id: "s1", kind: "webhook", config: { url: "https://hooks.slack.com/services/T0/B0/abc", secret: "topsecretvalue" } },
        { id: "s2", kind: "notify", config: { channel: "email", to: "boss@example.com", body: "Hi {{contact.name}}" } },
        { id: "s3", kind: "agent", config: { agent_id: "11111111-1111-1111-1111-111111111111", prompt: "do it" } },
      ],
    } as unknown as AutomationDefinition;
    const { definition } = scrubAutomationV2(def);
    const out = stripSecretKeys(definition);
    expect(findSecretPaths(out)).toEqual([]);
    const text = JSON.stringify(out);
    expect(text).not.toContain("boss@example.com");
    expect(text).not.toContain("hooks.slack.com");
    expect(text).not.toContain("11111111-1111");
  });
});

describe("natural keys and hashing", () => {
  it("maps each section to a stable natural key", () => {
    expect(SECTION_IMPLS.record_types.keyOf({ slug: "deal" })).toBe("deal");
    expect(SECTION_IMPLS.tax_rates.keyOf({ name: "VAT" })).toBe("VAT");
    expect(SECTION_IMPLS.kb_articles.keyOf({ slug: "faq" })).toBe("faq");
    expect(SECTION_IMPLS.playbook_settings.keyOf({ playbook_id: "stale-lead" })).toBe("stale-lead");
    expect(SECTION_IMPLS.retention_policies.keyOf({ entity_kind: "outbox" })).toBe("outbox");
    expect(SECTION_IMPLS.privacy_notices.keyOf({ locale: "en" })).toBe("en");
    expect(SECTION_IMPLS.settings.keyOf({})).toBe("singleton");
  });

  it("canonical JSON is key-order independent; sha256 is hex", () => {
    expect(canonicalJson({ b: 1, a: [{ d: 1, c: 2 }] })).toBe(canonicalJson({ a: [{ c: 2, d: 1 }], b: 1 }));
    expect(sha256("x")).toMatch(/^[0-9a-f]{64}$/);
  });
});
