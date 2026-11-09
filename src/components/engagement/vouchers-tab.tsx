"use client";

import { useCallback, useEffect, useState } from "react";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox, Input, Select } from "@/components/ui/input";
import { Dialog, DialogFooter } from "@/components/ui/dialog";
import { Field } from "@/components/ui/field";
import { Banner, Empty, ErrorState, Loading } from "@/components/ui/feedback";
import { Pill } from "@/components/ui/pill";
import { TableScroller, TH, THEAD } from "@/components/ui/table-scroller";
import { formatMoney } from "@/lib/money/items";
import type { VoucherDTO } from "@/lib/engagement/vouchers";
import { apiJson, errMsg } from "./shared";

const describe = (v: VoucherDTO) => (v.kind === "percent" ? `${v.value / 100}% off` : v.kind === "fixed" ? `${formatMoney(v.value, v.currency ?? "USD")} off` : "Free shipping");
const toLocalInput = (iso: string | null) => (iso ? iso.slice(0, 16) : "");

function VoucherDialog({ voucher, onClose, onDone }: { voucher: VoucherDTO | null; onClose: () => void; onDone: () => void }) {
  const [code, setCode] = useState(voucher?.code_upper ?? "");
  const [name, setName] = useState(voucher?.name ?? "");
  const [kind, setKind] = useState<VoucherDTO["kind"]>(voucher?.kind ?? "percent");
  const [value, setValue] = useState(voucher ? String(voucher.kind === "percent" ? voucher.value / 100 : voucher.value / 100) : "10");
  const [currency, setCurrency] = useState(voucher?.currency ?? "USD");
  const [min, setMin] = useState(voucher ? String(voucher.min_subtotal_minor / 100) : "0");
  const [maxUses, setMaxUses] = useState(voucher?.max_uses ? String(voucher.max_uses) : "");
  const [perContact, setPerContact] = useState(voucher?.per_contact_limit ? String(voucher.per_contact_limit) : "");
  const [starts, setStarts] = useState(toLocalInput(voucher?.starts_at ?? null));
  const [ends, setEnds] = useState(toLocalInput(voucher?.ends_at ?? null));
  const [stackable, setStackable] = useState(voucher?.stackable ?? false);
  const [active, setActive] = useState(voucher?.active ?? true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  async function save(e: React.FormEvent) {
    e.preventDefault(); setBusy(true); setErr(null);
    const iso = (s: string) => (s ? new Date(s).toISOString() : null);
    try {
      if (voucher) await apiJson(`/api/engagement/vouchers/${voucher.id}`, { method: "PATCH", json: { name, min_subtotal_minor: Math.round(Number(min) * 100), max_uses: maxUses ? Number(maxUses) : null, per_contact_limit: perContact ? Number(perContact) : null, starts_at: iso(starts), ends_at: iso(ends), stackable, active } });
      else await apiJson("/api/engagement/vouchers", { method: "POST", json: { code, name, kind, value: kind === "percent" ? Math.round(Number(value) * 100) : kind === "fixed" ? Math.round(Number(value) * 100) : 0, currency: kind === "fixed" ? currency : null, min_subtotal_minor: Math.round(Number(min) * 100), max_uses: maxUses ? Number(maxUses) : null, per_contact_limit: perContact ? Number(perContact) : null, starts_at: iso(starts), ends_at: iso(ends), stackable, active } });
      onDone(); onClose();
    } catch (e2) { setErr(errMsg(e2)); } finally { setBusy(false); }
  }
  return (
    <Dialog title={voucher ? `Edit ${voucher.code_upper}` : "New voucher"} size="md" onClose={onClose}>
      <form onSubmit={save} className="space-y-3">
        {err && <Banner tone="error">{err}</Banner>}
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Code" required><Input value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} disabled={Boolean(voucher)} maxLength={40} required className="font-mono uppercase" /></Field>
          <Field label="Name" required><Input value={name} onChange={(e) => setName(e.target.value)} maxLength={120} required /></Field>
          <Field label="Type"><Select value={kind} disabled={Boolean(voucher)} onChange={(e) => setKind(e.target.value as VoucherDTO["kind"])}><option value="percent">Percent off</option><option value="fixed">Fixed amount off</option><option value="free_shipping">Free shipping</option></Select></Field>
          {kind !== "free_shipping" && <Field label={kind === "percent" ? "Percent" : "Amount"} required><Input type="number" min="0.01" step="0.01" value={value} disabled={Boolean(voucher)} onChange={(e) => setValue(e.target.value)} required inputMode="decimal" /></Field>}
          {kind === "fixed" && <Field label="Currency"><Input value={currency} disabled={Boolean(voucher)} onChange={(e) => setCurrency(e.target.value.toUpperCase().slice(0, 3))} maxLength={3} /></Field>}
          <Field label="Minimum spend"><Input type="number" min="0" step="0.01" value={min} onChange={(e) => setMin(e.target.value)} inputMode="decimal" /></Field>
          <Field label="Total uses (blank = unlimited)"><Input type="number" min={1} value={maxUses} onChange={(e) => setMaxUses(e.target.value)} inputMode="numeric" /></Field>
          <Field label="Uses per customer"><Input type="number" min={1} value={perContact} onChange={(e) => setPerContact(e.target.value)} inputMode="numeric" /></Field>
          <Field label="Starts"><Input type="datetime-local" value={starts} onChange={(e) => setStarts(e.target.value)} /></Field>
          <Field label="Ends"><Input type="datetime-local" value={ends} onChange={(e) => setEnds(e.target.value)} /></Field>
        </div>
        <Checkbox checked={stackable} onChange={(e) => setStackable(e.target.checked)} label="Can be combined with other codes" />
        <Checkbox checked={active} onChange={(e) => setActive(e.target.checked)} label="Active" />
        <DialogFooter><Button type="button" variant="outline" onClick={onClose}>Cancel</Button><Button type="submit" disabled={busy || !name.trim() || (!voucher && code.length < 3)}>{busy ? "Saving…" : "Save voucher"}</Button></DialogFooter>
      </form>
    </Dialog>
  );
}

export function VouchersTab() {
  const [rows, setRows] = useState<VoucherDTO[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [edit, setEdit] = useState<VoucherDTO | "new" | null>(null);
  const load = useCallback(async () => { try { setRows((await apiJson<{ vouchers: VoucherDTO[] }>("/api/engagement/vouchers")).vouchers); setErr(null); } catch (e) { setErr(errMsg(e)); } }, []);
  useEffect(() => { void load(); }, [load]);
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2"><p className="text-sm text-muted-foreground">Discount codes apply before tax in the shop and on invoices.</p><Button touch onClick={() => setEdit("new")}><Plus className="mr-1 h-4 w-4" aria-hidden />New voucher</Button></div>
      {err ? <ErrorState message={err} onRetry={() => void load()} /> : !rows ? <Loading label="Loading vouchers…" /> : rows.length === 0 ? <Empty title="No vouchers yet" text="Create a code such as WELCOME10 for new customers." /> : (
        <TableScroller label="Vouchers">
          <table className="w-full text-sm"><thead className={THEAD}><tr><th className={TH}>Code</th><th className={TH}>Offer</th><th className={TH}>Usage</th><th className={TH}>Status</th><th className={TH}><span className="sr-only">Actions</span></th></tr></thead>
            <tbody className="divide-y divide-border">{rows.map((v) => {
              const pctUsed = v.max_uses ? Math.min(100, Math.round((v.used_count / v.max_uses) * 100)) : null;
              return (
                <tr key={v.id}><td className="px-3 py-2 font-mono">{v.code_upper}<div className="font-sans text-xs text-muted-foreground">{v.name}</div></td><td className="px-3 py-2">{describe(v)}{v.min_subtotal_minor > 0 && <div className="text-xs text-muted-foreground">min {formatMoney(v.min_subtotal_minor, v.currency ?? "USD")}</div>}</td>
                  <td className="px-3 py-2"><div className="tabular-nums">{v.used_count}{v.max_uses ? ` / ${v.max_uses}` : ""}</div>{pctUsed !== null && <div role="progressbar" aria-label={`${v.code_upper} usage`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={pctUsed} className="mt-1 h-1.5 w-24 overflow-hidden rounded-full bg-secondary"><div className="h-full bg-primary" style={{ width: `${pctUsed}%` }} /></div>}</td>
                  <td className="px-3 py-2"><Pill tone={v.active ? "success" : "neutral"}>{v.active ? "Active" : "Off"}</Pill></td><td className="px-3 py-2 text-right"><Button size="sm" variant="outline" touch onClick={() => setEdit(v)}>Edit</Button></td></tr>
              );
            })}</tbody></table>
        </TableScroller>
      )}
      {edit && <VoucherDialog voucher={edit === "new" ? null : edit} onClose={() => setEdit(null)} onDone={() => void load()} />}
    </div>
  );
}
