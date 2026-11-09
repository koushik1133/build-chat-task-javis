import { describe, expect, it } from "vitest";
import { canTransferAct, clampReceive, countVariance, isFullyReceived, planAllocation, summariseCount } from "@/lib/inventory/locations-pure";
import { outstandingByLocation } from "@/lib/inventory/stock";

const avail = (entries: Record<string, Array<[string, number]>>) =>
  new Map(Object.entries(entries).map(([p, l]) => [p, l.map(([location_id, available]) => ({ location_id, available }))]));

describe("planAllocation", () => {
  it("fills from the preferred location first, then others by availability", () => {
    const plan = planAllocation([{ product_id: "p", qty: 10 }], avail({ p: [["a", 4], ["b", 9], ["c", 2]] }), "a");
    expect(plan.allocations).toEqual([
      { product_id: "p", location_id: "a", qty: 4 },
      { product_id: "p", location_id: "b", qty: 6 },
    ]);
    expect(plan.shortages).toEqual([]);
  });

  it("reports shortages and never over-allocates a location", () => {
    const plan = planAllocation([{ product_id: "p", qty: 10 }], avail({ p: [["a", 3], ["b", 2]] }), "b");
    expect(plan.allocations).toEqual([
      { product_id: "p", location_id: "b", qty: 2 },
      { product_id: "p", location_id: "a", qty: 3 },
    ]);
    expect(plan.shortages).toEqual([{ product_id: "p", requested: 10, short: 5 }]);
  });

  it("skips empty locations and is deterministic on ties", () => {
    const plan = planAllocation([{ product_id: "p", qty: 3 }], avail({ p: [["z", 5], ["a", 5], ["m", 0]] }), null);
    expect(plan.allocations).toEqual([{ product_id: "p", location_id: "a", qty: 3 }]);
  });

  it("treats an unknown product as a full shortage", () => {
    expect(planAllocation([{ product_id: "x", qty: 2 }], avail({}), null).shortages).toEqual([{ product_id: "x", requested: 2, short: 2 }]);
  });
});

describe("transfer state machine", () => {
  it("allows only legal actions per status", () => {
    expect(canTransferAct("draft", "ship")).toBe(true);
    expect(canTransferAct("draft", "receive")).toBe(false);
    expect(canTransferAct("in_transit", "receive")).toBe(true);
    expect(canTransferAct("in_transit", "ship")).toBe(false);
    expect(canTransferAct("in_transit", "cancel")).toBe(true);
    expect(canTransferAct("received", "cancel")).toBe(false);
    expect(canTransferAct("cancelled", "ship")).toBe(false);
  });

  it("clamps receipts to what is outstanding and detects completion", () => {
    expect(clampReceive({ qty: 10, received_qty: 7 }, 5)).toBe(3);
    expect(clampReceive({ qty: 10, received_qty: 7 }, -2)).toBe(0);
    expect(isFullyReceived([{ qty: 2, received_qty: 2 }, { qty: 1, received_qty: 0 }])).toBe(false);
    expect(isFullyReceived([{ qty: 2, received_qty: 2 }])).toBe(true);
    expect(isFullyReceived([])).toBe(false);
  });
});

describe("stock count variance", () => {
  it("is counted minus expected, null until counted", () => {
    expect(countVariance(10, 7)).toBe(-3);
    expect(countVariance(10, 12)).toBe(2);
    expect(countVariance(10, null)).toBeNull();
  });
  it("summarises shrinkage and overage", () => {
    expect(summariseCount([
      { expected_qty: 10, counted_qty: 7 },
      { expected_qty: 5, counted_qty: 8 },
      { expected_qty: 4, counted_qty: 4 },
      { expected_qty: 9, counted_qty: null },
    ])).toEqual({ lines: 4, counted: 3, with_variance: 2, net_variance: 0, shrinkage: 3, overage: 3 });
  });
});

describe("outstandingByLocation", () => {
  it("nets reservations per product and location", () => {
    const rows = [
      { product_id: "p", kind: "reserve" as const, qty: 5, location_id: "a" },
      { product_id: "p", kind: "reserve" as const, qty: 3, location_id: "b" },
      { product_id: "p", kind: "release" as const, qty: 5, location_id: "a" },
      { product_id: "q", kind: "reserve" as const, qty: 2, location_id: null },
    ];
    expect(outstandingByLocation(rows)).toEqual([
      { product_id: "p", location_id: "b", qty: 3 },
      { product_id: "q", location_id: null, qty: 2 },
    ]);
  });
});
