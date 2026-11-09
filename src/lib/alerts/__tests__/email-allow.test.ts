import { beforeEach, describe, expect, it, vi } from "vitest";

const queryOne = vi.fn();
vi.mock("@/lib/dsql", () => ({ query: vi.fn(), queryOne: (...a: unknown[]) => queryOne(...a), withRetry: (f: () => unknown) => f() }));

import { isAllowedAlertEmail } from "@/lib/alerts/store";

describe("isAllowedAlertEmail", () => {
  beforeEach(() => queryOne.mockReset());
  it("allows the caller's own address without a lookup", async () => {
    expect(await isAllowedAlertEmail({ orgId: "o", email: "Me@x.com" }, "me@x.com")).toBe(true);
    expect(queryOne).not.toHaveBeenCalled();
  });
  it("allows an active member", async () => {
    queryOne.mockResolvedValue({ id: "m1" });
    expect(await isAllowedAlertEmail({ orgId: "o", email: "me@x.com" }, "mate@x.com")).toBe(true);
  });
  it("rejects arbitrary outside addresses and malformed input", async () => {
    queryOne.mockResolvedValue(null);
    expect(await isAllowedAlertEmail({ orgId: "o", email: "me@x.com" }, "victim@elsewhere.com")).toBe(false);
    expect(await isAllowedAlertEmail({ orgId: "o", email: "me@x.com" }, "a@b.com\nbcc:x@y.com")).toBe(false);
  });
});
