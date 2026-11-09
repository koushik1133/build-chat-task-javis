"use client";

import { useCallback, useEffect, useState } from "react";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox, Input } from "@/components/ui/input";
import { Dialog, DialogFooter } from "@/components/ui/dialog";
import { Field } from "@/components/ui/field";
import { Banner, Empty, ErrorState, Loading } from "@/components/ui/feedback";
import { SearchField } from "@/components/ui/search-field";
import { TableScroller, TH, THEAD } from "@/components/ui/table-scroller";
import { useDebouncedValue } from "@/components/ui/hooks";
import type { LoyaltyProgram, Tier } from "@/lib/engagement/pure";
import type { AccountDTO } from "@/lib/engagement/loyalty";
import { apiJson, errMsg } from "./shared";

type Account = AccountDTO & { full_name: string | null; email: string | null };

function ProgramForm() {
  const [p, setP] = useState<LoyaltyProgram | null>(null);
  const [stats, setStats] = useState<{ accounts: number; outstanding_points: number } | null>(null);
  const [msg, setMsg] = useState<{ tone: "success" | "error"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    apiJson<{ program: LoyaltyProgram; stats: { accounts: number; outstanding_points: number } }>("/api/engagement/loyalty").then((j) => { setP(j.program); setStats(j.stats); }).catch((e) => setMsg({ tone: "error", text: errMsg(e) }));
  }, []);
  if (!p) return msg ? <Banner tone="error">{msg.text}</Banner> : <Loading label="Loading program…" />;
  const num = (k: keyof LoyaltyProgram) => (e: React.ChangeEvent<HTMLInputElement>) => setP({ ...p, [k]: Number(e.target.value) || 0 });
  const setTier = (i: number, patch: Partial<Tier>) => setP({ ...p, tiers: p.tiers.map((t, j) => (j === i ? { ...t, ...patch } : t)) });
  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!p) return;
    setBusy(true); setMsg(null);
    try {
      const j = await apiJson<{ program: LoyaltyProgram }>("/api/engagement/loyalty", { method: "PATCH", json: { ...p } });
      setP(j.program); setMsg({ tone: "success", text: "Program saved." });
    } catch (e2) { setMsg({ tone: "error", text: errMsg(e2) }); } finally { setBusy(false); }
  }
  return (
    <form onSubmit={save} className="space-y-4 rounded-xl border border-border bg-card p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold">Program settings</h2>
        {stats && <p className="text-xs text-muted-foreground">{stats.accounts} members · {stats.outstanding_points.toLocaleString()} points outstanding</p>}
      </div>
      {msg && <Banner tone={msg.tone}>{msg.text}</Banner>}
      <Checkbox checked={p.enabled} onChange={(e) => setP({ ...p, enabled: e.target.checked })} label="Enable rewards (customers earn points on paid invoices and orders)" />
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Points earned" hint="Per spend amount below."><Input type="number" min={1} value={p.earn_points} onChange={num("earn_points")} inputMode="numeric" /></Field>
        <Field label="Per (minor units)" hint="100 = per 1.00 of currency."><Input type="number" min={1} value={p.per_minor} onChange={num("per_minor")} inputMode="numeric" /></Field>
        <Field label="Point value (minor units)" hint="What one point is worth at checkout."><Input type="number" min={1} value={p.redeem_value_minor_per_point} onChange={num("redeem_value_minor_per_point")} inputMode="numeric" /></Field>
        <Field label="Minimum to redeem (points)"><Input type="number" min={0} value={p.min_redeem_points} onChange={num("min_redeem_points")} inputMode="numeric" /></Field>
        <Field label="Max share of order (%)" hint="Points can pay for at most this much of a subtotal."><Input type="number" min={1} max={100} value={p.max_redeem_pct_bp / 100} onChange={(e) => setP({ ...p, max_redeem_pct_bp: Math.round((Number(e.target.value) || 0) * 100) })} inputMode="numeric" /></Field>
        <Field label="Points expire after (months)" hint="Leave empty for no expiry."><Input type="number" min={1} value={p.expiry_months ?? ""} onChange={(e) => setP({ ...p, expiry_months: e.target.value ? Number(e.target.value) : null })} inputMode="numeric" /></Field>
      </div>
      <fieldset className="space-y-2">
        <legend className="text-xs font-medium">Tiers (by lifetime points)</legend>
        {p.tiers.map((t, i) => (
          <div key={i} className="grid gap-2 sm:grid-cols-[1fr_8rem_6rem_2fr_auto]">
            <Input aria-label={`Tier ${i + 1} name`} value={t.name} onChange={(e) => setTier(i, { name: e.target.value })} maxLength={40} />
            <Input aria-label={`Tier ${i + 1} minimum points`} type="number" min={0} value={t.min_points} onChange={(e) => setTier(i, { min_points: Number(e.target.value) || 0 })} inputMode="numeric" />
            <Input aria-label={`Tier ${i + 1} earn multiplier`} type="number" min={1} max={10} step="0.25" value={t.multiplier} onChange={(e) => setTier(i, { multiplier: Number(e.target.value) || 1 })} />
            <Input aria-label={`Tier ${i + 1} perks`} value={t.perks ?? ""} onChange={(e) => setTier(i, { perks: e.target.value })} maxLength={300} placeholder="Perks shown to members" />
            <Button type="button" variant="ghost" size="sm" touch onClick={() => setP({ ...p, tiers: p.tiers.filter((_, j) => j !== i) })}>Remove</Button>
          </div>
        ))}
        {p.tiers.length < 8 && <Button type="button" variant="outline" size="sm" touch onClick={() => setP({ ...p, tiers: [...p.tiers, { name: "Silver", min_points: 1000, multiplier: 1.25 }] })}><Plus className="mr-1 h-4 w-4" aria-hidden />Add tier</Button>}
      </fieldset>
      <Button type="submit" disabled={busy}>{busy ? "Saving…" : "Save program"}</Button>
    </form>
  );
}

function AdjustDialog({ account, onClose, onDone }: { account: Account; onClose: () => void; onDone: () => void }) {
  const [points, setPoints] = useState("");
  const [note, setNote] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function go(e: React.FormEvent) {
    e.preventDefault(); setBusy(true); setErr(null);
    try { await apiJson("/api/engagement/loyalty/accounts", { method: "POST", json: { contact_id: account.contact_id, points: Number(points), note } }); onDone(); onClose(); } catch (e2) { setErr(errMsg(e2)); } finally { setBusy(false); }
  }
  return (
    <Dialog title={`Adjust points: ${account.full_name ?? account.email ?? "Contact"}`} description={`Current balance ${account.balance.toLocaleString()} points.`} size="sm" onClose={onClose}>
      <form onSubmit={go} className="space-y-3">
        {err && <Banner tone="error">{err}</Banner>}
        <Field label="Points (negative to remove)" required><Input type="number" value={points} onChange={(e) => setPoints(e.target.value)} required inputMode="numeric" /></Field>
        <Field label="Reason" required><Input value={note} onChange={(e) => setNote(e.target.value)} required maxLength={200} /></Field>
        <DialogFooter><Button type="button" variant="outline" onClick={onClose}>Cancel</Button><Button type="submit" disabled={busy || !Number(points) || !note.trim()}>Apply</Button></DialogFooter>
      </form>
    </Dialog>
  );
}

export function LoyaltyTab() {
  const [accounts, setAccounts] = useState<Account[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const dq = useDebouncedValue(q.trim(), 250);
  const [adjust, setAdjust] = useState<Account | null>(null);
  const load = useCallback(async () => {
    try { const j = await apiJson<{ accounts: Account[] }>(`/api/engagement/loyalty/accounts?q=${encodeURIComponent(dq)}`); setAccounts(j.accounts); setErr(null); } catch (e) { setErr(errMsg(e)); }
  }, [dq]);
  useEffect(() => { void load(); }, [load]);
  return (
    <div className="space-y-5">
      <ProgramForm />
      <section aria-labelledby="loy-accts" className="space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2"><h2 id="loy-accts" className="text-sm font-semibold">Members</h2><SearchField value={q} onChange={setQ} label="Search members" placeholder="Name or email" /></div>
        {err ? <ErrorState message={err} onRetry={() => void load()} /> : !accounts ? <Loading label="Loading members…" /> : accounts.length === 0 ? <Empty title="No members yet" text="Members appear when a customer earns their first points." /> : (
          <TableScroller label="Loyalty members">
            <table className="w-full text-sm"><thead className={THEAD}><tr><th className={TH}>Member</th><th className={TH}>Tier</th><th className={TH}>Balance</th><th className={TH}>Lifetime</th><th className={TH}><span className="sr-only">Actions</span></th></tr></thead>
              <tbody className="divide-y divide-border">{accounts.map((a) => (
                <tr key={a.id}><td className="px-3 py-2"><div className="font-medium">{a.full_name ?? "Contact"}</div><div className="text-xs text-muted-foreground">{a.email}</div></td><td className="px-3 py-2">{a.tier ?? "-"}</td><td className="px-3 py-2 tabular-nums">{a.balance.toLocaleString()}</td><td className="px-3 py-2 tabular-nums">{a.lifetime_points.toLocaleString()}</td><td className="px-3 py-2 text-right"><Button size="sm" variant="outline" touch onClick={() => setAdjust(a)}>Adjust</Button></td></tr>
              ))}</tbody></table>
          </TableScroller>
        )}
      </section>
      {adjust && <AdjustDialog account={adjust} onClose={() => setAdjust(null)} onDone={() => void load()} />}
    </div>
  );
}
