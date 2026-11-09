/**
 * Capacity planning — pure math, client-safe (no DB imports).
 *
 * Supply:  weekly available minutes from the calendar's availability rules
 *          × the number of people (members).
 * Demand:  confirmed bookings in each week, plus a baseline of logged time
 *          that is not tied to bookings (from the look-back weeks), which
 *          represents the unscheduled work that always shows up.
 * Output:  utilisation per week and per member, bottleneck weeks and a
 *          hiring / extra-hours suggestion.
 */
import { isoDate, weekStartUtc } from "./cashflow";

export interface CapacityBooking {
  id: string;
  status: string;
  starts_at: string;
  ends_at: string;
  member_id?: string | null;
}

export interface CapacityRule {
  weekday: number; // 0 = Sunday … 6 = Saturday
  start_minute: number;
  end_minute: number;
}

export interface CapacityMember {
  id: string;
  label: string;
}

export interface CapacityTimeEntry {
  id: string;
  member_id: string | null;
  started_at: string;
  minutes: number | null;
  ref_kind?: string | null;
}

/** A scheduled shift (workforce rota) used as real supply instead of the availability-rule estimate. */
export interface CapacityShift {
  id: string;
  member_id: string | null;
  starts_at: string;
  ends_at: string;
  /** Paid minutes (span minus break). */
  minutes: number;
}

export interface CapacityInputs {
  bookings: CapacityBooking[];
  availability: CapacityRule[];
  timeEntries: CapacityTimeEntry[];
  members: CapacityMember[];
  /**
   * Optional: when present and non-empty, weekly supply comes from the shifts
   * that fall in each week (per member when `member_id` matches) rather than
   * from `availability × people`. Weeks with no shifts keep the rule estimate
   * so an unpublished future week does not read as zero capacity.
   */
  shifts?: CapacityShift[];
}

export interface CapacityOptions {
  /** Future weeks to plan, 1–26. Default 8. */
  weeks?: number;
  /** Past weeks used for the baseline. Default 4. */
  lookbackWeeks?: number;
  /** Utilisation above which a week is a bottleneck. Default 0.85. */
  target?: number;
  now?: Date;
}

export interface CapacityWeek {
  weekStart: string;
  past: boolean;
  availableMinutes: number;
  bookedMinutes: number;
  loggedMinutes: number;
  /** For future weeks: booked + baseline; for past weeks: booked + logged. */
  demandMinutes: number;
  utilisation: number;
  bottleneck: boolean;
}

export interface MemberWeek {
  weekStart: string;
  availableMinutes: number;
  loggedMinutes: number;
  bookedMinutes: number;
  utilisation: number;
}

export interface MemberCapacity {
  id: string;
  label: string;
  weeks: MemberWeek[];
  avgUtilisation: number;
}

export interface CapacitySuggestion {
  kind: "ok" | "extra_hours" | "hire" | "underused" | "no_data";
  extraHoursPerWeek: number;
  hires: number;
  message: string;
}

export interface CapacityPlan {
  generatedAt: string;
  weeklyMinutesPerPerson: number;
  people: number;
  baselineLoggedMinutes: number;
  target: number;
  weeks: CapacityWeek[];
  members: MemberCapacity[];
  bottleneckWeeks: string[];
  suggestion: CapacitySuggestion;
}

const DAY_MS = 86_400_000;
const WEEK_MS = 7 * DAY_MS;

/** Minutes a single person is available per week according to the rules. */
export function weeklyMinutes(rules: CapacityRule[]): number {
  let total = 0;
  for (const r of rules) total += Math.max(0, Number(r.end_minute) - Number(r.start_minute));
  return total;
}

function overlapMinutes(aStart: number, aEnd: number, bStart: number, bEnd: number): number {
  const s = Math.max(aStart, bStart);
  const e = Math.min(aEnd, bEnd);
  return e > s ? (e - s) / 60_000 : 0;
}

export function capacityPlan(inputs: CapacityInputs, opts: CapacityOptions = {}): CapacityPlan {
  const now = opts.now ?? new Date();
  const horizon = Math.min(Math.max(Math.round(opts.weeks ?? 8), 1), 26);
  const lookback = Math.min(Math.max(Math.round(opts.lookbackWeeks ?? 4), 1), 12);
  const target = Math.min(Math.max(opts.target ?? 0.85, 0.3), 1);
  const thisWeek = weekStartUtc(now).getTime();
  const first = thisWeek - lookback * WEEK_MS;
  const total = lookback + horizon;

  const perPerson = weeklyMinutes(inputs.availability) || 40 * 60;
  const members = inputs.members.length > 0 ? inputs.members : [{ id: "__solo__", label: "You" }];
  const people = members.length;

  const weeks: CapacityWeek[] = Array.from({ length: total }, (_, i) => {
    const ws = first + i * WEEK_MS;
    return { weekStart: isoDate(new Date(ws)), past: ws < thisWeek, availableMinutes: perPerson * people, bookedMinutes: 0, loggedMinutes: 0, demandMinutes: 0, utilisation: 0, bottleneck: false };
  });
  const memberWeeks = new Map<string, MemberWeek[]>();
  for (const m of members) {
    memberWeeks.set(
      m.id,
      weeks.map((w) => ({ weekStart: w.weekStart, availableMinutes: perPerson, loggedMinutes: 0, bookedMinutes: 0, utilisation: 0 }))
    );
  }
  const idx = (t: number): number | null => {
    if (t < first || t >= first + total * WEEK_MS) return null;
    return Math.floor((t - first) / WEEK_MS);
  };

  // Shifts as supply: replace the rule estimate for any week that has at least one shift.
  if (inputs.shifts && inputs.shifts.length > 0) {
    const weekSupply = new Array<number>(total).fill(0);
    const memberSupply = new Map<string, number[]>();
    for (const sh of inputs.shifts) {
      const mins = Number(sh.minutes) || 0;
      if (mins <= 0) continue;
      const i = idx(new Date(sh.starts_at).getTime());
      if (i === null) continue;
      weekSupply[i] += mins;
      if (sh.member_id && memberWeeks.has(sh.member_id)) {
        const arr = memberSupply.get(sh.member_id) ?? new Array<number>(total).fill(0);
        arr[i] += mins;
        memberSupply.set(sh.member_id, arr);
      }
    }
    for (let i = 0; i < total; i++) {
      if (weekSupply[i] <= 0) continue;
      weeks[i].availableMinutes = Math.round(weekSupply[i]);
      for (const [mid, list] of memberWeeks) list[i].availableMinutes = Math.round(memberSupply.get(mid)?.[i] ?? 0);
    }
  }

  // Bookings: split across week boundaries.
  for (const b of inputs.bookings) {
    if (b.status !== "confirmed" && b.status !== "completed") continue;
    const s = new Date(b.starts_at).getTime();
    const e = new Date(b.ends_at).getTime();
    if (Number.isNaN(s) || Number.isNaN(e) || e <= s) continue;
    for (let i = 0; i < total; i++) {
      const ws = first + i * WEEK_MS;
      const m = overlapMinutes(s, e, ws, ws + WEEK_MS);
      if (m <= 0) continue;
      weeks[i].bookedMinutes += m;
      if (b.member_id && memberWeeks.has(b.member_id)) memberWeeks.get(b.member_id)![i].bookedMinutes += m;
    }
  }

  // Logged time (past weeks). Time against a booking is already counted as booked.
  for (const te of inputs.timeEntries) {
    const mins = Number(te.minutes) || 0;
    if (mins <= 0) continue;
    const i = idx(new Date(te.started_at).getTime());
    if (i === null || !weeks[i].past) continue;
    if (te.ref_kind === "booking") continue;
    weeks[i].loggedMinutes += mins;
    if (te.member_id && memberWeeks.has(te.member_id)) memberWeeks.get(te.member_id)![i].loggedMinutes += mins;
  }

  const pastWeeks = weeks.filter((w) => w.past);
  const baseline = pastWeeks.length ? Math.round(pastWeeks.reduce((s, w) => s + w.loggedMinutes, 0) / pastWeeks.length) : 0;

  const bottleneckWeeks: string[] = [];
  for (const w of weeks) {
    w.demandMinutes = Math.round(w.bookedMinutes + (w.past ? w.loggedMinutes : baseline));
    w.bookedMinutes = Math.round(w.bookedMinutes);
    w.utilisation = w.availableMinutes > 0 ? Math.round((w.demandMinutes / w.availableMinutes) * 1000) / 1000 : 0;
    w.bottleneck = w.utilisation > target;
    if (w.bottleneck && !w.past) bottleneckWeeks.push(w.weekStart);
  }

  const memberOut: MemberCapacity[] = members.map((m) => {
    const list = memberWeeks.get(m.id)!;
    for (const mw of list) {
      mw.bookedMinutes = Math.round(mw.bookedMinutes);
      mw.utilisation = mw.availableMinutes > 0 ? Math.round(((mw.loggedMinutes + mw.bookedMinutes) / mw.availableMinutes) * 1000) / 1000 : 0;
    }
    const past = list.filter((_, i) => weeks[i].past);
    const avg = past.length ? past.reduce((s, x) => s + x.utilisation, 0) / past.length : 0;
    return { id: m.id, label: m.label, weeks: list, avgUtilisation: Math.round(avg * 1000) / 1000 };
  });

  // Suggestion from the future weeks only.
  const future = weeks.filter((w) => !w.past);
  const hasData = inputs.bookings.length + inputs.timeEntries.length > 0;
  let suggestion: CapacitySuggestion;
  if (!hasData) {
    suggestion = { kind: "no_data", extraHoursPerWeek: 0, hires: 0, message: "No bookings or logged time yet — add some and the plan fills in." };
  } else {
    const excess = future.map((w) => Math.max(0, w.demandMinutes - w.availableMinutes * target));
    const overWeeks = excess.filter((x) => x > 0).length;
    const avgExcess = overWeeks ? excess.reduce((s, x) => s + x, 0) / overWeeks : 0;
    const peakExcess = Math.max(0, ...excess);
    const avgUtil = future.length ? future.reduce((s, w) => s + w.utilisation, 0) / future.length : 0;
    if (overWeeks === 0) {
      suggestion =
        avgUtil < 0.4
          ? { kind: "underused", extraHoursPerWeek: 0, hires: 0, message: `Average utilisation is ${Math.round(avgUtil * 100)}% over the next ${future.length} weeks — there is room to take on more work.` }
          : { kind: "ok", extraHoursPerWeek: 0, hires: 0, message: `Capacity is fine: no week above the ${Math.round(target * 100)}% target in the next ${future.length} weeks.` };
    } else if (overWeeks >= Math.max(2, Math.ceil(future.length / 2)) && avgExcess >= perPerson * 0.5) {
      const hires = Math.max(1, Math.ceil(avgExcess / (perPerson * target)));
      suggestion = { kind: "hire", extraHoursPerWeek: Math.round(avgExcess / 60), hires, message: `${overWeeks} of ${future.length} weeks run over the ${Math.round(target * 100)}% target by about ${Math.round(avgExcess / 60)}h a week — that is sustained, so plan on ${hires} more ${hires === 1 ? "person" : "people"}.` };
    } else {
      suggestion = { kind: "extra_hours", extraHoursPerWeek: Math.round(peakExcess / 60), hires: 0, message: `${overWeeks} ${overWeeks === 1 ? "week is" : "weeks are"} over target (peak ${Math.round(peakExcess / 60)}h over). Cover it with overtime, contractors or by moving bookings.` };
    }
  }

  return {
    generatedAt: now.toISOString(),
    weeklyMinutesPerPerson: perPerson,
    people,
    baselineLoggedMinutes: baseline,
    target,
    weeks,
    members: memberOut,
    bottleneckWeeks,
    suggestion,
  };
}
