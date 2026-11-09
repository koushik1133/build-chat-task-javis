/**
 * Workforce end-to-end: staff → shifts → conflict 409 → publish (event +
 * outbox) → swap → leave with balance (409 when short, debit on approve) →
 * crew link with staff_id → clock in/out → attendance → payroll CSV → v1.
 */
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { api, cleanupDataIds, createTestOrg, describeDb, expectEvent, setScope, sql, sqlOne, type TestOrg } from "./setup";
import type { AttendanceDTO, BalanceDTO, LeaveDTO, ShiftDTO, StaffDTO, SwapDTO } from "@/lib/workforce/pure";

vi.mock("@/lib/auth/scope", () => import("./setup").then((m) => m.scopeMockFactory()));
vi.mock("@/lib/supabase/server", () => import("./setup").then((m) => m.supabaseMockFactory()));

type Env<T> = { data: T; meta?: { next_cursor: string | null } };

describeDb("workforce flow", () => {
  let org: TestOrg;
  let ana: StaffDTO;
  let ben: StaffDTO;
  let draft: ShiftDTO;
  let second: ShiftDTO;
  // Next week's Monday (1–7 days out): inside the crew link's 14-day window, clear of "today" logic.
  const base = new Date();
  base.setUTCDate(base.getUTCDate() + 7 - ((base.getUTCDay() + 6) % 7));
  const monday = base.toISOString().slice(0, 10);
  const at = (day: string, hm: string) => `${day}T${hm}:00.000Z`;
  const plusDays = (ymd: string, n: number) => new Date(Date.parse(`${ymd}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
  const tue = plusDays(monday, 1);
  const wed = plusDays(monday, 2);
  const thu = plusDays(monday, 3);

  beforeAll(async () => {
    org = await createTestOrg("workforce");
    setScope(org);
  });
  afterAll(async () => {
    await cleanupDataIds([org.dataId]);
  });

  it("creates staff profiles (validation, 401 when signed out)", async () => {
    const staffRoute = await import("@/app/api/workforce/staff/route");
    setScope(null);
    await api(staffRoute.GET, "/api/workforce/staff", { expect: 401 });
    setScope(org);
    await api(staffRoute.POST, "/api/workforce/staff", { json: { display_name: "" }, expect: 400 });
    await api(staffRoute.POST, "/api/workforce/staff", { json: { display_name: "X", bogus: 1 }, expect: 400 });
    const a = await api<{ staff: StaffDTO }>(staffRoute.POST, "/api/workforce/staff", {
      json: { display_name: "Ana Tech", email: "ANA@example.test", role_title: "Technician", hourly_rate_minor: 2000, weekly_hours: 40, skills: ["hvac"] },
      expect: 201,
    });
    ana = a.body.staff;
    expect(ana.email).toBe("ana@example.test");
    expect(ana.skills).toEqual(["hvac"]);
    const b = await api<{ staff: StaffDTO }>(staffRoute.POST, "/api/workforce/staff", { json: { display_name: "Ben Crew", employment_type: "part_time", hourly_rate_minor: 1500, weekly_hours: 20 }, expect: 201 });
    ben = b.body.staff;
    const list = await api<{ staff: StaffDTO[] }>(staffRoute.GET, "/api/workforce/staff", { expect: 200 });
    expect(list.body.staff.map((s) => s.id).sort()).toEqual([ana.id, ben.id].sort());

    const one = await import("@/app/api/workforce/staff/[id]/route");
    const patched = await api<{ staff: StaffDTO }>(one.PATCH, `/api/workforce/staff/${ben.id}`, { method: "PATCH", json: { location: "Depot" }, params: { id: ben.id }, expect: 200 });
    expect(patched.body.staff.location).toBe("Depot");
    await api(one.PATCH, `/api/workforce/staff/${ben.id}`, { method: "PATCH", json: { membership_id: "nope" }, params: { id: ben.id }, expect: 400 });
    // viewer cannot see the team area at all
    setScope(org, { role: "viewer", userId: "itest-viewer" });
    await api(staffRoute.GET, "/api/workforce/staff", { expect: 403 });
    setScope(org, { role: "member", userId: "itest-member" });
    await api(staffRoute.POST, "/api/workforce/staff", { json: { display_name: "Nope" }, expect: 403 });
    setScope(org);
  });

  it("shifts: create draft, 409 on overlap, week view buckets, publish emits event + outbox", async () => {
    const shifts = await import("@/app/api/workforce/shifts/route");
    await api(shifts.POST, "/api/workforce/shifts", { json: { staff_id: ana.id, starts_at: at(monday, "17:00"), ends_at: at(monday, "09:00") }, expect: 400 });
    await api(shifts.POST, "/api/workforce/shifts", { json: { staff_id: "ghost", starts_at: at(monday, "09:00"), ends_at: at(monday, "17:00") }, expect: 400 });
    const d = await api<{ shift: ShiftDTO }>(shifts.POST, "/api/workforce/shifts", {
      json: { staff_id: ana.id, role_title: "Technician", starts_at: at(monday, "09:00"), ends_at: at(monday, "17:00"), break_minutes: 30 },
      expect: 201,
    });
    draft = d.body.shift;
    expect(draft.status).toBe("draft");
    expect(draft.minutes).toBe(450);
    expect(draft.staff_name).toBe("Ana Tech");

    // Overlap for the same person → 409 with details.
    const conflict = await api<{ error: string; conflicts: Array<{ kind: string; shift_id?: string }> }>(shifts.POST, "/api/workforce/shifts", {
      json: { staff_id: ana.id, starts_at: at(monday, "12:00"), ends_at: at(monday, "20:00") },
      expect: 409,
    });
    expect(conflict.body.error).toBe("conflict");
    expect(conflict.body.conflicts[0]).toMatchObject({ kind: "shift_overlap", shift_id: draft.id });
    // Same window, different person → fine. Open shift → fine.
    second = (await api<{ shift: ShiftDTO }>(shifts.POST, "/api/workforce/shifts", { json: { staff_id: ben.id, starts_at: at(tue, "10:00"), ends_at: at(tue, "14:00") }, expect: 201 })).body.shift;
    const open = (await api<{ shift: ShiftDTO }>(shifts.POST, "/api/workforce/shifts", { json: { staff_id: null, starts_at: at(monday, "12:00"), ends_at: at(monday, "20:00"), role_title: "Cover" }, expect: 201 })).body.shift;
    expect(open.staff_id).toBeNull();

    const week = await api<{ weekStart: string; days: string[]; byDay: Record<string, ShiftDTO[]>; minutesByStaff: Record<string, number>; openShifts: number; draftCount: number; swaps: SwapDTO[] }>(
      shifts.GET,
      "/api/workforce/shifts",
      { query: { week: wed }, expect: 200 }
    );
    expect(week.body.weekStart).toBe(monday);
    expect(week.body.days).toHaveLength(7);
    expect(week.body.byDay[monday].map((s) => s.id).sort()).toEqual([draft.id, open.id].sort());
    expect(week.body.byDay[tue].map((s) => s.id)).toEqual([second.id]);
    expect(week.body.minutesByStaff[ana.id]).toBe(450);
    expect(week.body.openShifts).toBe(1);
    expect(week.body.draftCount).toBe(3);

    // Edit moves the shift; conflict check excludes itself.
    const one = await import("@/app/api/workforce/shifts/[id]/route");
    const moved = await api<{ shift: ShiftDTO }>(one.PATCH, `/api/workforce/shifts/${draft.id}`, { method: "PATCH", json: { starts_at: at(monday, "08:00") }, params: { id: draft.id }, expect: 200 });
    expect(moved.body.shift.starts_at).toBe(at(monday, "08:00"));

    // Publish: only drafts flip; event + outbox email to Ana.
    const publish = await import("@/app/api/workforce/shifts/publish/route");
    const p = await api<{ published: ShiftDTO[]; skipped: string[] }>(publish.POST, "/api/workforce/shifts/publish", { json: { ids: [draft.id, second.id, "missing"] }, expect: 200 });
    expect(p.body.published.map((s) => s.id).sort()).toEqual([draft.id, second.id].sort());
    expect(p.body.skipped).toEqual(["missing"]);
    await expectEvent(org.dataId, "shift.published", draft.id);
    const mail = await sqlOne<{ recipient: string; subject: string }>(`SELECT recipient, subject FROM notification_outbox WHERE user_id = $1 AND channel = 'email' AND recipient = 'ana@example.test' ORDER BY created_at DESC LIMIT 1`, [org.dataId]);
    expect(mail?.subject).toMatch(/shift/i);
    const again = await api<{ published: ShiftDTO[]; skipped: string[] }>(publish.POST, "/api/workforce/shifts/publish", { json: { ids: [draft.id] }, expect: 200 });
    expect(again.body.published).toHaveLength(0);

    // Deleting a published shift cancels it instead.
    const del = await api<{ deleted: boolean; cancelled: boolean }>(one.DELETE, `/api/workforce/shifts/${open.id}`, { method: "DELETE", params: { id: open.id }, expect: 200 });
    expect(del.body.deleted).toBe(true); // was still a draft
  });

  it("swap: request → 409 on duplicate → approve re-assigns and marks swapped", async () => {
    const swap = await import("@/app/api/workforce/shifts/[id]/swap/route");
    await api(swap.POST, `/api/workforce/shifts/${draft.id}/swap`, { json: { to_staff_id: ana.id }, params: { id: draft.id }, expect: 400 });
    const r = await api<{ swap: SwapDTO }>(swap.POST, `/api/workforce/shifts/${draft.id}/swap`, { json: { to_staff_id: ben.id, note: "Dentist" }, params: { id: draft.id }, expect: 201 });
    expect(r.body.swap).toMatchObject({ status: "requested", from_staff_id: ana.id, to_staff_id: ben.id, from_staff_name: "Ana Tech" });
    await expectEvent(org.dataId, "shift.swap_requested", r.body.swap.id);
    await api(swap.POST, `/api/workforce/shifts/${draft.id}/swap`, { json: { to_staff_id: ben.id }, params: { id: draft.id }, expect: 409 });

    const shifts = await import("@/app/api/workforce/shifts/route");
    const week = await api<{ pendingSwaps: number; swaps: SwapDTO[] }>(shifts.GET, "/api/workforce/shifts", { query: { week: monday }, expect: 200 });
    expect(week.body.pendingSwaps).toBe(1);
    expect(week.body.swaps[0].id).toBe(r.body.swap.id);

    const decide = await import("@/app/api/workforce/shifts/swaps/[id]/route");
    const ok = await api<{ swap: SwapDTO }>(decide.PATCH, `/api/workforce/shifts/swaps/${r.body.swap.id}`, { method: "PATCH", json: { decision: "approve" }, params: { id: r.body.swap.id }, expect: 200 });
    expect(ok.body.swap.status).toBe("approved");
    await api(decide.PATCH, `/api/workforce/shifts/swaps/${r.body.swap.id}`, { method: "PATCH", json: { decision: "reject" }, params: { id: r.body.swap.id }, expect: 409 });
    const row = await sqlOne<{ staff_id: string; status: string }>(`SELECT staff_id, status FROM shifts WHERE id = $1`, [draft.id]);
    expect(row).toEqual({ staff_id: ben.id, status: "swapped" });
  });

  it("leave: balance cap (409), approve debits race-safely, approved leave blocks a shift, cancel credits back", async () => {
    const balances = await import("@/app/api/workforce/balances/route");
    const year = Number(thu.slice(0, 4));
    const b = await api<{ balance: BalanceDTO }>(balances.PUT, "/api/workforce/balances", { method: "PUT", json: { staff_id: ana.id, kind: "vacation", year, allotted_hours: 16 }, expect: 200 });
    expect(b.body.balance).toMatchObject({ allotted_hours: 16, used_hours: 0, remaining_hours: 16 });

    const leave = await import("@/app/api/workforce/leave/route");
    // 24h requested against 16h allotted → 409
    const short = await api<{ error: string; remaining_hours: number }>(leave.POST, "/api/workforce/leave", { json: { staff_id: ana.id, kind: "vacation", starts_on: thu, ends_on: thu, hours: 24 }, expect: 409 });
    expect(short.body).toMatchObject({ error: "conflict", remaining_hours: 16 });
    // default hours = weekdays × 8 → 8h for a single weekday
    const req = await api<{ leave: LeaveDTO }>(leave.POST, "/api/workforce/leave", { json: { staff_id: ana.id, kind: "vacation", starts_on: thu, ends_on: thu }, expect: 201 });
    expect(req.body.leave).toMatchObject({ status: "pending", hours: 8, staff_name: "Ana Tech" });
    await expectEvent(org.dataId, "leave.requested", req.body.leave.id);
    // overlapping dates for the same person → 409
    await api(leave.POST, "/api/workforce/leave", { json: { staff_id: ana.id, kind: "sick", starts_on: thu, ends_on: plusDays(thu, 1) }, expect: 409 });
    // pending hours count against the cap: 8 left, asking 16 → 409
    await api(leave.POST, "/api/workforce/leave", { json: { staff_id: ana.id, kind: "vacation", starts_on: plusDays(thu, 7), ends_on: plusDays(thu, 8), hours: 16 }, expect: 409 });

    const decide = await import("@/app/api/workforce/leave/[id]/route");
    const approved = await api<{ leave: LeaveDTO }>(decide.PATCH, `/api/workforce/leave/${req.body.leave.id}`, { method: "PATCH", json: { decision: "approve" }, params: { id: req.body.leave.id }, expect: 200 });
    expect(approved.body.leave.status).toBe("approved");
    expect(approved.body.leave.decided_by).toBe(org.userId);
    await expectEvent(org.dataId, "leave.decided", req.body.leave.id);
    const bal = await sqlOne<{ used_hours: number }>(`SELECT used_hours FROM leave_balances WHERE user_id = $1 AND staff_id = $2 AND kind = 'vacation' AND year = $3`, [org.dataId, ana.id, year]);
    expect(Number(bal?.used_hours)).toBe(8);
    await api(decide.PATCH, `/api/workforce/leave/${req.body.leave.id}`, { method: "PATCH", json: { decision: "approve" }, params: { id: req.body.leave.id }, expect: 409 });

    // Shift on an approved leave day → 409 on_leave
    const shifts = await import("@/app/api/workforce/shifts/route");
    const blocked = await api<{ conflicts: Array<{ kind: string; leave_id: string }> }>(shifts.POST, "/api/workforce/shifts", { json: { staff_id: ana.id, starts_at: at(thu, "09:00"), ends_at: at(thu, "12:00") }, expect: 409 });
    expect(blocked.body.conflicts[0]).toMatchObject({ kind: "on_leave", leave_id: req.body.leave.id });

    // Approve a second 8h request to exhaust the balance; a third must fail at approval even if requested earlier.
    const r2 = await api<{ leave: LeaveDTO }>(leave.POST, "/api/workforce/leave", { json: { staff_id: ana.id, kind: "vacation", starts_on: plusDays(thu, 7), ends_on: plusDays(thu, 7) }, expect: 201 });
    await sql(`UPDATE leave_balances SET used_hours = 12 WHERE user_id = $1 AND staff_id = $2 AND kind = 'vacation' AND year = $3`, [org.dataId, ana.id, year]); // simulate a concurrent debit
    const denied = await api<{ error: string }>(decide.PATCH, `/api/workforce/leave/${r2.body.leave.id}`, { method: "PATCH", json: { decision: "approve" }, params: { id: r2.body.leave.id }, expect: 409 });
    expect(denied.body.error).toBe("conflict");
    expect((await sqlOne<{ status: string }>(`SELECT status FROM leave_requests WHERE id = $1`, [r2.body.leave.id]))?.status).toBe("pending");
    await sql(`UPDATE leave_balances SET used_hours = 8 WHERE user_id = $1 AND staff_id = $2 AND kind = 'vacation' AND year = $3`, [org.dataId, ana.id, year]);
    await api(decide.PATCH, `/api/workforce/leave/${r2.body.leave.id}`, { method: "PATCH", json: { decision: "reject" }, params: { id: r2.body.leave.id }, expect: 200 });

    // Cancel the approved one → hours credited back.
    await api(decide.PATCH, `/api/workforce/leave/${req.body.leave.id}`, { method: "PATCH", json: { decision: "cancel" }, params: { id: req.body.leave.id }, expect: 200 });
    const after = await api<{ balances: BalanceDTO[] }>(balances.GET, "/api/workforce/balances", { query: { year, staff_id: ana.id }, expect: 200 });
    expect(after.body.balances[0]).toMatchObject({ used_hours: 0, remaining_hours: 16 });
    const pending = await api<{ leave: LeaveDTO[] }>(leave.GET, "/api/workforce/leave", { query: { status: "pending" }, expect: 200 });
    expect(pending.body.leave).toHaveLength(0);
  });

  it("crew link with staff_id → shifts visible, clock in/out writes attendance + time_entries.staff_id, leave via crew", async () => {
    const links = await import("@/app/api/team/crew-links/route");
    await api(links.POST, "/api/team/crew-links", { json: { label: "Bad", staff_id: "ghost" }, expect: 400 });
    const c = await api<{ id: string; url: string; staffId: string }>(links.POST, "/api/team/crew-links", { json: { label: "Ben's phone", staff_id: ben.id, expiresDays: 7 }, expect: 201 });
    expect(c.body.staffId).toBe(ben.id);
    const token = c.body.url.split("/m/")[1];
    expect((await sqlOne<{ staff_id: string }>(`SELECT staff_id FROM share_tokens WHERE id = $1`, [c.body.id]))?.staff_id).toBe(ben.id);

    setScope(null); // crew routes are token-authenticated
    const crew = await import("@/app/api/m/[token]/route");
    const day = await api<{ staff: { id: string; name: string } | null; upcomingShifts: Array<{ id: string }>; clockedInAt: string | null; timeTracking: boolean }>(crew.GET, `/api/m/${token}`, { query: { tz: "UTC" }, params: { token }, expect: 200 });
    expect(day.body.staff).toEqual({ id: ben.id, name: "Ben Crew" });
    expect(day.body.timeTracking).toBe(true);
    // Ben owns `second` (published, Tue) and the swapped `draft` (Mon) — both within 14 days.
    expect(day.body.upcomingShifts.map((s) => s.id).sort()).toEqual([draft.id, second.id].sort());

    const cin = await api<{ ok: boolean; startedAt: string }>(crew.POST, `/api/m/${token}`, { json: { action: "clock_in" }, params: { token }, expect: 200 });
    expect(cin.body.ok).toBe(true);
    await api(crew.POST, `/api/m/${token}`, { json: { action: "clock_in" }, params: { token }, expect: 409 });
    const open = await sqlOne<{ id: string; source: string; clock_out: string | null }>(`SELECT id, source, clock_out FROM attendance WHERE user_id = $1 AND staff_id = $2`, [org.dataId, ben.id]);
    expect(open).toMatchObject({ source: "crew", clock_out: null });
    expect((await sqlOne<{ staff_id: string }>(`SELECT staff_id FROM time_entries WHERE user_id = $1 AND ref_kind = 'crew' AND ref_id = $2`, [org.dataId, c.body.id]))?.staff_id).toBe(ben.id);
    const mid = await api<{ clockedInAt: string | null }>(crew.GET, `/api/m/${token}`, { query: { tz: "UTC" }, params: { token }, expect: 200 });
    expect(mid.body.clockedInAt).toBeTruthy();
    await sql(`UPDATE attendance SET clock_in = NOW() - INTERVAL '90 minutes' WHERE id = $1`, [open?.id]);
    const cout = await api<{ ok: boolean }>(crew.POST, `/api/m/${token}`, { json: { action: "clock_out" }, params: { token }, expect: 200 });
    expect(cout.body.ok).toBe(true);
    await api(crew.POST, `/api/m/${token}`, { json: { action: "clock_out" }, params: { token }, expect: 409 });
    const closed = await sqlOne<{ minutes: number }>(`SELECT minutes FROM attendance WHERE id = $1`, [open?.id]);
    expect(Number(closed?.minutes)).toBeGreaterThanOrEqual(89);

    // Self-service leave request through the crew link.
    const lr = await api<{ ok: boolean; leave: LeaveDTO }>(crew.POST, `/api/m/${token}`, { json: { action: "request_leave", kind: "unpaid", starts_on: plusDays(thu, 14), ends_on: plusDays(thu, 14) }, params: { token }, expect: 200 });
    expect(lr.body.leave).toMatchObject({ staff_id: ben.id, kind: "unpaid", status: "pending", hours: 4 });
    const pend = await api<{ pendingLeave: number }>(crew.GET, `/api/m/${token}`, { query: { tz: "UTC" }, params: { token }, expect: 200 });
    expect(pend.body.pendingLeave).toBe(1);
    // SEC: crew leave is bounded — no impossible dates, no multi-year blocks.
    await api(crew.POST, `/api/m/${token}`, { json: { action: "request_leave", kind: "unpaid", starts_on: "2026-99-99", ends_on: "2026-99-99" }, params: { token }, expect: 400 });
    await api(crew.POST, `/api/m/${token}`, { json: { action: "request_leave", kind: "unpaid", starts_on: plusDays(thu, 30), ends_on: "9999-12-31" }, params: { token }, expect: 400 });
    expect((await api<{ pendingLeave: number }>(crew.GET, `/api/m/${token}`, { query: { tz: "UTC" }, params: { token }, expect: 200 })).body.pendingLeave).toBe(1);
    setScope(org);
  });

  it("attendance list shows variance against the scheduled shift; manual entries", async () => {
    setScope(org);
    const attendance = await import("@/app/api/workforce/attendance/route");
    const manual = await api<{ attendance: AttendanceDTO }>(attendance.POST, "/api/workforce/attendance", {
      json: { staff_id: ben.id, clock_in: at(tue, "10:05"), clock_out: at(tue, "13:30") },
      expect: 201,
    });
    // matched to Ben's Tue 10–14 shift (240 scheduled) → 205 worked → −35
    expect(manual.body.attendance).toMatchObject({ shift_id: second.id, minutes: 205, scheduled_minutes: 240, variance_minutes: -35, source: "manual" });
    await api(attendance.POST, "/api/workforce/attendance", { json: { staff_id: ben.id, clock_in: at(tue, "10:05"), clock_out: at(tue, "09:30") }, expect: 400 });
    // SEC: a supplied shift_id must be a shift of this org for this staff member (ana's shift cannot be pinned to ben).
    await api(attendance.POST, "/api/workforce/attendance", { json: { staff_id: ana.id, shift_id: second.id, clock_in: at(tue, "09:00"), clock_out: at(tue, "12:00") }, expect: 400 });
    await api(attendance.POST, "/api/workforce/attendance", { json: { staff_id: ben.id, shift_id: "00000000-0000-4000-8000-000000000000", clock_in: at(tue, "09:00"), clock_out: at(tue, "12:00") }, expect: 400 });
    const list = await api<{ attendance: AttendanceDTO[] }>(attendance.GET, "/api/workforce/attendance", { query: { from: at(tue, "00:00"), to: at(wed, "00:00") }, expect: 200 });
    expect(list.body.attendance.map((a) => a.id)).toEqual([manual.body.attendance.id]);
  });

  it("payroll: scheduled vs attended, overtime, CSV download", async () => {
    setScope(org);
    // Give Ana 45h attended in the week on top of her 8.5h scheduled (so overtime shows at 40h/week).
    const attendance = await import("@/app/api/workforce/attendance/route");
    for (let i = 0; i < 5; i++) {
      await api(attendance.POST, "/api/workforce/attendance", { json: { staff_id: ana.id, shift_id: null, clock_in: at(plusDays(monday, i), "07:00"), clock_out: at(plusDays(monday, i), "16:00") }, expect: 201 });
    }
    const payroll = await import("@/app/api/workforce/payroll/route");
    const sunday = plusDays(monday, 6);
    await api(payroll.GET, "/api/workforce/payroll", { query: { from: "bad", to: sunday }, expect: 400 });
    const p = await api<{ weeks: number; lines: Array<{ staff_id: string; attended_hours: number; overtime_hours: number; scheduled_hours: number; gross_minor: number; currency: string }>; totals: { gross_by_currency: Record<string, number> } }>(payroll.GET, "/api/workforce/payroll", {
      query: { from: monday, to: sunday },
      expect: 200,
    });
    expect(p.body.weeks).toBe(1);
    const anaLine = p.body.lines.find((l) => l.staff_id === ana.id)!;
    const benLine = p.body.lines.find((l) => l.staff_id === ben.id)!;
    expect(anaLine.attended_hours).toBe(45);
    expect(anaLine.overtime_hours).toBe(5);
    // 40h × $20 + 5h × $30 = $950
    expect(anaLine.gross_minor).toBe(95_000);
    expect(anaLine.scheduled_hours).toBe(0); // her Monday shift was swapped to Ben
    expect(benLine.scheduled_hours).toBe(12.5); // 8.5h (swapped Mon 08–17 less 30m) + 4h Tue
    expect(benLine.attended_hours).toBeCloseTo(205 / 60, 1); // the crew clock-in above happened this week, outside the payroll range
    expect(p.body.totals.gross_by_currency.USD).toBe(anaLine.gross_minor + benLine.gross_minor);

    const csv = await api<string>(payroll.GET, "/api/workforce/payroll", { query: { from: monday, to: sunday, format: "csv" }, expect: 200 });
    expect(csv.res.headers.get("content-type")).toContain("text/csv");
    expect(csv.res.headers.get("content-disposition")).toContain(`payroll-${monday}-to-${sunday}.csv`);
    const text = String(csv.body);
    expect(text).toContain("Staff ID,Name,Role,Employment,Currency,Hourly rate,Weekly hours,Scheduled hours,Attended hours");
    expect(text).toContain("Ana Tech");
    expect(text).toContain("950.00");
  });

  it("v1: staff/shifts/leave list+get+create with scopes, 409 on conflict", async () => {
    setScope(org);
    const keys = await import("@/app/api/api-keys/route");
    const full = await api<{ key: string }>(keys.POST, "/api/api-keys", { json: { name: "workforce", scopes: ["write:team"] }, expect: 201 });
    const ro = await api<{ key: string }>(keys.POST, "/api/api-keys", { json: { name: "crm only", scopes: ["read:crm"] }, expect: 201 });
    const bearer = (k: string) => ({ authorization: `Bearer ${k}` });

    const staffV1 = await import("@/app/api/v1/staff/route");
    await api(staffV1.GET, "/api/v1/staff", { headers: bearer(ro.body.key), expect: 403 });
    const list = await api<Env<StaffDTO[]>>(staffV1.GET, "/api/v1/staff", { headers: bearer(full.body.key), expect: 200 });
    expect(list.body.data.map((s) => s.id).sort()).toEqual([ana.id, ben.id].sort());
    const created = await api<Env<StaffDTO>>(staffV1.POST, "/api/v1/staff", { headers: bearer(full.body.key), json: { display_name: "Cara API", weekly_hours: 30 }, expect: 201 });
    expect(created.body.data.display_name).toBe("Cara API");
    const staffOne = await import("@/app/api/v1/staff/[id]/route");
    const got = await api<Env<StaffDTO>>(staffOne.GET, `/api/v1/staff/${created.body.data.id}`, { headers: bearer(full.body.key), params: { id: created.body.data.id }, expect: 200 });
    expect(got.body.data.id).toBe(created.body.data.id);
    await api(staffOne.GET, "/api/v1/staff/nope", { headers: bearer(full.body.key), params: { id: "nope" }, expect: 404 });

    const shiftsV1 = await import("@/app/api/v1/shifts/route");
    const s = await api<Env<ShiftDTO>>(shiftsV1.POST, "/api/v1/shifts", { headers: bearer(full.body.key), json: { staff_id: created.body.data.id, starts_at: at(wed, "09:00"), ends_at: at(wed, "13:00"), publish: true }, expect: 201 });
    expect(s.body.data.status).toBe("published");
    const conflict = await api<{ error: { code: string } }>(shiftsV1.POST, "/api/v1/shifts", { headers: bearer(full.body.key), json: { staff_id: created.body.data.id, starts_at: at(wed, "10:00"), ends_at: at(wed, "11:00") }, expect: 409 });
    expect(conflict.body.error.code).toBe("conflict");
    const sl = await api<Env<ShiftDTO[]>>(shiftsV1.GET, "/api/v1/shifts", { headers: bearer(full.body.key), query: { staff_id: created.body.data.id }, expect: 200 });
    expect(sl.body.data.map((x) => x.id)).toEqual([s.body.data.id]);
    const shiftOne = await import("@/app/api/v1/shifts/[id]/route");
    expect((await api<Env<ShiftDTO>>(shiftOne.GET, `/api/v1/shifts/${s.body.data.id}`, { headers: bearer(full.body.key), params: { id: s.body.data.id }, expect: 200 })).body.data.minutes).toBe(240);

    const leaveV1 = await import("@/app/api/v1/leave/route");
    const l = await api<Env<LeaveDTO>>(leaveV1.POST, "/api/v1/leave", { headers: bearer(full.body.key), json: { staff_id: created.body.data.id, kind: "sick", starts_on: thu, ends_on: thu }, expect: 201 });
    expect(l.body.data).toMatchObject({ status: "pending", hours: 6 });
    const ll = await api<Env<LeaveDTO[]>>(leaveV1.GET, "/api/v1/leave", { headers: bearer(full.body.key), query: { status: "pending", staff_id: created.body.data.id }, expect: 200 });
    expect(ll.body.data.map((x) => x.id)).toEqual([l.body.data.id]);
    const leaveOne = await import("@/app/api/v1/leave/[id]/route");
    expect((await api<Env<LeaveDTO>>(leaveOne.GET, `/api/v1/leave/${l.body.data.id}`, { headers: bearer(full.body.key), params: { id: l.body.data.id }, expect: 200 })).body.data.kind).toBe("sick");
  });
});
