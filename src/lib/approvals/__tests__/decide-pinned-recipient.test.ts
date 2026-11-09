import { describe, expect, it, vi } from "vitest";

/**
 * SEC: approving an edited `messaging.reply` (or any send tool) may change the
 * text but never the recipient or channel that was reviewed.
 */
vi.mock("@/lib/dsql", () => ({ query: vi.fn(async () => []), queryOne: vi.fn(async () => null), withRetry: vi.fn(async <T,>(fn: () => Promise<T>) => fn()) }));
vi.mock("@/lib/agents/tools/index", () => ({ ensureToolsLoaded: () => undefined }));
vi.mock("@/lib/agents/queue", () => ({ enqueueJob: vi.fn(async () => undefined) }));
vi.mock("@/lib/agents/memory", () => ({ rememberCorrection: vi.fn(async () => undefined) }));
vi.mock("@/lib/agents/registry", () => ({ getTool: () => undefined }));

import { ApprovalError, assertEditKeepsRecipient } from "@/lib/approvals/decide";

const draft = JSON.stringify({ to: "+15550001", channel: "sms", text: "Hi, we are open until 6." });

describe("assertEditKeepsRecipient", () => {
  it("allows editing the text", () => {
    expect(() => assertEditKeepsRecipient("messaging.reply", draft, { to: "+15550001", channel: "sms", text: "Hi, we close at 6." })).not.toThrow();
  });

  it("refuses a different recipient", () => {
    expect(() => assertEditKeepsRecipient("messaging.reply", draft, { to: "+15559999", channel: "sms", text: "x" })).toThrow(ApprovalError);
  });

  it("refuses a different channel", () => {
    expect(() => assertEditKeepsRecipient("messaging.reply", draft, { to: "+15550001", channel: "whatsapp", text: "x" })).toThrow(/channel/);
  });

  it("pins comms.send_email recipients too, and leaves unrelated tools alone", () => {
    expect(() => assertEditKeepsRecipient("comms.send_email", JSON.stringify({ to: "a@x.test", subject: "s", body: "b" }), { to: "b@x.test", subject: "s", body: "b" })).toThrow(ApprovalError);
    expect(() => assertEditKeepsRecipient("billing.refund", JSON.stringify({ id: "inv1" }), { id: "inv2" })).not.toThrow();
  });
});
