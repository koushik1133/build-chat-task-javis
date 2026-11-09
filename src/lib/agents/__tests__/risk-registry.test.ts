import { describe, expect, it } from "vitest";
import "../tools/index";
import { listTools, needsApproval, riskOf } from "../registry";
import type { ToolContext } from "../types";

const ctx = (autonomy: ToolContext["autonomy"], tainted?: boolean): ToolContext => ({ userId: "u", runId: "r", agentId: null, autonomy, tainted });

describe("live tool registry risk classification", () => {
  const all = listTools();

  it("has tools registered", () => {
    expect(all.length).toBeGreaterThan(50);
  });

  it("known high-risk tools are high when registered", () => {
    const must = [
      "comms.send_email", "messaging.reply", "helpdesk.reply", "billing.send_quote", "billing.issue_credit_note", "documents.send",
      "records.delete", "orders.fulfil", "orders.unfulfil", "snapshots.apply", "calendar.cancel_booking", "calendar.reschedule", "agents.run_agent",
    ];
    const byName = new Map(all.map((t) => [t.name, t]));
    for (const n of must) {
      const t = byName.get(n);
      if (t) expect(riskOf(t), n).toBe("high");
    }
  });

  it("reads are never blocked by the taint firewall, whatever their name", () => {
    for (const t of all.filter((x) => x.scope === "read")) {
      expect(needsApproval(t, {}, ctx("auto", true)), t.name).toBe(false);
      expect(riskOf(t), t.name).not.toBe("high");
    }
  });

  it("harmless writes needed by the receptionist stay ungated when tainted", () => {
    for (const n of ["crm.create_contact", "tasks.create", "calendar.book", "calendar.propose_slots", "comms.notify"]) {
      const t = all.find((x) => x.name === n);
      if (t && t.scope === "write") expect(riskOf(t), n).not.toBe("high");
    }
  });

  it("no destructive-sounding write is left at medium", () => {
    const sus = /(delete|remove|erase|purge|destroy|revoke|cancel|void|refund|publish|send|grant|invite|wipe|reset)/;
    const offenders = all.filter((t) => t.scope === "write" && riskOf(t) !== "high" && sus.test(t.name.split(".")[1] ?? "")).map((t) => `${t.name}:${riskOf(t)}`);
    expect(offenders).toEqual([]);
  });

  it("autonomy ordering: tainted high write forced in every autonomy, draft gates all writes, auto lets untainted through", () => {
    const send = all.find((t) => t.name === "comms.send_email");
    if (!send) return;
    for (const a of ["draft", "approve", "auto"] as const) expect(needsApproval(send, {}, ctx(a, true)), a).toBe(true);
    expect(needsApproval(send, { body: "hi" }, ctx("auto", false))).toBe(false);
    expect(needsApproval(send, { body: "hi" }, ctx("draft", false))).toBe(true);
  });
});
