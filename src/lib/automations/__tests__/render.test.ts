import { describe, expect, it } from "vitest";
import { referencedPaths, renderValue, resolveTemplate } from "@/lib/automations/render";

const ctx = {
  event: { type: "invoice.paid", data: { total_minor: 12500, currency: "USD", name: "<b>Ada</b> & co", qty: 3, list: [1, 2] } },
  entity: { number: "INV-1", status: null },
  org: { name: "Acme" },
  now: "2026-01-05T12:34:56.000Z",
};

describe("resolveTemplate", () => {
  it("substitutes paths and leaves text intact", () => {
    expect(resolveTemplate("Invoice {{entity.number}} for {{org.name}}", ctx)).toBe("Invoice INV-1 for Acme");
    expect(resolveTemplate("plain", ctx)).toBe("plain");
  });
  it("renders missing paths as empty and supports ?? fallbacks (literal or path)", () => {
    expect(resolveTemplate("[{{entity.missing}}]", ctx)).toBe("[]");
    expect(resolveTemplate('{{entity.missing ?? "there"}}', ctx)).toBe("there");
    expect(resolveTemplate("{{entity.status ?? org.name}}", ctx)).toBe("Acme");
    expect(resolveTemplate("{{entity.missing ?? 42}}", ctx)).toBe("42");
  });
  it("applies filters", () => {
    expect(resolveTemplate("{{event.data.total_minor | money}} {{event.data.currency | lower}}", ctx)).toBe("125.00 usd");
    expect(resolveTemplate("{{now | date}}", ctx)).toBe("2026-01-05");
    expect(resolveTemplate("{{event.data.list | json}}", ctx)).toBe("[1,2]");
    expect(resolveTemplate("{{org.name | upper}}", ctx)).toBe("ACME");
  });
  it("escapes HTML when asked", () => {
    expect(resolveTemplate("Hi {{event.data.name}}", ctx)).toBe("Hi <b>Ada</b> & co");
    expect(resolveTemplate("Hi {{event.data.name}}", ctx, { escapeHtml: true })).toBe("Hi &lt;b&gt;Ada&lt;/b&gt; &amp; co");
  });
  it("stringifies objects", () => {
    expect(resolveTemplate("{{event.data.list}}", ctx)).toBe("[1,2]");
  });
});

describe("renderValue", () => {
  it("keeps native types for single-expression strings and renders nested structures", () => {
    const out = renderValue({ qty: "{{event.data.qty}}", title: "Q {{event.data.qty}}", nested: { list: "{{event.data.list}}", keep: 5, flag: true }, arr: ["{{org.name}}"] }, ctx);
    expect(out).toEqual({ qty: 3, title: "Q 3", nested: { list: [1, 2], keep: 5, flag: true }, arr: ["Acme"] });
  });
  it("renders a missing single expression to an empty string", () => {
    expect(renderValue({ a: "{{nope}}" }, ctx)).toEqual({ a: "" });
  });
});

describe("referencedPaths", () => {
  it("lists the paths a template reads", () => {
    expect(referencedPaths('Hi {{entity.name ?? "x"}} — {{event.data.total | money}} {{entity.name}}')).toEqual(["entity.name", "event.data.total"]);
  });
});
