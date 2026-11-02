import { describe, expect, it } from "vitest";
import { DEFAULT_BRANDING, isPlainEmail, isSafeAssetUrl, renderBrandedEmail, type Branding } from "@/lib/branding";

function branding(over: Partial<Branding>): Branding {
  return { ...DEFAULT_BRANDING, configured: true, ...over };
}

describe("isSafeAssetUrl", () => {
  it("accepts absolute http(s) URLs only", () => {
    expect(isSafeAssetUrl("https://cdn.example.com/logo.png")).toBe(true);
    expect(isSafeAssetUrl("http://cdn.example.com/logo.png")).toBe(true);
    expect(isSafeAssetUrl("javascript:alert(1)")).toBe(false);
    expect(isSafeAssetUrl("data:image/svg+xml;base64,PHN2Zz4=")).toBe(false);
    expect(isSafeAssetUrl("file:///etc/passwd")).toBe(false);
    expect(isSafeAssetUrl("//cdn.example.com/x.png")).toBe(false);
    expect(isSafeAssetUrl("https://user:pw@cdn.example.com/x.png")).toBe(false);
    expect(isSafeAssetUrl("")).toBe(false);
    expect(isSafeAssetUrl(`https://a.b/${"x".repeat(2000)}`)).toBe(false);
  });
});

describe("isPlainEmail", () => {
  it("rejects header-injection characters", () => {
    expect(isPlainEmail("help@example.com")).toBe(true);
    expect(isPlainEmail("help@example.com?subject=x")).toBe(false);
    expect(isPlainEmail('x"onclick=1@example.com')).toBe(false);
    expect(isPlainEmail("not an email")).toBe(false);
  });
});

describe("renderBrandedEmail", () => {
  it("HTML-escapes brand_name, email_footer and support_email", () => {
    const html = renderBrandedEmail(
      branding({
        brand_name: `<script>alert("x")</script>Acme`,
        email_footer: `Footer <img src=x onerror=alert(1)> & co`,
        support_email: "help@example.com",
      }),
      "<p>Hi</p>"
    );
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;Acme");
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("Footer &lt;img src=x onerror=alert(1)&gt; &amp; co");
    expect(html).toContain('href="mailto:help@example.com"');
  });

  it("never emits a logo with a non-http(s) scheme", () => {
    const js = renderBrandedEmail(branding({ logo_url: "javascript:alert(1)" }), "<p>Hi</p>");
    expect(js).not.toContain("<img");
    expect(js).not.toContain("javascript:");
    const ok = renderBrandedEmail(branding({ logo_url: 'https://cdn.example.com/l.png"><script>' }), "<p>Hi</p>");
    expect(ok).toContain('<img src="https://cdn.example.com/l.png&quot;&gt;&lt;script&gt;"');
    expect(ok).not.toContain("<script>");
  });

  it("drops a support address that is not a plain mailbox", () => {
    const html = renderBrandedEmail(branding({ support_email: "help@example.com?cc=victim@x.y" }), "<p>Hi</p>");
    expect(html).not.toContain("mailto:");
  });

  it("escapes a plain-text body and passes an HTML body through", () => {
    expect(renderBrandedEmail(branding({}), "1 < 2 & 3")).toContain("<pre");
    expect(renderBrandedEmail(branding({}), "1 < 2 & 3")).toContain("1 &lt; 2 &amp; 3");
    expect(renderBrandedEmail(branding({}), "<p>ok</p>")).toContain("<p>ok</p>");
  });

  it("only uses validated hex colours in inline styles", () => {
    const html = renderBrandedEmail(branding({ primary_color: "red;background:url(javascript:1)" }), "<p>Hi</p>");
    expect(html).not.toContain("javascript");
    expect(html).toContain(`background:${DEFAULT_BRANDING.primary_color}`);
  });
});
