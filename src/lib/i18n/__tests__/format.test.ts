import { describe, expect, it } from "vitest";
import {
  CURRENCIES,
  formatDate,
  formatMoney,
  formatNumber,
  formatRelative,
  getCurrency,
  majorToMinor,
  minorDigitsFor,
  minorToMajor,
} from "@/lib/i18n/format";

// Intl output can use U+00A0 / U+202F between symbol and digits; normalise for assertions.
const norm = (s: string) => s.replace(/[  ]/g, " ");

describe("CURRENCIES", () => {
  it("has unique upper-case codes with sane minor digits", () => {
    const codes = CURRENCIES.map((c) => c.code);
    expect(new Set(codes).size).toBe(codes.length);
    for (const c of CURRENCIES) {
      expect(c.code).toBe(c.code.toUpperCase());
      expect([0, 2, 3]).toContain(c.minorDigits);
      expect(c.symbol.length).toBeGreaterThan(0);
    }
  });

  it("knows the 0- and 3-digit currencies", () => {
    expect(getCurrency("JPY")?.minorDigits).toBe(0);
    expect(getCurrency("KWD")?.minorDigits).toBe(3);
    expect(getCurrency("BHD")?.minorDigits).toBe(3);
    expect(getCurrency("inr")?.minorDigits).toBe(2);
    expect(minorDigitsFor("ZZZ")).toBe(2);
  });
});

describe("formatMoney", () => {
  it("uses lakh grouping for INR under en-IN", () => {
    expect(norm(formatMoney(10_000_000, "INR", "en-IN"))).toBe("₹1,00,000.00");
    expect(norm(formatMoney(123_456_789, "INR", "en-IN"))).toBe("₹12,34,567.89");
  });

  it("uses thousands grouping for INR under en-US", () => {
    expect(norm(formatMoney(10_000_000, "INR", "en-US"))).toBe("₹100,000.00");
  });

  it("formats JPY with zero minor digits", () => {
    const s = norm(formatMoney(1_000, "JPY", "ja-JP"));
    expect(s).toMatch(/^[￥¥]1,000$/);
    expect(norm(formatMoney(1_000, "JPY", "en-US"))).toBe("¥1,000");
    expect(formatMoney(1_000, "JPY", "en-US")).not.toContain(".");
  });

  it("formats KWD with three minor digits", () => {
    expect(norm(formatMoney(1_234, "KWD", "en"))).toBe("KWD 1.234");
    expect(norm(formatMoney(1_000_000, "KWD", "en"))).toBe("KWD 1,000.000");
  });

  it("formats USD cents and negative amounts", () => {
    expect(norm(formatMoney(12_345, "USD", "en-US"))).toBe("$123.45");
    expect(norm(formatMoney(-5_00, "USD", "en-US"))).toBe("-$5.00");
    expect(norm(formatMoney(0, "USD", "en-US"))).toBe("$0.00");
  });

  it("respects locale digit/separator conventions for EUR", () => {
    expect(norm(formatMoney(123_450, "EUR", "es-ES"))).toBe("1234,50 €");
    expect(norm(formatMoney(123_450, "EUR", "de-DE"))).toBe("1.234,50 €");
  });

  it("supports code display and compact whole amounts", () => {
    expect(norm(formatMoney(100_00, "USD", "en-US", { display: "code" }))).toBe("USD 100.00");
    expect(norm(formatMoney(100_00, "USD", "en-US", { compactWhole: true }))).toBe("$100");
    expect(norm(formatMoney(100_50, "USD", "en-US", { compactWhole: true }))).toBe("$100.50");
  });

  it("never throws on garbage input", () => {
    expect(formatMoney(Number.NaN, "USD", "en-US")).toBe("$0.00");
    expect(typeof formatMoney(100, "NOPE", "en-US")).toBe("string");
    expect(typeof formatMoney(100, "USD", "not-a-locale-!!")).toBe("string");
  });
});

describe("minor/major conversion", () => {
  it("divides by the right exponent per currency", () => {
    expect(minorToMajor(12_345, "USD")).toBe(123.45);
    expect(minorToMajor(1_000, "JPY")).toBe(1000);
    expect(minorToMajor(1_234, "KWD")).toBe(1.234);
  });
  it("rounds half-up back to integers", () => {
    expect(majorToMinor(123.45, "USD")).toBe(12_345);
    expect(majorToMinor(0.1 + 0.2, "USD")).toBe(30);
    expect(majorToMinor(1.2345, "KWD")).toBe(1_235);
    expect(majorToMinor(999.6, "JPY")).toBe(1_000);
  });
});

describe("formatNumber / formatDate / formatRelative", () => {
  it("groups numbers per locale", () => {
    expect(formatNumber(1_234_567.891, "en-US")).toBe("1,234,567.891");
    expect(formatNumber(1_234_567, "en-IN")).toBe("12,34,567");
    expect(formatNumber(Number.POSITIVE_INFINITY)).toBe("—");
  });

  it("formats dates in a timezone and handles bad input", () => {
    const iso = "2026-03-15T23:30:00Z";
    expect(formatDate(iso, "en-US", { dateStyle: "medium", timeZone: "UTC" })).toBe("Mar 15, 2026");
    // Kolkata is UTC+5:30 → next day
    expect(formatDate(iso, "en-US", { dateStyle: "medium", timeZone: "Asia/Kolkata" })).toBe("Mar 16, 2026");
    expect(formatDate("garbage")).toBe("—");
    expect(formatDate(null)).toBe("—");
  });

  it("produces relative phrases", () => {
    const now = new Date("2026-01-10T12:00:00Z");
    expect(formatRelative("2026-01-07T12:00:00Z", "en-US", now)).toBe("3 days ago");
    expect(formatRelative("2026-01-10T14:00:00Z", "en-US", now)).toBe("in 2 hours");
    expect(formatRelative("2026-01-10T12:00:10Z", "en-US", now)).toBe("now");
    expect(formatRelative("2026-01-07T12:00:00Z", "es", now)).toBe("hace 3 días");
    expect(formatRelative("x", "en-US", now)).toBe("—");
  });
});
