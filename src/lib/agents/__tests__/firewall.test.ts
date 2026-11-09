import { describe, expect, it } from "vitest";
import { z } from "zod";
import { hasUntrustedOutput, needsApproval, riskOf, taintForcesApproval } from "../registry";
import type { ToolContext, ToolSpec } from "../types";

const mk = (name: string, scope: "read" | "write", extra: Partial<ToolSpec> = {}): ToolSpec => ({
  name, description: "", module: "x", input: z.object({}), parameters: {}, scope, run: async () => ({ ok: true, summary: "" }), ...extra,
});
const ctx = (autonomy: ToolContext["autonomy"], tainted?: boolean): ToolContext => ({ userId: "u", runId: "r", agentId: null, autonomy, tainted });

describe("action firewall", () => {
  it("classifies risk", () => {
    expect(riskOf(mk("comms.send_email", "write"))).toBe("high");
    expect(riskOf(mk("crm.create_contact", "write"))).toBe("medium");
    expect(riskOf(mk("crm.search_contacts", "read"))).toBe("low");
    expect(riskOf(mk("records.delete", "write"))).toBe("high");
    expect(riskOf(mk("foo.bar", "write", { risk: "low" }))).toBe("low");
  });
  it("tainted + auto + high-risk requires approval", () => {
    expect(needsApproval(mk("comms.send_email", "write"), {}, ctx("auto", true))).toBe(true);
    expect(taintForcesApproval(mk("comms.send_email", "write"), ctx("auto", true))).toBe(true);
  });
  it("untainted + auto is allowed", () => {
    expect(needsApproval(mk("comms.send_email", "write"), {}, ctx("auto", false))).toBe(false);
    expect(needsApproval(mk("comms.send_email", "write"), {}, ctx("auto"))).toBe(false);
  });
  it("tainted auto medium-risk write still allowed", () => {
    expect(needsApproval(mk("crm.create_contact", "write"), {}, ctx("auto", true))).toBe(false);
  });
  it("tainted overrides a tool's own requiresApproval=false in approve mode", () => {
    expect(needsApproval(mk("billing.send_quote", "write", { requiresApproval: false }), {}, ctx("approve", true))).toBe(true);
  });
  it("draft behaviour unchanged", () => {
    expect(needsApproval(mk("crm.create_contact", "write"), {}, ctx("draft"))).toBe(true);
    expect(needsApproval(mk("crm.search_contacts", "read"), {}, ctx("draft", true))).toBe(false);
  });
  it("flags untrusted-output tools", () => {
    expect(hasUntrustedOutput(mk("helpdesk.get_ticket", "read"))).toBe(true);
    expect(hasUntrustedOutput(mk("leads.list", "read"))).toBe(true);
    expect(hasUntrustedOutput(mk("kb.search", "read"))).toBe(false);
    expect(hasUntrustedOutput(mk("x.y", "read", { untrustedOutput: true }))).toBe(true);
  });
});

describe("sec9: firewall hardening", () => {
  it("config/bulk-state writes are high risk so taint gates them", () => {
    for (const n of ["snapshots.apply", "automations.install_template", "automations.toggle", "orders.fulfil", "agents.run_agent", "billing.create_recurring"]) {
      expect(taintForcesApproval(mk(n, "write"), ctx("auto", true))).toBe(true);
    }
  });
});

describe("sec9: output guard on auto-sent text", () => {
  it("auto run with key-like text in an outbound send is forced to approval", () => {
    const send = mk("comms.send_email", "write");
    expect(needsApproval(send, { to: "a@b.c", body: "key sk-abcdefghijklmnopqrstuv" }, ctx("auto", false))).toBe(true);
    expect(needsApproval(send, { to: "a@b.c", body: "Hello, see you at 3pm." }, ctx("auto", false))).toBe(false);
  });
});

describe("sec9: customer-text read tools are wrapped", () => {
  it("flags order/invoice/report readers as untrusted output", () => {
    for (const n of ["orders.list", "billing.list_invoices", "reports.run", "tasks.list", "documents.status"]) expect(hasUntrustedOutput(mk(n, "read"))).toBe(true);
  });
});
