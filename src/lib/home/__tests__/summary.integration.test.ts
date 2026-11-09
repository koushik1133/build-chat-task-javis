import { randomUUID } from "crypto";
import { afterAll, describe, expect, it } from "vitest";
import { INTEGRATION } from "@/__integration__/setup";

/**
 * DB-backed check that the home summary, onboarding status and completion
 * run end-to-end against a seeded workspace with no section failing.
 *   DB_INTEGRATION=1 npx vitest run src/lib/home/__tests__/summary.integration.test.ts
 */
describe.skipIf(!INTEGRATION)("home summary + onboarding (integration)", () => {
  const dataId = `test-home-${randomUUID()}`;
  const orgId = `test-org-${randomUUID()}`;
  const allAreas = () => true;

  afterAll(async () => {
    const { clearDemoData } = await import("@/lib/demo/seed");
    const { query } = await import("@/lib/dsql");
    await clearDemoData(dataId).catch(() => undefined);
    for (const t of ["organizations", "agents", "record_types", "calendars", "booking_types", "sla_policies", "playbook_settings", "business_profile", "audit_log"]) {
      await query(`DELETE FROM ${t} WHERE ${t === "organizations" ? "owner_user_id" : "user_id"} = $1`, [dataId]).catch(() => undefined);
    }
    await query(`DELETE FROM availability_rules WHERE calendar_id NOT IN (SELECT id FROM calendars)`).catch(() => undefined);
  });

  it("aggregates every section for a seeded workspace", async () => {
    const { query } = await import("@/lib/dsql");
    await query(`INSERT INTO organizations (id, name, slug, owner_user_id, settings) VALUES ($1, 'Test Org', $2, $3, $4)`, [orgId, `t-${orgId.slice(-8)}`, dataId, JSON.stringify({ currency: "USD", timezone: "America/New_York", locale: "en" })]);
    const { seedDemoWorkspace } = await import("@/lib/demo/seed");
    const seeded = await seedDemoWorkspace(dataId, { industry: "agency" });
    expect(seeded.warnings).toEqual([]);

    const warnings: string[] = [];
    const orig = console.warn;
    console.warn = (...a: unknown[]) => { warnings.push(a.map(String).join(" ")); };
    let summary;
    try {
      const { buildHomeSummary } = await import("../summary");
      summary = await buildHomeSummary({ dataId, can: allAreas });
    } finally {
      console.warn = orig;
    }
    expect(warnings.filter((w) => w.includes("[home/summary]"))).toEqual([]);
    expect(summary.timezone).toBe("America/New_York");
    expect(summary.demo.active).toBe(true);
    expect(summary.empty).toBe(false);
    const keys = (summary.kpis ?? []).map((k) => k.key);
    expect(keys).toEqual(expect.arrayContaining(["revenue", "quotes", "bookings", "tickets", "tasks", "inbox"]));
    const revenue = summary.kpis!.find((k) => k.key === "revenue")!;
    expect(revenue.value).not.toBe("$0.00");
    expect(summary.needsYou!.some((n) => n.kind === "sla")).toBe(true);
    expect(summary.needsYou!.some((n) => n.kind === "invoice")).toBe(true);
    expect(summary.needsYou!.some((n) => n.kind === "deal")).toBe(true);
    expect(summary.today!.filter((t) => t.kind === "booking").length).toBeGreaterThan(0);
    expect(summary.cashflow!.points.length).toBe(8);

    // Role gating: a viewer without billing cannot see money tiles.
    const { buildHomeSummary } = await import("../summary");
    const limited = await buildHomeSummary({ dataId, can: (area) => area === "tasks" });
    expect((limited.kpis ?? []).map((k) => k.key)).toEqual(["tasks"]);
    expect(limited.needsYou).toBeNull();
    expect(limited.cashflow).toBeNull();

    // Onboarding status + completion.
    const { getOnboardingStatus } = await import("@/lib/onboarding/status");
    const before = await getOnboardingStatus(dataId, orgId);
    expect(before.completedAt).toBeNull();
    expect(before.checklist.items.find((i) => i.key === "contact")!.done).toBe(true);
    expect(before.checklist.items.find((i) => i.key === "profile")!.done).toBe(false);

    const { completeOnboarding } = await import("@/lib/onboarding/complete");
    const res = await completeOnboarding(dataId, "actor-1", { industry: "agency", packs: ["projects"], modules: { booking: true, invoicing: true, helpdesk: true, inventory: false, voice_mail: false }, ai: { autonomy: "approve", playbooks: true, outcome_pricing: false } });
    expect(res.warnings).toEqual([]);
    expect(res.packsInstalled).toEqual(["agency", "projects"]);
    expect(res.bookingTypeId).toBeTruthy();
    expect(res.slaPolicyId).toBeTruthy();
    expect(res.agentsCreated).toBe(3);

    const twice = await completeOnboarding(dataId, "actor-1", { industry: "agency", packs: [], modules: { booking: true, invoicing: true, helpdesk: true, inventory: false, voice_mail: false }, ai: { autonomy: "auto", playbooks: false, outcome_pricing: false } });
    expect(twice.agentsCreated).toBe(0);
    expect(twice.completedAt).toBe(res.completedAt);

    const after = await getOnboardingStatus(dataId, orgId);
    expect(after.completedAt).toBe(res.completedAt);
    expect(after.checklist.items.find((i) => i.key === "profile")!.done).toBe(true);
    expect(after.checklist.items.find((i) => i.key === "booking")!.done).toBe(true);
  });
});
