import { describe, expect, it } from "vitest";
import { parseSnapshot, sectionsPresent } from "../schema";
import { MAX_ITEMS_PER_SECTION, MAX_SNAPSHOT_BYTES } from "../types";

const base = (sections: Record<string, unknown>) => ({ schema: 1, name: "Starter", sections });

describe("snapshot schema", () => {
  it("accepts a minimal valid snapshot and lists its sections", () => {
    const r = parseSnapshot(base({ tax_rates: [{ name: "VAT", rate_bp: 2000 }], branding: { brand_name: "Acme", primary_color: "#112233" } }));
    expect(r.ok).toBe(true);
    if (r.ok) expect(sectionsPresent(r.snapshot)).toEqual(["branding", "tax_rates"]);
  });

  it("rejects wrong schema versions and unknown sections/keys (strict)", () => {
    expect(parseSnapshot({ schema: 2, name: "x", sections: {} }).ok).toBe(false);
    expect(parseSnapshot(base({ contacts: [{ name: "Jane" }] })).ok).toBe(false);
    expect(parseSnapshot(base({ tax_rates: [{ name: "VAT", rate_bp: 1, extra: true }] })).ok).toBe(false);
  });

  it("caps items per section", () => {
    const items = Array.from({ length: MAX_ITEMS_PER_SECTION + 1 }, (_, i) => ({ name: `T${i}`, rate_bp: 1 }));
    expect(parseSnapshot(base({ tax_rates: items })).ok).toBe(false);
    expect(parseSnapshot(base({ tax_rates: items.slice(0, MAX_ITEMS_PER_SECTION) })).ok).toBe(true);
  });

  it("caps total size at 5 MB", () => {
    const big = JSON.stringify(base({ kb_articles: [{ slug: "a", title: "A", body_md: "x".repeat(MAX_SNAPSHOT_BYTES) }] }));
    const r = parseSnapshot(big);
    expect(r.ok).toBe(false);
  });

  it("only accepts https logo URLs", () => {
    expect(parseSnapshot(base({ branding: { logo_url: "http://x.test/l.png" } })).ok).toBe(false);
    expect(parseSnapshot(base({ branding: { logo_url: "javascript:alert(1)" } })).ok).toBe(false);
    expect(parseSnapshot(base({ branding: { logo_url: "https://cdn.test/l.png" } })).ok).toBe(true);
  });

  it("rejects invalid JSON and credential-like keys or values", () => {
    expect(parseSnapshot("{nope").ok).toBe(false);
    const withKey = parseSnapshot(base({ automations: [{ schema: 2, name: "A", trigger_type: "manual", trigger_config: { webhook_secret: "x" }, steps: [], autonomy: "approve" }] }));
    expect(withKey.ok).toBe(false);
    const withValue = parseSnapshot(base({ email_templates: [{ name: "T", body_md: "key sk_live_abcdefgh12345678" }] }));
    expect(withValue.ok).toBe(false);
    if (!withKey.ok) expect(withKey.errors[0]).toMatch(/credential/);
  });
});
