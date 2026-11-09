import { describe, expect, it } from "vitest";
import { giftCardAttemptAllowed } from "../giftcards";
import { suggestedRefund } from "@/lib/shipping/returns";
import type { OrderDTO } from "@/lib/storefront/orders";
import { xmlEscape } from "@/lib/tax-compliance/einvoice/peppol-ubl";
import { assertNonNegativeTotal } from "@/lib/money/totals-guard";
import { resolveTax } from "@/lib/tax-compliance/resolver";
import { isDeniedColumn } from "@/lib/snapshots/tables";

describe("security phase 11 regressions", () => {
  it("gift card limiter ignores the code prefix: rotating prefixes buys no extra attempts", async () => {
    const ip = `9.9.9.${Math.floor(Math.random() * 200)}`;
    let blockedAt = -1;
    for (let i = 0; i < 14; i++) {
      const ok = await giftCardAttemptAllowed(ip);
      if (!ok && blockedAt < 0) blockedAt = i;
    }
    expect(blockedAt).toBe(10);
  });

  it("refund for a discounted order is the discounted share, not list price", () => {
    const order = {
      items: [
        { description: "A", qty: 1, unit_minor: 10_000, product_id: "pa" },
        { description: "B", qty: 1, unit_minor: 10_000, product_id: "pb" },
        { description: "Discount (X)", qty: 1, unit_minor: -10_000 },
      ],
      subtotal_minor: 10_000,
      tax_minor: 0,
    } as unknown as OrderDTO;
    expect(suggestedRefund(order, [{ product_id: "pa", description: "A", qty: 1 }])).toBe(5_000);
  });

  it("xmlEscape removes characters illegal in XML 1.0", () => {
    expect(xmlEscape("a\u0000b\u0008c<d>")).toBe("abc&lt;d&gt;");
  });

  it("negative document totals are rejected", () => {
    expect(() => assertNonNegativeTotal({ total_minor: -1, subtotal_minor: -1 })).toThrow();
    expect(() => assertNonNegativeTotal({ total_minor: 0, subtotal_minor: 0 })).not.toThrow();
  });

  it("India reverse charge is only honoured for a buyer with a valid GSTIN", async () => {
    const profile = { regime: "india_gst", country: "IN", registration_type: "regular", registration_number: "27AAPFU0939F1ZV", state_province: "27", settings: {} } as unknown as Parameters<typeof resolveTax>[0]["profile"];
    const items = [{ description: "x", qty: 1, unit_minor: 10_000, tax_rate_bp: 1800 }];
    const r = await resolveTax({ profile, items, rates: [], reverseCharge: true, contact: { tax_number: null } as never });
    expect(r.meta.reverse_charge).toBe(false);
    expect(r.meta.warnings.join(" ")).toMatch(/Reverse charge requested/);
  });

  it("saved payment method refs are dropped from exports", () => {
    expect(isDeniedColumn("payment_ref")).toBe(true);
  });
});
