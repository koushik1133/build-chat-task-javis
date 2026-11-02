"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { ArrowLeft, Loader2, Plus, ShieldCheck, Star, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox, Input } from "@/components/ui/input";
import { Field } from "@/components/ui/field";
import { Banner, Empty, ErrorState, Loading } from "@/components/ui/feedback";
import { Pill } from "@/components/ui/pill";
import { TableScroller } from "@/components/ui/table-scroller";
import { PageContainer } from "@/components/page-container";
import { TICKET_PRIORITIES, parsePriorityOverrides, type PriorityOverrides, type TicketPriority } from "@/lib/helpdesk/sla";
import type { SlaPolicyRow } from "@/lib/helpdesk/tickets";

type Draft = {
  name: string;
  first_response_minutes: number;
  resolution_minutes: number;
  business_hours_only: boolean;
  is_default: boolean;
  overrides: Record<TicketPriority, { first: string; resolution: string }>;
};

const EMPTY: Draft = {
  name: "",
  first_response_minutes: 60,
  resolution_minutes: 1440,
  business_hours_only: false,
  is_default: false,
  overrides: { low: { first: "", resolution: "" }, normal: { first: "", resolution: "" }, high: { first: "", resolution: "" }, urgent: { first: "", resolution: "" } },
};

function toDraft(p: SlaPolicyRow): Draft {
  const o = parsePriorityOverrides(p.priority_overrides);
  const overrides = { ...EMPTY.overrides };
  for (const pr of TICKET_PRIORITIES) {
    overrides[pr] = { first: o[pr]?.first_response_minutes?.toString() ?? "", resolution: o[pr]?.resolution_minutes?.toString() ?? "" };
  }
  return { name: p.name, first_response_minutes: p.first_response_minutes, resolution_minutes: p.resolution_minutes, business_hours_only: p.business_hours_only, is_default: p.is_default, overrides };
}

function toBody(d: Draft) {
  const priority_overrides: PriorityOverrides = {};
  for (const pr of TICKET_PRIORITIES) {
    const f = Number(d.overrides[pr].first);
    const r = Number(d.overrides[pr].resolution);
    const entry: { first_response_minutes?: number; resolution_minutes?: number } = {};
    if (d.overrides[pr].first && f > 0) entry.first_response_minutes = Math.floor(f);
    if (d.overrides[pr].resolution && r > 0) entry.resolution_minutes = Math.floor(r);
    if (Object.keys(entry).length) priority_overrides[pr] = entry;
  }
  return {
    name: d.name.trim(),
    first_response_minutes: Math.max(1, Math.floor(d.first_response_minutes)),
    resolution_minutes: Math.max(1, Math.floor(d.resolution_minutes)),
    business_hours_only: d.business_hours_only,
    is_default: d.is_default,
    priority_overrides: Object.keys(priority_overrides).length ? priority_overrides : null,
  };
}

function minutesLabel(m: number): string {
  if (m % 1440 === 0) return `${m / 1440} day${m / 1440 === 1 ? "" : "s"}`;
  if (m % 60 === 0) return `${m / 60} hour${m / 60 === 1 ? "" : "s"}`;
  return `${m} min`;
}

type Notice = { tone: "success" | "error"; text: string };

export default function SlaPoliciesPage() {
  const [policies, setPolicies] = useState<SlaPolicyRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ id: string | null; draft: Draft } | null>(null);
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const formHeading = useRef<HTMLHeadingElement>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/helpdesk/sla", { cache: "no-store" });
      if (!res.ok) throw new Error(`Could not load policies (${res.status})`);
      setPolicies((await res.json()).policies ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load policies");
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  // Move focus into the form when it opens so keyboard and screen-reader users land on it.
  const formOpen = editing ? (editing.id ?? "new") : null;
  useEffect(() => {
    if (formOpen !== null) formHeading.current?.focus();
  }, [formOpen]);

  function flash(tone: Notice["tone"], text: string) {
    setNotice({ tone, text });
    window.setTimeout(() => setNotice((n) => (n?.text === text ? null : n)), 5000);
  }

  function startEdit(id: string | null, draft: Draft) {
    setFormError(null);
    setEditing({ id, draft });
  }

  async function save() {
    if (!editing) return;
    setBusy(true);
    setFormError(null);
    try {
      const body = toBody(editing.draft);
      if (!body.name) throw new Error("Give the policy a name.");
      const res = await fetch(editing.id ? `/api/helpdesk/sla?id=${editing.id}` : "/api/helpdesk/sla", {
        method: editing.id ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.error === "invalid_body" ? "Check the numbers: every target must be a positive whole number of minutes." : d.error || `Could not save the policy (${res.status})`);
      }
      setEditing(null);
      flash("success", editing.id ? "Policy updated." : "Policy created.");
      void load();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : "Could not save the policy");
    } finally {
      setBusy(false);
    }
  }

  async function remove(p: SlaPolicyRow) {
    if (!window.confirm(`Delete “${p.name}”? Tickets using it keep their current deadlines but lose the policy link.`)) return;
    const res = await fetch(`/api/helpdesk/sla?id=${p.id}`, { method: "DELETE" });
    if (!res.ok) {
      flash("error", "Could not delete the policy.");
      return;
    }
    flash("success", "Policy deleted.");
    void load();
  }

  const d = editing?.draft;
  const setD = (patch: Partial<Draft>) => setEditing((e) => (e ? { ...e, draft: { ...e.draft, ...patch } } : e));

  return (
    <PageContainer
      title="SLA policies"
      description="Set how fast a first reply and a resolution must happen. Tickets use the default policy unless you choose another."
      tooltip="First reply = time until someone replies publicly. Resolution = time until the ticket is marked resolved. Business-hours policies only count Monday–Friday 09:00–17:00 UTC."
      eyebrow={
        <Link
          href="/helpdesk"
          className="inline-flex min-h-11 items-center gap-1 rounded text-xs text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:min-h-0"
        >
          <ArrowLeft className="h-3.5 w-3.5" aria-hidden /> Helpdesk
        </Link>
      }
      actions={
        <Button touch onClick={() => startEdit(null, { ...EMPTY, is_default: policies.length === 0 })} disabled={Boolean(editing)}>
          <Plus className="h-4 w-4" aria-hidden /> New policy
        </Button>
      }
    >
      {notice && (
        <Banner tone={notice.tone} onDismiss={() => setNotice(null)}>
          {notice.text}
        </Banner>
      )}

      {loading ? (
        <Loading label="Loading policies…" className="rounded-xl border border-border bg-card py-12" />
      ) : error ? (
        <ErrorState message={error} onRetry={() => void load()} />
      ) : policies.length === 0 && !editing ? (
        <Empty
          icon={<ShieldCheck className="h-5 w-5" />}
          title="No SLA policy yet"
          text="Without one, tickets have no deadlines and never escalate. Start with 1 hour to reply and 1 day to resolve."
          action={
            <Button onClick={() => startEdit(null, { ...EMPTY, name: "Standard support", is_default: true })}>
              <Plus className="h-4 w-4" aria-hidden /> Create default policy
            </Button>
          }
        />
      ) : (
        <ul className="space-y-3">
          {policies.map((p) => {
            const o = parsePriorityOverrides(p.priority_overrides);
            return (
              <li key={p.id} className="rounded-xl border border-border bg-card p-4">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                  <div className="min-w-0">
                    <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
                      {p.name}
                      {p.is_default && (
                        <Pill tone="accent">
                          <Star className="h-3 w-3" aria-hidden /> Default
                        </Pill>
                      )}
                      {p.business_hours_only && <Pill>Business hours</Pill>}
                    </p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      First reply {minutesLabel(p.first_response_minutes)} · Resolution {minutesLabel(p.resolution_minutes)}
                    </p>
                    {Object.keys(o).length > 0 && (
                      <p className="mt-1 text-xs text-muted-foreground">
                        Overrides:{" "}
                        {TICKET_PRIORITIES.filter((pr) => o[pr])
                          .map((pr) => {
                            const fr = o[pr]?.first_response_minutes;
                            const rs = o[pr]?.resolution_minutes;
                            return `${pr} ${fr ? minutesLabel(fr) : "—"} / ${rs ? minutesLabel(rs) : "—"}`;
                          })
                          .join(", ")}
                      </p>
                    )}
                  </div>
                  <div className="flex shrink-0 gap-2">
                    <Button variant="outline" size="sm" touch onClick={() => startEdit(p.id, toDraft(p))} aria-label={`Edit ${p.name}`}>
                      Edit
                    </Button>
                    <Button variant="ghost" size="icon-sm" touch onClick={() => void remove(p)} aria-label={`Delete ${p.name}`}>
                      <Trash2 className="h-3.5 w-3.5" aria-hidden />
                    </Button>
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {editing && d && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
          className="mt-6 space-y-4 rounded-xl border border-primary/40 bg-card p-4 sm:p-5"
          aria-labelledby="sla-form-title"
        >
          <h2 id="sla-form-title" ref={formHeading} tabIndex={-1} className="text-sm font-semibold outline-none">
            {editing.id ? "Edit policy" : "New policy"}
          </h2>
          <Field label="Name" required>
            <Input required maxLength={100} value={d.name} onChange={(e) => setD({ name: e.target.value })} placeholder="Standard support" />
          </Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="First reply (minutes)" hint={`= ${minutesLabel(Math.max(1, d.first_response_minutes || 1))}`}>
              <Input type="number" inputMode="numeric" min={1} step={1} required value={d.first_response_minutes} onChange={(e) => setD({ first_response_minutes: Number(e.target.value) })} />
            </Field>
            <Field label="Resolution (minutes)" hint={`= ${minutesLabel(Math.max(1, d.resolution_minutes || 1))}`}>
              <Input type="number" inputMode="numeric" min={1} step={1} required value={d.resolution_minutes} onChange={(e) => setD({ resolution_minutes: Number(e.target.value) })} />
            </Field>
          </div>
          <div className="flex flex-wrap gap-x-6 gap-y-2">
            <Checkbox checked={d.business_hours_only} onChange={(e) => setD({ business_hours_only: e.target.checked })} label="Count business hours only (Mon–Fri 09:00–17:00 UTC)" labelClassName="text-xs" />
            <Checkbox checked={d.is_default} onChange={(e) => setD({ is_default: e.target.checked })} label="Use as the default for new tickets" labelClassName="text-xs" />
          </div>

          <fieldset>
            <legend className="mb-2 text-xs font-medium">
              Per-priority overrides <span className="font-normal text-muted-foreground">(minutes; blank uses the policy default)</span>
            </legend>
            <TableScroller label="Per-priority overrides">
              <table className="w-full min-w-[22rem] text-xs">
                <thead className="bg-secondary/40 text-muted-foreground">
                  <tr>
                    <th scope="col" className="px-3 py-2 text-left font-medium">
                      Priority
                    </th>
                    <th scope="col" className="px-3 py-2 text-left font-medium">
                      First reply
                    </th>
                    <th scope="col" className="px-3 py-2 text-left font-medium">
                      Resolution
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {TICKET_PRIORITIES.map((pr) => (
                    <tr key={pr}>
                      <th scope="row" className="px-3 py-1.5 text-left font-medium capitalize">
                        {pr}
                      </th>
                      <td className="px-3 py-1.5">
                        <Input
                          aria-label={`${pr} first reply minutes`}
                          type="number"
                          inputMode="numeric"
                          min={1}
                          step={1}
                          value={d.overrides[pr].first}
                          onChange={(e) => setD({ overrides: { ...d.overrides, [pr]: { ...d.overrides[pr], first: e.target.value } } })}
                          className="sm:h-8"
                        />
                      </td>
                      <td className="px-3 py-1.5">
                        <Input
                          aria-label={`${pr} resolution minutes`}
                          type="number"
                          inputMode="numeric"
                          min={1}
                          step={1}
                          value={d.overrides[pr].resolution}
                          onChange={(e) => setD({ overrides: { ...d.overrides, [pr]: { ...d.overrides[pr], resolution: e.target.value } } })}
                          className="sm:h-8"
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableScroller>
          </fieldset>

          {formError && (
            <Banner tone="error" onDismiss={() => setFormError(null)} className="mb-0">
              {formError}
            </Banner>
          )}
          <div className="flex flex-wrap justify-end gap-2">
            <Button type="button" variant="outline" touch onClick={() => setEditing(null)} disabled={busy}>
              Cancel
            </Button>
            <Button type="submit" touch disabled={busy}>
              {busy && <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden />} {editing.id ? "Save changes" : "Create policy"}
            </Button>
          </div>
        </form>
      )}
    </PageContainer>
  );
}
