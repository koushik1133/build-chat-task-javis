import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildAudienceWhere } from "../audiences";
import { ensureSmsOptOut, ensureUnsubscribe, extractLinks, markdownToHtml, mergeKeys, renderEmail, renderMerge, renderSms, rewriteLinks } from "../render";
import { clickTargetAllowed, clickToken, openToken, unsubscribeContactToken, unsubscribeToken, urlHash, verifyToken } from "../tracking";
import { AudienceDefinitionSchema, computeCampaignStats, describeAudience, parseAudienceDefinition, parseSteps, type AudienceDefinition } from "../types";

/* ---------- audience SQL builder ---------- */

const DANGEROUS = ["'; DROP TABLE crm_contacts; --", "\" OR 1=1 --", "$1", "%_%", "\\", "c.user_id", "NULL", "${x}", "' UNION SELECT 1 --", "\u0000"];

describe("buildAudienceWhere", () => {
  it("always scopes by data id and soft-delete", () => {
    const q = buildAudienceWhere("org-1", {});
    expect(q.where).toContain("c.user_id = $1");
    expect(q.where).toContain("c.deleted_at IS NULL");
    expect(q.params).toEqual(["org-1"]);
  });

  it("never interpolates user values into SQL (fuzz)", () => {
    for (const bad of DANGEROUS) {
      const def: AudienceDefinition = { q: bad, tags: [bad.slice(0, 60) || "x"], record_type: bad.slice(0, 80) || "x", stage: bad.slice(0, 80) || "x" };
      const q = buildAudienceWhere("org", def);
      // SQL text is identical whatever the values are: values only ever travel in params.
      const benign = buildAudienceWhere("org", { q: "x", tags: ["x"], record_type: "x", stage: "x" });
      expect(q.where).toBe(benign.where);
      expect(q.where).not.toContain("DROP");
      // every placeholder is numbered and present in params
      const placeholders = [...q.where.matchAll(/\$(\d+)/g)].map((m) => Number(m[1]));
      expect(Math.max(...placeholders)).toBe(q.params.length);
      for (let i = 1; i <= q.params.length; i++) expect(placeholders).toContain(i);
    }
  });

  it("escapes LIKE wildcards and wraps tags as JSON strings", () => {
    const q = buildAudienceWhere("o", { tags: ["50%_off"], q: "a_b%" });
    expect(q.params).toContain('%"50\\%\\_off"%');
    expect(q.params).toContain("%a\\_b\\%%");
  });

  it("rejects unknown filter keys and invalid lifecycles", () => {
    expect(() => buildAudienceWhere("o", { bogus: 1 } as unknown as AudienceDefinition)).toThrow();
    expect(() => buildAudienceWhere("o", { lifecycle: ["admin"] } as unknown as AudienceDefinition)).toThrow();
  });

  it("adds a consent EXISTS clause and record subquery when requested", () => {
    const q = buildAudienceWhere("o", { consent_purpose: "marketing_email", record_type: "deal", stage: "won", last_activity_days: 30, has_email: true, has_phone: true, lifecycle: ["lead", "customer"] });
    expect(q.where).toMatch(/consent_records cr/);
    expect(q.where).toMatch(/records r JOIN record_types rt/);
    expect(q.params).toEqual(["o", ["lead", "customer"], "30", "marketing_email", "deal", "won"]);
  });

  it("parses definitions defensively", () => {
    expect(parseAudienceDefinition(null)).toEqual({});
    expect(parseAudienceDefinition("not json")).toEqual({});
    expect(parseAudienceDefinition(JSON.stringify({ lifecycle: ["lead"], evil: true }))).toEqual({});
    expect(describeAudience({})).toBe("All contacts");
    expect(describeAudience({ lifecycle: ["lead"], tags: ["vip"] })).toContain("lifecycle: lead");
    expect(AudienceDefinitionSchema.safeParse({ last_activity_days: 0 }).success).toBe(false);
  });
});

/* ---------- rendering ---------- */

describe("merge rendering", () => {
  const vars = { first_name: "Ana <b>", company: "A&B", unsubscribe_url: "https://x.test/u/t" };

  it("replaces fields, leaves unknown ones empty and escapes when asked", () => {
    expect(renderMerge("Hi {{first_name}} from {{ company }} {{nope}}!", vars)).toBe("Hi Ana <b> from A&B !");
    expect(renderMerge("{{first_name}}", vars, { escape: true })).toBe("Ana &lt;b&gt;");
    expect(mergeKeys("{{a}} {{b}} {{a}}")).toEqual(["a", "b"]);
  });

  it("injects the unsubscribe link exactly once", () => {
    const once = ensureUnsubscribe("Hello");
    expect(once).toContain("{{unsubscribe_url}}");
    expect(ensureUnsubscribe(once)).toBe(once);
    expect(ensureUnsubscribe("Bye [x]({{ unsubscribe_url }})")).toBe("Bye [x]({{ unsubscribe_url }})");
    expect(ensureSmsOptOut("Sale!")).toMatch(/Opt out: \{\{unsubscribe_url\}\}/);
  });

  it("markdown renderer escapes raw HTML and only allows safe hrefs", () => {
    const html = markdownToHtml("# Hi <script>alert(1)</script>\n\n- one\n- two\n\n[ok](https://a.test) [bad](javascript:alert(1)) **b** *i*");
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain('<a href="https://a.test"');
    expect(html).not.toContain("javascript:");
    expect(html).toContain("<ul");
    expect(html).toContain("<strong>b</strong>");
  });

  it("renderEmail merges, ensures unsubscribe, adds pixel and preheader", () => {
    const r = renderEmail({ subject: "Hey {{first_name}}", preheader: "pre {{company}}", body_md: "Hello {{first_name}}", vars, pixelUrl: "https://x.test/api/t/o/tok" });
    expect(r.subject).toBe("Hey Ana <b>");
    expect(r.html).toContain('href="https://x.test/u/t"');
    expect(r.html).toContain('<img src="https://x.test/api/t/o/tok"');
    expect(r.html).toContain("pre A&amp;B");
    expect(r.html).toContain("Ana &lt;b&gt;");
    expect(renderSms("Hi {{first_name}}", vars)).toBe("Hi Ana <b>\nOpt out: https://x.test/u/t");
  });

  it("extracts and rewrites http links only", () => {
    const html = '<a href="https://a.test/x?y=1&amp;z=2">a</a> <a href="mailto:x@y">m</a> <a href="https://a.test/x?y=1&amp;z=2">dup</a>';
    expect(extractLinks(html)).toEqual(["https://a.test/x?y=1&z=2"]);
    const out = rewriteLinks(html, (u) => `https://t.test/c?u=${encodeURIComponent(u)}`);
    expect(out).toContain('href="https://t.test/c?u=https%3A%2F%2Fa.test%2Fx%3Fy%3D1%26z%3D2"');
    expect(out).toContain('href="mailto:x@y"');
  });
});

/* ---------- tracking tokens ---------- */

describe("tracking tokens", () => {
  const prev = process.env.CRON_SECRET;
  beforeEach(() => {
    process.env.CRON_SECRET = "unit-test-secret-0123456789";
  });
  afterEach(() => {
    process.env.CRON_SECRET = prev;
  });

  it("round-trips every token kind and carries no PII", () => {
    const o = openToken("rec-1");
    expect(verifyToken(o)).toEqual({ kind: "open", recipientId: "rec-1" });
    expect(Buffer.from(o.split(".")[0], "base64url").toString()).toBe("o|rec-1");
    expect(verifyToken(unsubscribeToken("rec-2"))).toEqual({ kind: "unsub", recipientId: "rec-2" });
    expect(verifyToken(unsubscribeContactToken("org", "c-9"))).toEqual({ kind: "unsub_contact", dataId: "org", contactId: "c-9" });
    const c = verifyToken(clickToken("rec-1", "https://a.test/p"));
    expect(c).toEqual({ kind: "click", recipientId: "rec-1", urlHash: urlHash("https://a.test/p") });
  });

  it("rejects tampering, wrong secret and garbage", () => {
    const o = openToken("rec-1");
    const [p, sig] = o.split(".");
    expect(verifyToken(`${Buffer.from("o|rec-2").toString("base64url")}.${sig}`)).toBeNull();
    expect(verifyToken(`${p}.${sig.slice(0, -2)}xx`)).toBeNull();
    expect(verifyToken("")).toBeNull();
    expect(verifyToken("nodot")).toBeNull();
    expect(verifyToken("a".repeat(700))).toBeNull();
    process.env.CRON_SECRET = "another-secret-for-the-test";
    expect(verifyToken(o)).toBeNull();
  });

  it("click redirect allow-list: only the signed URL passes", () => {
    const payload = verifyToken(clickToken("r", "https://a.test/offer"))!;
    expect(clickTargetAllowed(payload, "https://a.test/offer")).toBe(true);
    expect(clickTargetAllowed(payload, "https://evil.test/")).toBe(false);
    expect(clickTargetAllowed(payload, "javascript:alert(1)")).toBe(false);
    expect(clickTargetAllowed(payload, null)).toBe(false);
    expect(clickTargetAllowed({ kind: "open", recipientId: "r" }, "https://a.test/offer")).toBe(false);
  });
});

/* ---------- stats + sequences ---------- */

describe("campaign stats math", () => {
  it("computes funnel totals and rates", () => {
    const s = computeCampaignStats({ queued: 2, skipped_no_consent: 3, sent: 1, delivered: 10, bounced: 1, unsubscribed: 2, failed: 1 }, 6, 3);
    expect(s.total).toBe(20);
    expect(s.opened).toBe(6);
    expect(s.open_rate).toBe(50); // 6 / (10 delivered + 2 unsubscribed)
    expect(s.click_rate).toBe(25);
    expect(s.bounce_rate).toBe(7.1); // 1 / 14 handed
    expect(s.unsubscribe_rate).toBe(14.3);
  });
  it("handles empty campaigns without NaN", () => {
    const s = computeCampaignStats({}, 0, 0);
    expect(s.total).toBe(0);
    expect(s.open_rate).toBe(0);
  });
  it("parses sequence steps defensively", () => {
    expect(parseSteps(null)).toEqual([]);
    expect(parseSteps("[{\"delay_hours\": -1, \"channel\": \"email\"}]")).toEqual([]);
    expect(parseSteps(JSON.stringify([{ delay_hours: 2, channel: "sms", body_md: "hi" }]))).toHaveLength(1);
  });
});
