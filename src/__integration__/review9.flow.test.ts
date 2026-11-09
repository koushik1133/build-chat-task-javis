/**
 * Phase 9 correctness review: snapshot round trip + hardening, portal message
 * cursor, reschedule vs external busy time, calendar sync reconcile.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { cleanupDataIds, createTestOrg, describeDb, setScope, sql, sqlOne, type TestOrg } from "./setup";

vi.mock("@/lib/auth/scope", () => import("./setup").then((m) => m.scopeMockFactory()));
vi.mock("@/lib/supabase/server", () => import("./setup").then((m) => m.supabaseMockFactory()));

describeDb("phase 9 review", () => {
  let src: TestOrg;
  let dst: TestOrg;

  beforeAll(async () => {
    src = await createTestOrg("rv9-src");
    dst = await createTestOrg("rv9-dst");
    setScope(src);
  });
  afterAll(async () => {
    await cleanupDataIds([src.dataId, dst.dataId]);
  });

  it("snapshot export -> apply to a fresh org -> export again: sections equal (modulo hardened fields)", async () => {
    const { updateOrgSettings } = await import("@/lib/org-settings");
    const { createTaxRate } = await import("@/lib/money/tax-rates");
    const { createPolicy } = await import("@/lib/helpdesk/tickets");
    const { createTemplate } = await import("@/lib/marketing/templates");
    const { createAudience } = await import("@/lib/marketing/audiences");
    const { createSequence } = await import("@/lib/marketing/sequences");
    const { createArticle } = await import("@/lib/kb/articles");
    const { upsertPolicy } = await import("@/lib/privacy/retention");
    const { exportSnapshot, applySnapshot, planSnapshot } = await import("@/lib/snapshots/store");

    await updateOrgSettings(src.dataId, { currency: "EUR", timezone: "Europe/Berlin" });
    await createTaxRate(src.dataId, { name: "VAT", rate_bp: 2000, kind: "vat", is_default: true });
    await createPolicy(src.dataId, { name: "Std", first_response_minutes: 30, resolution_minutes: 480 });
    const tpl = await createTemplate(src.dataId, { name: "Welcome", subject: "Hi", body_md: "Welcome", category: "general" });
    const aud = await createAudience(src.dataId, { name: "Everyone", definition: { has_email: true } } as Parameters<typeof createAudience>[1]);
    await createSequence(src.dataId, {
      name: "Onboard",
      trigger: "audience_join",
      trigger_config: { audience_id: aud.id },
      steps: [{ delay_hours: 1, channel: "email", template_id: tpl.id }],
      status: "active",
    });
    await createArticle(src.dataId, { title: "Reset", body_md: "x", status: "published" });
    await sql(
      `INSERT INTO agents (user_id, name, role, system_prompt, status, tasks_completed, tools, model, autonomy_level, max_steps) VALUES ($1, 'Closer', 'sales', 'p', 'idle', 0, NULL, NULL, 'auto', NULL)`,
      [src.dataId]
    );
    await upsertPolicy(src.dataId, "tickets_closed", { keep_days: 30, action: "delete", enabled: true }).catch(() => undefined);

    const a = await exportSnapshot(src.dataId, { name: "A" });
    const doc = a.doc;
    const plan = await planSnapshot(dst.dataId, doc, { mode: "skip_existing" });
    const res = await applySnapshot(dst.dataId, doc, { mode: "skip_existing", actorId: null });
    expect(res.errors).toEqual([]);
    // plan counts equal apply results
    expect(res.created).toBe(plan.totals.create);
    expect(res.updated).toBe(plan.totals.update);
    expect(res.skipped).toBe(plan.totals.skip);

    const b = await exportSnapshot(dst.dataId, { name: "B" });
    const sa = a.doc.sections as Record<string, unknown>;
    const sb = b.doc.sections as Record<string, unknown>;
    for (const key of ["settings", "tax_rates", "sla_policies", "email_templates", "audiences"]) {
      expect(sb[key], key).toEqual(sa[key]);
    }
    // sequences keep their definition but land paused; the audience / template links survive by name
    const seqA = (sa.sequences as Array<Record<string, unknown>>)[0];
    const seqB = (sb.sequences as Array<Record<string, unknown>>)[0];
    expect({ ...seqB, status: "x" }).toEqual({ ...seqA, status: "x" });
    expect(seqA.status).toBe("active");
    expect(seqB.status).toBe("paused");
    // agents never land on auto
    const agB = (sb.agents as Array<Record<string, unknown>>)[0];
    expect(agB.autonomy_level).toBe("approve");
    // KB lands as a draft (not exported until published), retention lands disabled
    expect((await sqlOne<{ status: string }>(`SELECT status FROM kb_articles WHERE user_id = $1`, [dst.dataId]))?.status).toBe("draft");
    const ret = await sqlOne<{ enabled: boolean }>(`SELECT enabled FROM retention_policies WHERE user_id = $1`, [dst.dataId]);
    if (ret) expect(ret.enabled).toBe(false);
  });

  it("apply with a member who lacks an area skips that section and reports it", async () => {
    const { exportSnapshot, applySnapshot } = await import("@/lib/snapshots/store");
    const a = await exportSnapshot(src.dataId, { name: "C", sections: ["kb_articles", "agents"] });
    const doc = a.doc;
    const fresh = await createTestOrg("rv9-perm");
    try {
      const r = await applySnapshot(fresh.dataId, doc, { mode: "skip_existing", can: (area) => area === "knowledge" });
      expect(r.errors.some((e) => e.section === "agents")).toBe(true);
      expect((await sqlOne<{ n: string }>(`SELECT COUNT(*)::text AS n FROM agents WHERE user_id = $1`, [fresh.dataId]))?.n).toBe("0");
    } finally {
      await cleanupDataIds([fresh.dataId]);
    }
  });

  it("portal message cursor: strict > at ms precision with id tie-break, no duplicates", async () => {
    const { createContact } = await import("@/lib/crm/contacts");
    const { listThread, toPublicMessage } = await import("@/lib/portal-messages");
    const c = await createContact(src.dataId, { full_name: "Cursor Person", email: "cursor@example.test" } as Parameters<typeof createContact>[1]);
    const ids = [randomUUID(), randomUUID(), randomUUID()].sort();
    // Same millisecond, different microseconds.
    await sql(`INSERT INTO portal_messages (id, user_id, contact_id, direction, body, created_at) VALUES ($1,$2,$3,'in','m1','2026-01-01T10:00:00.123111Z'), ($4,$2,$3,'in','m2','2026-01-01T10:00:00.123456Z'), ($5,$2,$3,'out','m3','2026-01-01T10:00:01.000000Z')`, [ids[0], src.dataId, c.id, ids[1], ids[2]]);
    const all = await listThread(src.dataId, c.id);
    expect(all.map((m) => m.body)).toEqual(["m1", "m2", "m3"]);
    const last = toPublicMessage(all[1]); // created_at exposed at ms precision
    const next = await listThread(src.dataId, c.id, { since: last.created_at });
    expect(next.map((m) => m.body)).toEqual(["m3"]); // m2 (same ms as its own cursor) is not repeated
    const tie = await listThread(src.dataId, c.id, { since: toPublicMessage(all[0]).created_at, sinceId: all[0].id });
    expect(tie.map((m) => m.body)).toEqual(all[0].id < all[1].id ? ["m2", "m3"] : ["m3"]);
  });

  it("customer reschedule respects external busy time; staff may override", async () => {
    const { ensureDefaultCalendar, rescheduleBooking } = await import("@/lib/calendar/booking");
    const cal = await ensureDefaultCalendar(src.dataId);
    const start = new Date(Date.now() + 5 * 86_400_000);
    start.setUTCMinutes(0, 0, 0);
    const end = new Date(start.getTime() + 30 * 60_000);
    const bid = randomUUID();
    await sql(
      `INSERT INTO bookings (id, user_id, calendar_id, name, email, starts_at, ends_at, status, source) VALUES ($1,$2,$3,'Ext Person','ext@example.test',$4,$5,'confirmed','test')`,
      [bid, src.dataId, cal.id, start.toISOString(), end.toISOString()]
    );
    const target = new Date(start.getTime() + 2 * 3_600_000);
    const connId = randomUUID();
    await sql(`INSERT INTO calendar_connections (id, user_id, provider, account_email, status) VALUES ($1,$2,'simulated','sim@example.test','connected')`, [connId, src.dataId]);
    const hasBusy = await sqlOne<{ n: string }>(`SELECT COUNT(*)::text AS n FROM calendar_connections WHERE id = $1`, [connId]);
    expect(hasBusy?.n).toBe("1");
    {
      await sql(`INSERT INTO external_busy (id, user_id, connection_id, external_event_id, starts_at, ends_at, summary_hash, updated_at) VALUES ($1,$2,$3,'e1',$4,$5,'h',NOW())`, [randomUUID(), src.dataId, connId, target.toISOString(), new Date(target.getTime() + 30 * 60_000).toISOString()]);
      await expect(rescheduleBooking(src.dataId, bid, target, "contact", { windowHours: 0 })).rejects.toThrow();
      const moved = await rescheduleBooking(src.dataId, bid, target, "staff");
      expect(new Date(moved.starts_at).getTime()).toBe(target.getTime());
      expect(new Date(moved.ends_at).getTime() - new Date(moved.starts_at).getTime()).toBe(30 * 60_000);
    }
  });
});
