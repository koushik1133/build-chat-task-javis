import { describe, expect, it } from "vitest";
import {
  DEFAULT_WIDGET_CONFIG,
  embedSnippet,
  mergePublicConfig,
  parseScriptDataset,
  parseWidgetConfig,
  readableOn,
  sseComment,
  sseFrame,
} from "./config";

describe("parseWidgetConfig", () => {
  it("returns defaults for junk", () => {
    expect(parseWidgetConfig(null)).toEqual(DEFAULT_WIDGET_CONFIG);
    expect(parseWidgetConfig("not json")).toEqual(DEFAULT_WIDGET_CONFIG);
    expect(parseWidgetConfig("[1,2]")).toEqual(DEFAULT_WIDGET_CONFIG);
  });
  it("accepts a stored JSON string and sanitises values", () => {
    const c = parseWidgetConfig(JSON.stringify({ modes: { chat: false, booking: true, bogus: true }, defaultMode: "chat", greeting: "  Hello  ", color: "#ABCDEF", position: "bottom-left", consentMode: "required", enabled: false }));
    expect(c.modes).toEqual({ chat: false, lead: true, booking: true, help: false });
    expect(c.defaultMode).toBe("lead"); // chat disabled → first enabled mode
    expect(c.greeting).toBe("Hello");
    expect(c.color).toBe("#abcdef");
    expect(c.position).toBe("bottom-left");
    expect(c.consentMode).toBe("required");
    expect(c.enabled).toBe(false);
  });
  it("rejects bad colours and caps the greeting", () => {
    const c = parseWidgetConfig({ color: "red", greeting: "x".repeat(500) });
    expect(c.color).toBeNull();
    expect(c.greeting).toHaveLength(200);
  });
});

describe("mergePublicConfig", () => {
  const base = {
    siteId: "s1",
    siteTitle: "Site",
    orgSlug: "acme",
    brandName: "Acme",
    stored: parseWidgetConfig({ modes: { chat: true, lead: true, booking: true, help: true }, defaultMode: "booking" }),
    consentText: null,
    brandPrimary: "#123456",
    brandForeground: "#ffffff",
    cssVars: { "--brand-primary": "#123456" },
    bookingTypes: [],
    helpAvailable: false,
  };
  it("drops booking when there are no booking types and falls back the default mode", () => {
    const c = mergePublicConfig(base);
    expect(c.modes).toEqual(["chat", "lead", "help"]);
    expect(c.defaultMode).toBe("chat");
    expect(c.helpEnabled).toBe(false);
    expect(c.color).toBe("#123456");
    expect(c.consentText.length).toBeGreaterThan(10);
  });
  it("uses the stored colour and consent text when present", () => {
    const c = mergePublicConfig({ ...base, stored: { ...base.stored, color: "#ffffff" }, consentText: "  Yes please  ", bookingTypes: [{ slug: "intro", name: "Intro", description: null, durationMinutes: 30, priceMinor: null, currency: null }] });
    expect(c.color).toBe("#ffffff");
    expect(c.colorForeground).toBe("#111111");
    expect(c.consentText).toBe("Yes please");
    expect(c.modes).toContain("booking");
    expect(c.defaultMode).toBe("booking");
  });
  it("is disabled when no modes remain", () => {
    const c = mergePublicConfig({ ...base, stored: parseWidgetConfig({ modes: { chat: false, lead: false, booking: false, help: false } }) });
    expect(c.enabled).toBe(false);
  });
});

describe("script dataset + helpers", () => {
  it("parses data-* overrides and ignores invalid ones", () => {
    expect(parseScriptDataset({ mode: "help", color: "#FFaa00", position: "bottom-left", greeting: " Hi ", consent: "required" })).toEqual({ mode: "help", color: "#ffaa00", position: "bottom-left", greeting: "Hi", consent: "required" });
    expect(parseScriptDataset({ mode: "nope", color: "blue", position: "top", consent: "maybe" })).toEqual({ mode: null, color: null, position: null, greeting: null, consent: null });
  });
  it("frames SSE events on single lines", () => {
    expect(sseFrame("messages", { a: "line\nbreak" }, "t1")).toBe('event: messages\nid: t1\ndata: {"a":"line\\nbreak"}\n\n');
    expect(sseComment("keep\nalive")).toBe(": keep alive\n\n");
  });
  it("picks readable foreground", () => {
    expect(readableOn("#ffffff")).toBe("#111111");
    expect(readableOn("#000000")).toBe("#ffffff");
    expect(readableOn("nope")).toBe("#ffffff");
  });
  it("builds the embed snippet", () => {
    const s = embedSnippet("https://app.example.com/", "abc", { defaultMode: "chat", position: "bottom-right", consentMode: "optional", color: "#112233" });
    expect(s).toContain('src="https://app.example.com/api/widget.js"');
    expect(s).toContain('data-site="abc"');
    expect(s).toContain('data-color="#112233"');
  });
});
