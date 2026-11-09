"use client";

import { useCallback, useEffect, useState } from "react";
import { Layers, Loader2, RefreshCw } from "lucide-react";
import { PageContainer } from "@/components/page-container";
import { PlanGrid } from "@/components/plans/plan-grid";
import { Button } from "@/components/ui/button";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { Banner, Empty, ErrorState, Loading } from "@/components/ui/feedback";
import { Pill, type Tone } from "@/components/ui/pill";
import { TableScroller, TH, THEAD } from "@/components/ui/table-scroller";
import { fmtDate, fmtMoney } from "@/lib/money/format";
import { METRIC_LABEL, PLANS, getPlan, type Metric, type PlanDef, type PlanKey } from "@/lib/plans/catalog";
import { usagePercent } from "@/lib/plans/rules";
import type { ResolvedEntitlements } from "@/lib/plans/rules";
import type { SubscriptionDTO } from "@/lib/plans/subscription";
import type { PlanInvoiceDTO } from "@/lib/plans/checkout";
import { cn } from "@/lib/utils";

interface PlansResponse {
  plans: PlanDef[];
  subscription: SubscriptionDTO;
  entitlements: ResolvedEntitlements;
  usage: Array<{ metric: Metric; used: number; limit: number | null }>;
  enforced: boolean;
  currency: string;
  canManage: boolean;
}

type Notice = { tone: "success" | "error"; text: string };

const STATUS_TONE: Record<string, Tone> = { trialing: "info", active: "success", past_due: "danger", cancelled: "neutral", paused: "warning" };
const INVOICE_TONE: Record<string, Tone> = { open: "warning", paid: "success", void: "neutral", failed: "danger" };
const fmtInt = (n: number) => new Intl.NumberFormat().format(n);

async function readError(res: Response, fallback: string): Promise<string> {
  const d = await res.json().catch(() => null);
  return d && (d.detail || d.error) ? String(d.detail ?? d.error) : `${fallback} (${res.status})`;
}

function Meter({ metric, used, limit }: { metric: Metric; used: number; limit: number | null }) {
  const pct = usagePercent(used, limit);
  const tone = pct >= 100 ? "bg-red-500" : pct >= 80 ? "bg-amber-500" : "bg-primary";
  const label = METRIC_LABEL[metric];
  return (
    <li className="rounded-md border border-border p-3">
      <div className="flex items-baseline justify-between gap-2 text-sm">
        <span className="font-medium">{label}</span>
        <span className="tabular-nums text-muted-foreground">{fmtInt(used)} / {limit === null ? "Unlimited" : fmtInt(limit)}</span>
      </div>
      {limit !== null && (
        <div
          role="progressbar"
          aria-label={label}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={pct}
          aria-valuetext={`${fmtInt(used)} of ${fmtInt(limit)} used, ${pct} percent`}
          className="mt-2 h-2 overflow-hidden rounded-full bg-secondary"
        >
          <div className={cn("h-full rounded-full transition-[width] motion-reduce:transition-none", tone)} style={{ width: `${pct}%` }} />
        </div>
      )}
      {pct >= 100 && limit !== null ? (
        <p className="mt-1 text-xs text-red-700 dark:text-red-300">Limit reached. Existing data is safe; new items of this kind are blocked when enforcement is on.</p>
      ) : pct >= 80 && limit !== null ? (
        <p className="mt-1 text-xs text-amber-800 dark:text-amber-300">Over 80% used. Consider upgrading.</p>
      ) : null}
    </li>
  );
}

export default function PlanPage() {
  const confirm = useConfirm();
  const [data, setData] = useState<PlansResponse | null>(null);
  const [invoices, setInvoices] = useState<PlanInvoiceDTO[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [busy, setBusy] = useState(false);
  const [seatInput, setSeatInput] = useState<number | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await fetch("/api/plans", { cache: "no-store" });
      if (!res.ok) throw new Error(await readError(res, "Could not load your plan"));
      const d = (await res.json()) as PlansResponse;
      setData(d);
      setSeatInput(d.subscription.seats_purchased);
      if (d.canManage) {
        const inv = await fetch("/api/plans/invoices", { cache: "no-store" });
        setInvoices(inv.ok ? ((await inv.json()) as { invoices: PlanInvoiceDTO[] }).invoices : []);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load your plan.");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function post(url: string, body?: unknown, method = "POST"): Promise<Record<string, unknown> | null> {
    setBusy(true);
    setNotice(null);
    try {
      const res = await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
      if (!res.ok) throw new Error(await readError(res, "Request failed"));
      return (await res.json()) as Record<string, unknown>;
    } catch (e) {
      setNotice({ tone: "error", text: e instanceof Error ? e.message : "Request failed." });
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function handleOutcome(out: Record<string, unknown> | null) {
    if (!out) return;
    if (out.scheduled === true) {
      setNotice({ tone: "success", text: String(out.note ?? "Change scheduled.") });
      await load();
    } else if (typeof out.url === "string") {
      window.location.assign(out.url);
    }
  }

  async function choose(plan: PlanKey, interval: "month" | "year") {
    if (!data) return;
    const def = PLANS[plan];
    const current = PLANS[data.entitlements.plan];
    const down = data.subscription.status === "active" && def.rank < current.rank;
    const ok = await confirm({
      title: plan === "free" ? "Switch to Free?" : down ? `Downgrade to ${def.name}?` : `Continue with ${def.name}?`,
      body: plan === "free"
        ? "You keep your current plan until the end of the paid period. Your data is never deleted; resources over the Free limits become read-only."
        : down
          ? `${def.name} starts at your next renewal. You keep your current plan until then.`
          : `You will be taken to checkout for the ${interval === "year" ? "annual" : "monthly"} ${def.name} plan. Upgrades are charged pro rata for the rest of the period.`,
      confirmLabel: plan === "free" ? "Switch to Free" : down ? "Schedule downgrade" : "Continue",
      tone: plan === "free" ? "danger" : "default",
    });
    if (!ok) return;
    const seats = def.entitlements.limits.seats ?? undefined;
    await handleOutcome(await post("/api/plans/checkout", { plan_key: plan, interval, seats: Math.max(seats ?? 1, data.subscription.seats_purchased) }));
  }

  async function cancel() {
    const ok = await confirm({ title: "Cancel subscription?", body: "Your plan stays active until the end of the paid period, then moves to Free. Nothing is deleted.", confirmLabel: "Cancel at period end", tone: "danger" });
    if (!ok) return;
    if (await post("/api/plans/cancel")) {
      setNotice({ tone: "success", text: "Cancellation scheduled for the end of the period." });
      await load();
    }
  }

  async function resume() {
    if (await post("/api/plans/resume")) {
      setNotice({ tone: "success", text: "Your subscription will continue." });
      await load();
    }
  }

  async function saveSeats() {
    if (seatInput === null) return;
    await handleOutcome(await post("/api/plans/seats", { seats: seatInput }, "PATCH"));
  }

  if (error && !data) {
    return (
      <PageContainer title="Plan & usage" icon={<Layers className="h-5 w-5" aria-hidden />} wide>
        <ErrorState message={error} onRetry={() => void load()} />
      </PageContainer>
    );
  }
  if (!data) {
    return (
      <PageContainer title="Plan & usage" icon={<Layers className="h-5 w-5" aria-hidden />} wide>
        <Loading label="Loading your plan…" />
      </PageContainer>
    );
  }

  const { subscription: sub, entitlements: ent } = data;
  const plan = PLANS[ent.plan];
  const subscribed = getPlan(sub.plan_key);
  const paid = (sub.status === "active" || sub.status === "past_due") && sub.plan_key !== "free" && Boolean(sub.current_period_end);
  const seatUsage = data.usage.find((u) => u.metric === "seats");

  return (
    <PageContainer
      wide
      title="Plan & usage"
      description="Your KernelHub plan, what it includes and how much of it you are using."
      icon={<Layers className="h-5 w-5" aria-hidden />}
      actions={
        <Button variant="outline" size="sm" touch onClick={() => void load()} aria-label="Refresh plan">
          <RefreshCw className="h-3.5 w-3.5" aria-hidden /> Refresh
        </Button>
      }
    >
      <div className="space-y-6">
        {!data.enforced && (
          <Banner tone="info">Enforcement is off on this deployment: nothing is blocked. Usage is still measured so you can see where you would stand.</Banner>
        )}
        {notice && <Banner tone={notice.tone} onDismiss={() => setNotice(null)}>{notice.text}</Banner>}
        {sub.status === "past_due" && <Banner tone="error">Your last payment did not go through. Update your payment to avoid moving to Free.</Banner>}
        {!data.canManage && <Banner tone="info">Only owners and admins can change the plan.</Banner>}

        <section aria-labelledby="current-plan" className="rounded-lg border border-border p-4 sm:p-5">
          <div className="flex flex-wrap items-center gap-2">
            <h2 id="current-plan" className="text-lg font-semibold">{plan.name} plan</h2>
            <Pill tone={STATUS_TONE[sub.status] ?? "neutral"} className="capitalize">{sub.status.replace("_", " ")}</Pill>
            {ent.overridden && <Pill tone="violet">Custom limits</Pill>}
          </div>
          <dl className="mt-3 grid gap-3 text-sm sm:grid-cols-3">
            {ent.trial.active && (
              <div>
                <dt className="text-muted-foreground">Trial</dt>
                <dd className="font-medium">{ent.trial.daysLeft} day{ent.trial.daysLeft === 1 ? "" : "s"} left (ends {fmtDate(ent.trial.endsAt)})</dd>
              </div>
            )}
            {sub.status === "trialing" && !ent.trial.active && (
              <div>
                <dt className="text-muted-foreground">Trial</dt>
                <dd className="font-medium">Ended. You are on Free limits.</dd>
              </div>
            )}
            {paid && (
              <div>
                <dt className="text-muted-foreground">{sub.cancel_at_period_end ? "Ends" : "Renews"}</dt>
                <dd className="font-medium">{fmtDate(sub.current_period_end)} · {sub.billing_interval === "year" ? "annual" : "monthly"}</dd>
              </div>
            )}
            <div>
              <dt className="text-muted-foreground">Seats</dt>
              <dd className="font-medium tabular-nums">{seatUsage ? fmtInt(seatUsage.used) : 0} used / {seatUsage?.limit === null ? "unlimited" : fmtInt(seatUsage?.limit ?? 0)} available{paid ? ` (${sub.seats_purchased} purchased)` : ""}</dd>
            </div>
            {sub.pending && (
              <div className="sm:col-span-3">
                <dt className="text-muted-foreground">Scheduled change</dt>
                <dd className="font-medium">
                  {sub.pending.plan_key ? `${PLANS[sub.pending.plan_key].name} plan` : "Seat change"}
                  {sub.pending.seats ? `, ${sub.pending.seats} seats` : ""} on {fmtDate(sub.current_period_end)}
                </dd>
              </div>
            )}
          </dl>
          {sub.cancel_at_period_end && <p className="mt-3 text-sm text-amber-800 dark:text-amber-300">Cancels on {fmtDate(sub.current_period_end)}, then moves to Free.</p>}
          {data.canManage && paid && (
            <div className="mt-4 flex flex-wrap items-end gap-3">
              {sub.cancel_at_period_end ? (
                <Button touch variant="outline" disabled={busy} onClick={() => void resume()}>Resume subscription</Button>
              ) : (
                <Button touch variant="outline" disabled={busy} onClick={() => void cancel()}>Cancel subscription</Button>
              )}
              {subscribed && subscribed.entitlements.limits.seats !== null && (
                <div className="flex items-end gap-2">
                  <div>
                    <label htmlFor="seat-count" className="mb-1 block text-xs font-medium">Seats</label>
                    <input
                      id="seat-count"
                      type="number"
                      inputMode="numeric"
                      min={1}
                      max={1000}
                      value={seatInput ?? ""}
                      onChange={(e) => setSeatInput(e.target.value === "" ? null : Number(e.target.value))}
                      className="h-11 w-24 rounded-md border border-border bg-background px-3 text-sm sm:h-9"
                    />
                  </div>
                  <Button touch variant="secondary" disabled={busy || seatInput === null || seatInput === sub.seats_purchased} onClick={() => void saveSeats()}>
                    {busy && <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden />} Update seats
                  </Button>
                </div>
              )}
            </div>
          )}
        </section>

        <section aria-labelledby="usage-h">
          <h2 id="usage-h" className="mb-3 text-lg font-semibold">Usage</h2>
          <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {data.usage.map((u) => <Meter key={u.metric} metric={u.metric} used={u.used} limit={u.limit} />)}
          </ul>
        </section>

        <PlanGrid currency={data.currency} current={ent.plan} busy={busy || !data.canManage} onChoose={(p, i) => void choose(p, i)} initialInterval={sub.billing_interval} />

        {data.canManage && (
          <section aria-labelledby="inv-h">
            <h2 id="inv-h" className="mb-3 text-lg font-semibold">Invoices</h2>
            {invoices === null ? (
              <Loading label="Loading invoices…" />
            ) : invoices.length === 0 ? (
              <Empty title="No invoices yet" text="Invoices appear here after your first payment." />
            ) : (
              <TableScroller label="Plan invoices">
                <table className="w-full text-sm">
                  <caption className="sr-only">Plan invoices</caption>
                  <thead className={THEAD}>
                    <tr>
                      <th scope="col" className={TH}>Date</th>
                      <th scope="col" className={TH}>Plan</th>
                      <th scope="col" className={TH}>Type</th>
                      <th scope="col" className={cn(TH, "text-right")}>Amount</th>
                      <th scope="col" className={TH}>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {invoices.map((i) => (
                      <tr key={i.id} className="border-t border-border">
                        <td className="px-3 py-2">{fmtDate(i.paid_at ?? i.created_at)}</td>
                        <td className="px-3 py-2">{i.plan_name} · {i.billing_interval === "year" ? "annual" : "monthly"}</td>
                        <td className="px-3 py-2 capitalize">{i.kind}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{fmtMoney(i.amount_minor, i.currency)}</td>
                        <td className="px-3 py-2"><Pill tone={INVOICE_TONE[i.status] ?? "neutral"} className="capitalize">{i.status}</Pill></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </TableScroller>
            )}
          </section>
        )}
      </div>
    </PageContainer>
  );
}
