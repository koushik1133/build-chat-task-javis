import { createHmac } from "crypto";
import { afterEach, describe, expect, it } from "vitest";
import { cappedRefund, code39Bars, countryMatches, evaluateRules, nextShipmentStatus, returnLinesValue, tierPrice, withinReturnWindow, type ShippingRule } from "../rules";
import { quoteCacheKey } from "../quote";
import { renderShippingLabelPdf } from "../labels";
import { easypostProvider } from "../providers/easypost";
import { shippoProvider } from "../providers/shippo";
import { simulatedEvents, simulatedProvider, simulatedSignature, simRateMinor } from "../providers/simulated";
import { safeHttpsUrl, type ShipmentStatus } from "../types";
import { renderPackingSlipPdf } from "@/lib/pdf/billing-documents";

const rule = (p: Partial<ShippingRule> & Pick<ShippingRule, "kind" | "config">): ShippingRule => ({ id: p.id ?? "r1", name: p.name ?? "Rule", countries: [], active: true, sort: 0, ...p });
const ctx = { country: "US", subtotal_minor: 4000, weight_grams: 800 };

describe("rule engine", () => {
  it("flat and weight tiers", () => {
    const o = evaluateRules([rule({ kind: "flat", config: { price_minor: 500 } }), rule({ id: "r2", kind: "weight_tiers", config: { tiers: [{ up_to_grams: 500, price_minor: 300 }, { up_to_grams: 1000, price_minor: 600 }], over_price_minor: 900 } })], ctx);
    expect(o.map((x) => x.price_minor)).toEqual([500, 600]);
    expect(tierPrice([{ up_to_grams: 500, price_minor: 1 }], 600)).toBeNull();
    expect(tierPrice([{ up_to_grams: 500, price_minor: 1 }], 600, 9)).toBe(9);
  });
  it("free-over thresholds", () => {
    const r = rule({ kind: "free_over", config: { threshold_minor: 5000 } });
    expect(evaluateRules([r], ctx)).toHaveLength(0);
    expect(evaluateRules([r], { ...ctx, subtotal_minor: 5000 })[0].price_minor).toBe(0);
  });
  it("country filters and aliases; inactive rules skipped", () => {
    const r = rule({ kind: "flat", config: { price_minor: 1 }, countries: ["US"] });
    expect(countryMatches(r, "United States")).toBe(true);
    expect(countryMatches(r, "Canada")).toBe(false);
    expect(evaluateRules([r], { ...ctx, country: "usa" })).toHaveLength(1);
    expect(evaluateRules([{ ...r, active: false }], ctx)).toHaveLength(0);
  });
  it("carrier_calculated yields a placeholder", () => {
    expect(evaluateRules([rule({ kind: "carrier_calculated", config: {} })], ctx)[0].needs_carrier).toBe(true);
  });
});

describe("quote cache keys", () => {
  it("are tenant-prefixed so tenants never share entries", () => {
    const items = [{ product_id: "p", qty: 1 }];
    const addr = { country: "US", city: "X" };
    const a = quoteCacheKey("tenantA", items, addr, "f");
    const b = quoteCacheKey("tenantB", items, addr, "f");
    expect(a).not.toBe(b);
    expect(a.startsWith("tenantA:")).toBe(true);
    expect(quoteCacheKey("tenantA", [...items], addr, "f")).toBe(a);
    expect(quoteCacheKey("tenantA", [{ product_id: "p", qty: 2 }], addr, "f")).not.toBe(a);
  });
});

describe("shipment status precedence", () => {
  const seq: ShipmentStatus[] = ["label_purchased", "in_transit", "out_for_delivery", "delivered"];
  it("never regresses", () => {
    expect(nextShipmentStatus("delivered", "in_transit")).toBe("delivered");
    expect(nextShipmentStatus("out_for_delivery", "in_transit")).toBe("out_for_delivery");
    expect(nextShipmentStatus("in_transit", "label_purchased")).toBe("in_transit");
    expect(nextShipmentStatus("void", "delivered")).toBe("void");
  });
  it("moves forward and recovers from exceptions", () => {
    let s: ShipmentStatus = "label_purchased";
    for (const n of seq) s = nextShipmentStatus(s, n);
    expect(s).toBe("delivered");
    expect(nextShipmentStatus("in_transit", "exception")).toBe("exception");
    expect(nextShipmentStatus("exception", "in_transit")).toBe("in_transit");
    expect(nextShipmentStatus("delivered", "exception")).toBe("delivered");
  });
});

describe("returns maths", () => {
  it("window", () => {
    const now = new Date("2026-02-01T00:00:00Z");
    expect(withinReturnWindow("2026-01-10T00:00:00Z", 30, now).ok).toBe(true);
    expect(withinReturnWindow("2025-12-01T00:00:00Z", 30, now).ok).toBe(false);
    expect(withinReturnWindow("2026-01-03T00:00:00Z", 30, now).days_left).toBe(1);
    expect(withinReturnWindow(null, 30, now).ok).toBe(false);
  });
  it("refund caps", () => {
    expect(cappedRefund(5000, 4600, 600)).toBe(4000);
    expect(cappedRefund(100, 4600, 600)).toBe(100);
    expect(cappedRefund(-5, 4600, 0)).toBe(0);
    expect(cappedRefund(100, 100, 100)).toBe(0);
  });
  it("lines value is capped at ordered quantity", () => {
    const items = [{ product_id: "a", description: "A", qty: 2, unit_minor: 1000 }];
    expect(returnLinesValue(items, [{ product_id: "a", qty: 5 }])).toBe(2000);
    expect(returnLinesValue(items, [{ product_id: "zzz", qty: 1 }])).toBe(0);
  });
});

describe("tracking url validation", () => {
  it("accepts only public https", () => {
    expect(safeHttpsUrl("https://www.ups.com/track?x=1")).toContain("https://");
    for (const bad of ["http://ups.com/x", "javascript:alert(1)", "https://user:pw@ups.com/", "https://127.0.0.1/", "https://localhost/x", "https://10.0.0.1/", "ftp://a.com", "https://intranet", "https://a.internal/"]) expect(safeHttpsUrl(bad), bad).toBeNull();
  });
});

describe("label and packing slip PDFs", () => {
  function xrefOk(bytes: Uint8Array): boolean {
    const text = Buffer.from(bytes).toString("latin1");
    const start = Number(/startxref\n(\d+)\n%%EOF/.exec(text)?.[1]);
    if (!text.slice(start).startsWith("xref")) return false;
    const m = /xref\n0 (\d+)\n/.exec(text.slice(start));
    const n = Number(m?.[1]);
    const lines = text.slice(start).split("\n").slice(2, 2 + n);
    return lines.slice(1).every((l, i) => text.slice(Number(l.slice(0, 10))).startsWith(`${i + 1} 0 obj`));
  }
  const addr = { name: "A B", line1: "1 Main", city: "Town", country: "US" };
  it("label is 4x6 with a valid xref and bars", () => {
    const pdf = renderShippingLabelPdf({ carrier: "SimCarrier", service: "standard", tracking_number: "KH123456789012", from: addr, to: addr, weight_grams: 800, order_number: "ORD-000001", simulated: true });
    const text = Buffer.from(pdf).toString("latin1");
    expect(text.startsWith("%PDF-1.4")).toBe(true);
    expect(text).toContain("/MediaBox [0 0 288 432]");
    expect(text).toContain("KH123456789012");
    expect(text).toContain("NOT VALID FOR POSTAGE");
    expect(xrefOk(pdf)).toBe(true);
    expect(code39Bars("KH123").bars.length).toBe(7 * 5);
  });
  it("packing slip renders", () => {
    const pdf = renderPackingSlipPdf({ order_number: "ORD-1", created_at: new Date().toISOString(), customer_name: "A", ship_to: ["1 Main"], carrier: null, service: null, tracking_number: null, items: [{ description: "Widget", qty: 2 }] }, { brand_name: "Shop" });
    expect(xrefOk(pdf)).toBe(true);
    expect(Buffer.from(pdf).toString("latin1")).toContain("Widget");
  });
});

describe("simulated provider", () => {
  it("deterministic rates by weight and zone", async () => {
    const req = { from: addr0("US"), to: addr0("US"), parcel: { weight_grams: 1500 }, currency: "USD" };
    const rates = await simulatedProvider.rates(req, null);
    expect(rates.map((r) => r.service).sort()).toEqual(["economy", "express", "standard"]);
    expect(rates.find((r) => r.service === "standard")?.amount_minor).toBe(simRateMinor("standard", 1500, 1));
    const intl = await simulatedProvider.rates({ ...req, to: addr0("FR") }, null);
    expect(intl.find((r) => r.service === "standard")!.amount_minor).toBeGreaterThan(rates.find((r) => r.service === "standard")!.amount_minor);
  });
  it("scripted events grow with elapsed time", () => {
    const start = new Date("2026-01-01T00:00:00Z");
    const base = { tracking_number: "T", carrier: "SimCarrier", service: "express", purchased_at: start.toISOString(), provider_ref: "simulated:x" };
    expect(simulatedEvents({ ...base, now: start })).toHaveLength(1);
    const end = simulatedEvents({ ...base, now: new Date(start.getTime() + 10 * 86_400_000) });
    expect(end[end.length - 1].status).toBe("delivered");
  });
});
function addr0(country: string) {
  return { line1: "1", city: "c", country };
}

describe("webhook signatures", () => {
  afterEach(() => {
    delete process.env.EASYPOST_WEBHOOK_SECRET;
    delete process.env.SHIPPO_WEBHOOK_SECRET;
    delete process.env.SHIPPING_WEBHOOK_SECRET;
  });
  const h = (m: Record<string, string>) => ({ get: (k: string) => m[k.toLowerCase()] ?? null });
  it("simulated: HMAC required", () => {
    process.env.SHIPPING_WEBHOOK_SECRET = "s3cret";
    const body = JSON.stringify({ tracking_number: "T1", status: "delivered", occurred_at: "2026-01-01T00:00:00Z" });
    expect(simulatedProvider.verifyWebhook(body, h({}))).toBeNull();
    expect(simulatedProvider.verifyWebhook(body, h({ "x-kernelhub-signature": "00" }))).toBeNull();
    const ok = simulatedProvider.verifyWebhook(body, h({ "x-kernelhub-signature": simulatedSignature("s3cret", body) }));
    expect(ok?.[0].event.status).toBe("delivered");
  });
  it("easypost: hmac-sha256-hex header", () => {
    process.env.EASYPOST_WEBHOOK_SECRET = "ep";
    const body = JSON.stringify({ result: { tracking_code: "EZ1", carrier: "USPS", tracking_details: [{ status: "delivered", datetime: "2026-01-02T00:00:00Z", message: "Delivered" }] } });
    const sig = `hmac-sha256-hex=${createHmac("sha256", "ep").update(body).digest("hex")}`;
    expect(easypostProvider.verifyWebhook(body, h({ "x-hmac-signature": sig }))?.[0].tracking_number).toBe("EZ1");
    expect(easypostProvider.verifyWebhook(body + " ", h({ "x-hmac-signature": sig }))).toBeNull();
    expect(easypostProvider.verifyWebhook(body, h({}))).toBeNull();
  });
  it("shippo: token in url", () => {
    process.env.SHIPPO_WEBHOOK_SECRET = "tok";
    const body = JSON.stringify({ data: { tracking_number: "SH1", carrier: "usps", tracking_status: { status: "DELIVERED", status_date: "2026-01-02T00:00:00Z", status_details: "ok" } } });
    expect(shippoProvider.verifyWebhook(body, h({}), new URL("https://x.test/w?token=tok"))?.[0].event.status).toBe("delivered");
    expect(shippoProvider.verifyWebhook(body, h({}), new URL("https://x.test/w?token=bad"))).toBeNull();
    expect(shippoProvider.verifyWebhook(body, h({}), new URL("https://x.test/w"))).toBeNull();
  });
});
