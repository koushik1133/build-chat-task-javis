"use client";

import { Suspense, useCallback, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Check, Copy, IdCard, Loader2, Plus, RefreshCw, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { confirmDialog } from "@/components/ui/confirm-dialog";
import { Checkbox, Input, Select, Textarea } from "@/components/ui/input";
import { Dialog, DialogFooter, Drawer } from "@/components/ui/dialog";
import { Field } from "@/components/ui/field";
import { Banner, Empty, ErrorState, Loading } from "@/components/ui/feedback";
import { Pill, StatusPill, type Tone } from "@/components/ui/pill";
import { SearchField } from "@/components/ui/search-field";
import { TableScroller, TH, THEAD } from "@/components/ui/table-scroller";
import { TabPanel, Tabs } from "@/components/ui/tabs";
import { LoadMore, usePagedList } from "@/components/ui/load-more";
import { useDebouncedValue } from "@/components/ui/hooks";
import { PageContainer } from "@/components/page-container";
import { api, fromMinor, toMinor } from "@/components/finance/shared";
import { fmtDate, fmtMoney } from "@/lib/money/format";
import { cn } from "@/lib/utils";
import { SUB_STATUSES, type MembershipMetrics, type PlanBenefit, type SubStatus } from "@/lib/memberships/pure";
import type { PlanDTO } from "@/lib/memberships/plans";
import type { ChargeDTO, SubscriptionDTO } from "@/lib/memberships/store";

type Tab = "plans" | "members" | "revenue";
type Notice = { tone: "success" | "error"; text: string };
type PlanRow = PlanDTO & { members: number };

const STATUS_TONE: Record<SubStatus, Tone> = { incomplete: "warning", trialing: "info", active: "success", past_due: "danger", paused: "warning", cancelled: "neutral", expired: "neutral" };
const CHARGE_TONE: Record<string, Tone> = { pending: "warning", paid: "success", failed: "danger", void: "neutral" };
const spinner = <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden />;
const every = (interval: string, count: number) => (count === 1 ? interval : `${count} ${interval}s`);

export default function MembershipsPage() {
  return (
    <Suspense fallback={<PageContainer wide title="Memberships"><Loading label="Loading memberships…" /></PageContainer>}>
      <Inner />
    </Suspense>
  );
}

function Inner() {
  const router = useRouter();
  const search = useSearchParams();
  const raw = search.get("tab");
  const tab: Tab = raw === "members" || raw === "revenue" ? raw : "plans";
  const [notice, setNotice] = useState<Notice | null>(null);
  const setTab = (t: Tab) => router.replace(t === "plans" ? "/memberships" : `/memberships?tab=${t}`);
  return (
    <PageContainer wide title="Memberships" description="Recurring plans you sell to your own customers: signup link, automatic billing, retries and a self-service portal." icon={<IdCard className="h-5 w-5" aria-hidden />}>
      {notice && <Banner tone={notice.tone} onDismiss={() => setNotice(null)} className="mb-4">{notice.text}</Banner>}
      <Tabs id="mem-tabs" label="Memberships" value={tab} onChange={setTab} className="mb-4 w-fit" tabs={[{ id: "plans", label: "Plans" }, { id: "members", label: "Members" }, { id: "revenue", label: "Revenue" }]} />
      <TabPanel id="mem-tabs" value="plans" className={cn(tab !== "plans" && "hidden")}>{tab === "plans" && <PlansTab notify={setNotice} />}</TabPanel>
      <TabPanel id="mem-tabs" value="members" className={cn(tab !== "members" && "hidden")}>{tab === "members" && <MembersTab notify={setNotice} />}</TabPanel>
      <TabPanel id="mem-tabs" value="revenue" className={cn(tab !== "revenue" && "hidden")}>{tab === "revenue" && <RevenueTab />}</TabPanel>
    </PageContainer>
  );
}

/* ───────────────────────────── Plans ───────────────────────────── */

function PlansTab({ notify }: { notify: (n: Notice) => void }) {
  const [plans, setPlans] = useState<PlanRow[] | null>(null);
  const [orgSlug, setOrgSlug] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<PlanRow | "new" | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const r = await api<{ plans: PlanRow[]; org_slug: string | null }>("/api/memberships/plans");
      setPlans(r.plans);
      setOrgSlug(r.org_slug);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load plans");
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const link = (p: PlanRow) => `${typeof window === "undefined" ? "" : window.location.origin}/join/${orgSlug ?? "your-org"}/${p.slug}`;
  async function copy(p: PlanRow) {
    try {
      await navigator.clipboard.writeText(link(p));
      setCopied(p.id);
      setTimeout(() => setCopied((v) => (v === p.id ? null : v)), 1500);
    } catch {
      notify({ tone: "error", text: "Could not copy the link" });
    }
  }
  async function archive(p: PlanRow) {
    const ok = await confirmDialog({ title: `Archive "${p.name}"?`, body: "New sign-ups stop. Existing members keep their plan and keep being billed.", confirmLabel: "Archive", tone: "danger" });
    if (!ok) return;
    try {
      await api(`/api/memberships/plans/${p.id}`, { method: "DELETE" });
      notify({ tone: "success", text: "Plan archived." });
      void load();
    } catch (e) {
      notify({ tone: "error", text: e instanceof Error ? e.message : "Could not archive" });
    }
  }
  async function restore(p: PlanRow) {
    try {
      await api(`/api/memberships/plans/${p.id}`, { method: "PATCH", body: JSON.stringify({ active: true }) });
      void load();
    } catch (e) {
      notify({ tone: "error", text: e instanceof Error ? e.message : "Could not restore" });
    }
  }

  if (error) return <ErrorState message={error} onRetry={() => void load()} />;
  if (!plans) return <Loading label="Loading plans…" />;
  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <Button touch onClick={() => setEditing("new")}><Plus className="h-4 w-4" aria-hidden /> New plan</Button>
      </div>
      {plans.length === 0 ? (
        <Empty icon={<IdCard className="h-5 w-5" aria-hidden />} title="No plans yet" text="Create a plan, then share its sign-up link with customers." action={<Button touch onClick={() => setEditing("new")}>Create a plan</Button>} />
      ) : (
        <ul className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {plans.map((p) => (
            <li key={p.id} className={cn("flex flex-col rounded-lg border border-border bg-card p-4", !p.active && "opacity-70")}>
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <h3 className="truncate font-semibold">{p.name}</h3>
                  <p className="text-xl font-semibold tabular-nums">{fmtMoney(p.amount_minor, p.currency)} <span className="text-xs font-normal text-muted-foreground">/ {every(p.interval, p.interval_count)}</span></p>
                </div>
                <div className="flex flex-col items-end gap-1">
                  {!p.active && <Pill tone="neutral">Archived</Pill>}
                  {p.visibility === "private" && <Pill tone="violet">Private</Pill>}
                </div>
              </div>
              <p className="mt-2 text-xs text-muted-foreground">
                {p.members} member{p.members === 1 ? "" : "s"}{p.max_members ? ` of ${p.max_members}` : ""}
                {p.trial_days > 0 ? ` · ${p.trial_days}-day trial` : ""}
                {p.setup_fee_minor > 0 ? ` · ${fmtMoney(p.setup_fee_minor, p.currency)} setup` : ""}
              </p>
              {p.benefits.length > 0 && <ul className="mt-2 list-disc space-y-0.5 pl-5 text-sm">{p.benefits.slice(0, 4).map((b, i) => <li key={`${i}-${b.label}`}>{b.label}</li>)}</ul>}
              <div className="mt-auto flex flex-wrap gap-2 pt-4">
                <Button variant="outline" size="sm" touch onClick={() => setEditing(p)}>Edit</Button>
                <Button variant="outline" size="sm" touch onClick={() => void copy(p)} aria-label={`Copy sign-up link for ${p.name}`}>
                  {copied === p.id ? <Check className="h-4 w-4" aria-hidden /> : <Copy className="h-4 w-4" aria-hidden />} {copied === p.id ? "Copied" : "Share link"}
                </Button>
                {p.active ? (
                  <Button variant="outline" size="sm" touch onClick={() => void archive(p)} aria-label={`Archive ${p.name}`}><Trash2 className="h-4 w-4" aria-hidden /></Button>
                ) : (
                  <Button variant="outline" size="sm" touch onClick={() => void restore(p)}>Restore</Button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
      {editing && (
        <PlanDialog
          plan={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            notify({ tone: "success", text: "Plan saved." });
            void load();
          }}
        />
      )}
    </div>
  );
}

function PlanDialog({ plan, onClose, onSaved }: { plan: PlanRow | null; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState(plan?.name ?? "");
  const [slug, setSlug] = useState(plan?.slug ?? "");
  const [desc, setDesc] = useState(plan?.description_md ?? "");
  const [amount, setAmount] = useState(plan ? fromMinor(plan.amount_minor) : "");
  const [currency, setCurrency] = useState(plan?.currency ?? "USD");
  const [interval, setIntervalV] = useState<string>(plan?.interval ?? "month");
  const [count, setCount] = useState(String(plan?.interval_count ?? 1));
  const [trial, setTrial] = useState(String(plan?.trial_days ?? 0));
  const [setup, setSetup] = useState(plan ? fromMinor(plan.setup_fee_minor) : "0.00");
  const [taxId, setTaxId] = useState(plan?.tax_rate_id ?? "");
  const [max, setMax] = useState(plan?.max_members ? String(plan.max_members) : "");
  const [allowPause, setAllowPause] = useState(plan?.allow_pause ?? true);
  const [allowQty, setAllowQty] = useState(plan?.allow_quantity ?? false);
  const [visibility, setVisibility] = useState<string>(plan?.visibility ?? "public");
  const [benefits, setBenefits] = useState<PlanBenefit[]>(plan?.benefits.length ? plan.benefits : [{ label: "" }]);
  const [taxRates, setTaxRates] = useState<Array<{ id: string; name: string; rate_bp: number }>>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<{ rates: Array<{ id: string; name: string; rate_bp: number; active: boolean }> }>("/api/tax-rates")
      .then((r) => setTaxRates(r.rates.filter((x) => x.active)))
      .catch(() => undefined);
  }, []);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const shared = {
      name: name.trim(),
      description_md: desc.trim() || null,
      amount_minor: toMinor(amount),
      trial_days: Math.max(0, Number(trial) || 0),
      setup_fee_minor: toMinor(setup),
      tax_rate_id: taxId || null,
      max_members: max.trim() ? Math.max(1, Number(max) || 1) : null,
      allow_pause: allowPause,
      allow_quantity: allowQty,
      visibility,
      benefits: benefits.map((b) => ({ label: b.label.trim() })).filter((b) => b.label),
    };
    try {
      if (plan) await api(`/api/memberships/plans/${plan.id}`, { method: "PATCH", body: JSON.stringify(shared) });
      else await api("/api/memberships/plans", { method: "POST", body: JSON.stringify({ ...shared, ...(slug.trim() ? { slug: slug.trim().toLowerCase() } : {}), currency: currency.toUpperCase(), interval, interval_count: Math.max(1, Number(count) || 1) }) });
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog title={plan ? `Edit ${plan.name}` : "New plan"} description="Price, billing cycle and what members get." onClose={onClose} size="lg">
      <form onSubmit={save} className="space-y-3">
        {error && <Banner tone="error">{error}</Banner>}
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Name" required><Input value={name} onChange={(e) => setName(e.target.value)} required maxLength={120} /></Field>
          <Field label="Link name" hint={plan ? "Fixed once created." : "Optional. Used in the sign-up link."}><Input value={slug} onChange={(e) => setSlug(e.target.value)} disabled={Boolean(plan)} maxLength={60} /></Field>
        </div>
        <Field label="Description"><Textarea value={desc} onChange={(e) => setDesc(e.target.value)} rows={3} maxLength={5000} /></Field>
        <div className="grid gap-3 sm:grid-cols-4">
          <Field label="Price" required><Input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} required /></Field>
          <Field label="Currency"><Input value={currency} onChange={(e) => setCurrency(e.target.value)} disabled={Boolean(plan)} maxLength={3} /></Field>
          <Field label="Every"><Input type="number" min={1} max={24} value={count} onChange={(e) => setCount(e.target.value)} disabled={Boolean(plan)} /></Field>
          <Field label="Interval">
            <Select value={interval} onChange={(e) => setIntervalV(e.target.value)} disabled={Boolean(plan)}>
              <option value="week">Week</option><option value="month">Month</option><option value="quarter">Quarter</option><option value="year">Year</option>
            </Select>
          </Field>
        </div>
        <div className="grid gap-3 sm:grid-cols-4">
          <Field label="Free trial (days)"><Input type="number" min={0} max={365} value={trial} onChange={(e) => setTrial(e.target.value)} /></Field>
          <Field label="Setup fee"><Input inputMode="decimal" value={setup} onChange={(e) => setSetup(e.target.value)} /></Field>
          <Field label="Max members" hint="Blank = unlimited"><Input type="number" min={1} value={max} onChange={(e) => setMax(e.target.value)} /></Field>
          <Field label="Tax rate">
            <Select value={taxId} onChange={(e) => setTaxId(e.target.value)}>
              <option value="">None</option>
              {taxRates.map((r) => <option key={r.id} value={r.id}>{r.name} ({(r.rate_bp / 100).toFixed(2)}%)</option>)}
            </Select>
          </Field>
        </div>
        <div className="flex flex-wrap gap-x-6 gap-y-1">
          <Checkbox checked={allowPause} onChange={(e) => setAllowPause(e.target.checked)} label="Members may pause" />
          <Checkbox checked={allowQty} onChange={(e) => setAllowQty(e.target.checked)} label="Allow quantity (seats)" />
          <Field label="Visibility" className="min-w-[10rem]">
            <Select value={visibility} onChange={(e) => setVisibility(e.target.value)}>
              <option value="public">Public</option><option value="private">Private (link only)</option>
            </Select>
          </Field>
        </div>
        <fieldset className="space-y-2">
          <legend className="text-xs font-medium">Benefits</legend>
          {benefits.map((b, i) => (
            <div key={i} className="flex gap-2">
              <Input aria-label={`Benefit ${i + 1}`} value={b.label} onChange={(e) => setBenefits((l) => l.map((x, j) => (j === i ? { label: e.target.value } : x)))} maxLength={200} />
              <Button type="button" variant="outline" size="icon" touch aria-label={`Remove benefit ${i + 1}`} onClick={() => setBenefits((l) => l.filter((_, j) => j !== i))}><Trash2 className="h-4 w-4" aria-hidden /></Button>
            </div>
          ))}
          <Button type="button" variant="outline" size="sm" touch onClick={() => setBenefits((l) => [...l, { label: "" }])} disabled={benefits.length >= 30}><Plus className="h-4 w-4" aria-hidden /> Add benefit</Button>
        </fieldset>
        <DialogFooter>
          <Button type="button" variant="outline" touch onClick={onClose}>Cancel</Button>
          <Button type="submit" touch disabled={busy || !name.trim() || !amount.trim()}>{busy && spinner} Save plan</Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}

/* ───────────────────────────── Members ───────────────────────────── */

function MembersTab({ notify }: { notify: (n: Notice) => void }) {
  const [filter, setFilter] = useState<"all" | SubStatus>("all");
  const [q, setQ] = useState("");
  const query = useDebouncedValue(q.trim(), 250);
  const [openId, setOpenId] = useState<string | null>(null);

  const fetchPage = useCallback(
    async (cursor: string | null) => {
      const sp = new URLSearchParams();
      if (filter !== "all") sp.set("status", filter);
      if (query) sp.set("q", query);
      if (cursor) sp.set("cursor", cursor);
      const r = await api<{ subscriptions: SubscriptionDTO[]; next_cursor: string | null }>(`/api/memberships/subscriptions?${sp}`);
      return { rows: r.subscriptions, next_cursor: r.next_cursor };
    },
    [filter, query]
  );
  const list = usePagedList<SubscriptionDTO>(fetchPage);
  const { reload } = list;
  useEffect(() => {
    void reload();
  }, [reload]);

  const filters = [{ id: "all" as const, label: "All" }, ...SUB_STATUSES.map((s) => ({ id: s, label: s.replace("_", " ").replace(/^./, (c) => c.toUpperCase()) }))];
  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <Tabs id="mem-status" label="Member status" tabs={filters} value={filter} onChange={setFilter} />
        <div className="flex items-center gap-2">
          <SearchField value={q} onChange={setQ} label="Search members" placeholder="Name, email or plan" className="min-w-0 flex-1 lg:w-72 lg:flex-none" />
          <Button type="button" variant="outline" size="icon" touch aria-label="Refresh members" onClick={() => void reload()} disabled={list.loading}>
            {list.loading ? spinner : <RefreshCw className="h-4 w-4" aria-hidden />}
          </Button>
        </div>
      </div>
      <TabPanel id="mem-status" value={filter}>
        {list.loading ? (
          <Loading label="Loading members…" />
        ) : list.error ? (
          <ErrorState message={list.error} onRetry={() => void reload()} />
        ) : list.rows.length === 0 ? (
          <Empty icon={<IdCard className="h-5 w-5" aria-hidden />} title={filter !== "all" || query ? "No members match" : "No members yet"} text="Members appear here after someone signs up through a plan link." />
        ) : (
          <>
            <TableScroller label="Members">
              <table className="w-full min-w-[760px] text-sm">
                <thead className={THEAD}>
                  <tr><th className={TH}>Member</th><th className={TH}>Plan</th><th className={TH}>Status</th><th className={TH}>Next charge</th><th className={cn(TH, "text-right")}>Price</th></tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {list.rows.map((s) => (
                    <tr key={s.id} className="hover:bg-secondary/40">
                      <td className="max-w-[16rem] px-3 py-2">
                        <button type="button" className="inline-flex min-h-11 max-w-full items-center truncate rounded font-medium underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:min-h-0" aria-label={`Open member ${s.contact_name ?? s.contact_email ?? s.id}`} onClick={() => setOpenId(s.id)}>
                          {s.contact_name ?? s.contact_email ?? "Member"}
                        </button>
                        <p className="truncate text-xs text-muted-foreground">{s.contact_email}</p>
                      </td>
                      <td className="px-3 py-2">{s.plan_name}{s.quantity > 1 ? ` x${s.quantity}` : ""}</td>
                      <td className="px-3 py-2"><StatusPill status={s.status} map={STATUS_TONE} label={s.status.replace("_", " ")} />{s.cancel_at_period_end && <span className="ml-1 text-xs text-muted-foreground">ending</span>}</td>
                      <td className="whitespace-nowrap px-3 py-2 text-xs text-muted-foreground">{s.next_charge_at ? fmtDate(s.next_charge_at) : "—"}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{fmtMoney(s.amount_minor * s.quantity, s.currency)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableScroller>
            <LoadMore hasMore={Boolean(list.cursor)} loading={list.loadingMore} count={list.rows.length} noun="members" onMore={list.more} />
          </>
        )}
      </TabPanel>
      {openId && <MemberDrawer id={openId} onClose={() => setOpenId(null)} onChanged={() => void reload()} notify={notify} />}
    </div>
  );
}

interface Detail {
  subscription: SubscriptionDTO;
  charges: ChargeDTO[];
  invoices: Array<{ id: string; number: string; status: string; total_minor: number; currency: string; created_at: string }>;
}

function MemberDrawer({ id, onClose, onChanged, notify }: { id: string; onClose: () => void; onChanged: () => void; notify: (n: Notice) => void }) {
  const [d, setD] = useState<Detail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [plans, setPlans] = useState<PlanRow[]>([]);
  const [changePlan, setChangePlan] = useState("");
  const [qty, setQty] = useState("1");

  const load = useCallback(async () => {
    try {
      const r = await api<Detail>(`/api/memberships/subscriptions/${id}`);
      setD(r);
      setQty(String(r.subscription.quantity));
      setChangePlan(r.subscription.plan_slug);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load");
    }
  }, [id]);
  useEffect(() => {
    void load();
    api<{ plans: PlanRow[] }>("/api/memberships/plans").then((r) => setPlans(r.plans.filter((p) => p.active))).catch(() => undefined);
  }, [load]);

  async function act(action: string, body: Record<string, unknown> = {}, okText = "Done.") {
    setBusy(action);
    try {
      const r = await api<{ proration_minor?: number }>(`/api/memberships/subscriptions/${id}`, { method: "POST", body: JSON.stringify({ action, ...body }) });
      notify({ tone: "success", text: r.proration_minor ? `${okText} Adjustment of ${fmtMoney(r.proration_minor, d?.subscription.currency ?? "USD")} goes on the next invoice.` : okText });
      await load();
      onChanged();
    } catch (e) {
      notify({ tone: "error", text: e instanceof Error ? e.message : "Action failed" });
    } finally {
      setBusy(null);
    }
  }
  async function cancel(atPeriodEnd: boolean) {
    const ok = await confirmDialog({
      title: atPeriodEnd ? "Cancel at period end?" : "Cancel now?",
      body: atPeriodEnd ? "The member keeps access until the paid period ends." : "Access ends immediately and any unpaid invoice is voided.",
      confirmLabel: atPeriodEnd ? "Cancel at period end" : "Cancel now",
      tone: "danger",
    });
    if (ok) await act("cancel", { at_period_end: atPeriodEnd }, "Membership cancelled.");
  }

  const s = d?.subscription;
  const live = s && s.status !== "cancelled" && s.status !== "expired";
  return (
    <Drawer
      labelledBy="mem-drawer-title"
      onClose={onClose}
      header={
        <div className="min-w-0">
          <h2 id="mem-drawer-title" className="truncate text-base font-semibold">{s?.contact_name ?? s?.contact_email ?? "Member"}</h2>
          {s && <p className="text-xs text-muted-foreground">{s.plan_name} · <StatusPill status={s.status} map={STATUS_TONE} label={s.status.replace("_", " ")} /></p>}
        </div>
      }
    >
      {error ? <ErrorState message={error} onRetry={() => void load()} /> : !s || !d ? <Loading label="Loading member…" /> : (
        <div className="space-y-5">
          <dl className="grid grid-cols-2 gap-3 text-sm">
            <div><dt className="text-xs text-muted-foreground">Price</dt><dd>{fmtMoney(s.amount_minor * s.quantity, s.currency)} / {every(s.interval, s.interval_count)}</dd></div>
            <div><dt className="text-xs text-muted-foreground">Next charge</dt><dd>{s.next_charge_at ? fmtDate(s.next_charge_at) : "—"}</dd></div>
            <div><dt className="text-xs text-muted-foreground">Period ends</dt><dd>{fmtDate(s.current_period_end)}</dd></div>
            <div><dt className="text-xs text-muted-foreground">Payment method</dt><dd>{s.has_payment_method ? "Saved" : "Pays by link"}</dd></div>
            {s.failed_attempts > 0 && <div><dt className="text-xs text-muted-foreground">Failed attempts</dt><dd>{s.failed_attempts}</dd></div>}
            {s.pending_adjustment_minor !== 0 && <div><dt className="text-xs text-muted-foreground">Carried adjustment</dt><dd>{fmtMoney(s.pending_adjustment_minor, s.currency)}</dd></div>}
          </dl>

          {live && (
            <div className="flex flex-wrap gap-2">
              {s.status === "paused" ? (
                <Button variant="outline" size="sm" touch disabled={busy !== null} onClick={() => void act("resume", {}, "Membership resumed.")}>Resume</Button>
              ) : (
                (s.status === "active") && <Button variant="outline" size="sm" touch disabled={busy !== null} onClick={() => void act("pause", {}, "Membership paused.")}>Pause</Button>
              )}
              {(s.status === "past_due" || s.status === "active") && (
                <Button variant="outline" size="sm" touch disabled={busy !== null} onClick={() => void act("retry", {}, "Billing step run.")}>{busy === "retry" && spinner} Retry charge now</Button>
              )}
              {s.cancel_at_period_end ? (
                <Button variant="outline" size="sm" touch disabled={busy !== null} onClick={() => void act("keep", {}, "Cancellation removed.")}>Keep membership</Button>
              ) : (
                <Button variant="outline" size="sm" touch disabled={busy !== null} onClick={() => void cancel(true)}>Cancel at period end</Button>
              )}
              <Button variant="outline" size="sm" touch disabled={busy !== null} onClick={() => void cancel(false)}>Cancel now</Button>
            </div>
          )}

          {live && ["active", "trialing", "past_due"].includes(s.status) && (
            <fieldset className="rounded-md border border-border p-3">
              <legend className="px-1 text-xs font-medium">Change plan or quantity</legend>
              <div className="grid gap-2 sm:grid-cols-[1fr_6rem_auto] sm:items-end">
                <Field label="Plan">
                  <Select value={changePlan} onChange={(e) => setChangePlan(e.target.value)}>
                    {plans.filter((p) => p.currency === s.currency).map((p) => <option key={p.id} value={p.slug}>{p.name} ({fmtMoney(p.amount_minor, p.currency)})</option>)}
                  </Select>
                </Field>
                <Field label="Quantity"><Input type="number" min={1} max={100} value={qty} onChange={(e) => setQty(e.target.value)} /></Field>
                <Button size="sm" touch disabled={busy !== null} onClick={() => void act("change", { plan_slug: changePlan, quantity: Math.max(1, Number(qty) || 1) }, "Membership updated.")}>Apply</Button>
              </div>
              <p className="mt-2 text-xs text-muted-foreground">The unused part of the current period is credited against the new price on the next invoice.</p>
            </fieldset>
          )}

          <section aria-labelledby="mem-charges">
            <h3 id="mem-charges" className="mb-2 text-sm font-semibold">Charges</h3>
            {d.charges.length === 0 ? <p className="text-sm text-muted-foreground">No charges yet.</p> : (
              <ol className="space-y-2 border-l border-border pl-4">
                {d.charges.map((c) => (
                  <li key={c.id} className="text-sm">
                    <div className="flex flex-wrap items-center gap-2">
                      <Pill tone={CHARGE_TONE[c.status] ?? "neutral"} className="capitalize">{c.status}</Pill>
                      <span className="tabular-nums">{fmtMoney(c.amount_minor, c.currency)}</span>
                      <span className="text-xs text-muted-foreground">{fmtDate(c.period_start)} to {fmtDate(c.period_end)}</span>
                    </div>
                    {(c.error || c.attempt > 1) && <p className="text-xs text-muted-foreground">Attempt {c.attempt}{c.error ? ` · ${c.error}` : ""}</p>}
                  </li>
                ))}
              </ol>
            )}
          </section>

          <section aria-labelledby="mem-invoices">
            <h3 id="mem-invoices" className="mb-2 text-sm font-semibold">Invoices</h3>
            {d.invoices.length === 0 ? <p className="text-sm text-muted-foreground">No invoices yet.</p> : (
              <ul className="divide-y divide-border/60">
                {d.invoices.map((i) => (
                  <li key={i.id} className="flex items-center justify-between gap-2 py-1.5 text-sm">
                    <span>{i.number} <StatusPill status={i.status} /></span>
                    <span className="tabular-nums">{fmtMoney(i.total_minor, i.currency)}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      )}
    </Drawer>
  );
}

/* ───────────────────────────── Revenue ───────────────────────────── */

function RevenueTab() {
  const [m, setM] = useState<MembershipMetrics | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    setError(null);
    try {
      setM((await api<{ metrics: MembershipMetrics }>("/api/memberships/metrics")).metrics);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load");
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  if (error) return <ErrorState message={error} onRetry={() => void load()} />;
  if (!m) return <Loading label="Loading revenue…" />;
  const cur = m.primary_currency;
  const maxN = Math.max(1, ...m.new_by_month.map((x) => x.count));
  const tiles: Array<{ label: string; value: string; hint?: string }> = [
    { label: "MRR", value: cur ? fmtMoney(m.mrr_minor[cur] ?? 0, cur) : "—", hint: Object.keys(m.mrr_minor).length > 1 ? "Largest currency shown" : undefined },
    { label: "Active members", value: String(m.active_members), hint: m.past_due > 0 ? `${m.past_due} past due` : undefined },
    { label: "Churn (30 days)", value: `${m.churn_pct}%`, hint: `${m.churned_30d} ended` },
    { label: "Trial conversion", value: m.trial_conversion_pct === null ? "—" : `${m.trial_conversion_pct}%`, hint: m.trialing > 0 ? `${m.trialing} in trial` : undefined },
  ];
  return (
    <div className="space-y-5">
      <dl className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {tiles.map((t) => (
          <div key={t.label} className="rounded-lg border border-border bg-card p-4">
            <dt className="text-xs text-muted-foreground">{t.label}</dt>
            <dd className="mt-1 text-2xl font-semibold tabular-nums">{t.value}</dd>
            {t.hint && <p className="text-xs text-muted-foreground">{t.hint}</p>}
          </div>
        ))}
      </dl>
      <section className="rounded-lg border border-border bg-card p-4" aria-labelledby="mem-new">
        <h3 id="mem-new" className="mb-3 text-sm font-semibold">New members per month</h3>
        <svg viewBox="0 0 300 80" className="h-24 w-full" role="img" aria-label={`New members per month: ${m.new_by_month.map((x) => `${x.month} ${x.count}`).join(", ")}`}>
          {m.new_by_month.map((x, i) => {
            const h = Math.max(2, (x.count / maxN) * 60);
            return (
              <g key={x.month}>
                <rect x={i * 50 + 8} y={64 - h} width={34} height={h} rx={3} className="fill-primary" />
                <text x={i * 50 + 25} y={64 - h - 3} textAnchor="middle" className="fill-foreground text-[10px] font-semibold">{x.count}</text>
                <text x={i * 50 + 25} y={77} textAnchor="middle" className="fill-muted-foreground text-[10px]">{x.month.slice(5)}</text>
              </g>
            );
          })}
        </svg>
        <details className="mt-2 text-xs text-muted-foreground">
          <summary className="min-h-11 cursor-pointer py-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">Show as table</summary>
          <table className="mt-1"><caption className="sr-only">New members per month</caption><thead><tr><th scope="col" className="pr-4 text-left font-medium">Month</th><th scope="col" className="text-right font-medium">New members</th></tr></thead><tbody>{m.new_by_month.map((x) => <tr key={x.month}><th scope="row" className="pr-4 text-left font-normal">{x.month}</th><td className="text-right tabular-nums">{x.count}</td></tr>)}</tbody></table>
        </details>
      </section>
    </div>
  );
}
