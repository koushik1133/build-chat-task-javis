"use client";

import { useCallback, useEffect, useId, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowDown, ArrowUp, ChevronLeft, FlaskConical, Play, Plus, Save, Trash2, Zap } from "lucide-react";
import { PageContainer } from "@/components/page-container";
import { Button } from "@/components/ui/button";
import { Banner, Empty, ErrorState, Loading } from "@/components/ui/feedback";
import { Field } from "@/components/ui/field";
import { Checkbox, Input, Select, Textarea } from "@/components/ui/input";
import { Pill, StatusPill } from "@/components/ui/pill";
import { SearchField } from "@/components/ui/search-field";
import { Tabs, TabPanel } from "@/components/ui/tabs";
import { TableScroller, TH, THEAD } from "@/components/ui/table-scroller";
import { listPaths } from "@/lib/automations/conditions";
import { AutomationDefinitionSchema } from "@/lib/automations/schema";
import { STEP_KINDS, STEP_KIND_LABELS, type AutomationDTO, type AutomationRunDTO, type RunEvent, type Step, type StepKind, type TestPlan } from "@/lib/automations/types";
import { ConditionBuilder } from "./condition-builder";
import { RunDrawer } from "./run-drawer";
import { apiJson, blankAutomation, defaultStep, fmtDate, previewContext, RUN_TONE, runDuration, stepTitle, type Catalog } from "./shared";
import { StepConfigEditor } from "./step-editor";

type Tab = "build" | "test" | "runs";

/** /automations/[id] — trigger picker, condition builder, step list, dry-run panel and run history. */
export function AutomationEditor({ id }: { id: string }) {
  const router = useRouter();
  const isNew = id === "new";
  const listId = `ctx-paths-${useId().replace(/:/g, "")}`;

  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [auto, setAuto] = useState<AutomationDTO | null>(isNew ? blankAutomation() : null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveErr, setSaveErr] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [tab, setTab] = useState<Tab>("build");
  const [eventQuery, setEventQuery] = useState("");
  const [openStep, setOpenStep] = useState<string | null>(null);
  const [addKind, setAddKind] = useState<StepKind>("tool");
  const [plan, setPlan] = useState<TestPlan | null>(null);
  const [planErr, setPlanErr] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const [running, setRunning] = useState(false);
  const [runs, setRuns] = useState<AutomationRunDTO[] | null>(null);
  const [runsErr, setRunsErr] = useState<string | null>(null);
  const [openRun, setOpenRun] = useState<AutomationRunDTO | null>(null);

  const load = useCallback(async () => {
    setLoadErr(null);
    try {
      const [cat, a] = await Promise.all([apiJson<Catalog>("/api/automations/catalog"), isNew ? Promise.resolve(null) : apiJson<{ automation: AutomationDTO }>(`/api/automations/${id}`)]);
      setCatalog(cat);
      if (a) setAuto(a.automation);
    } catch (e) {
      setLoadErr(e instanceof Error ? e.message : "Failed to load");
    }
  }, [id, isNew]);
  useEffect(() => {
    void load();
  }, [load]);

  const loadRuns = useCallback(async () => {
    if (isNew) return;
    setRunsErr(null);
    try {
      const r = await apiJson<{ runs: AutomationRunDTO[] }>(`/api/automations/${id}/runs?limit=50`);
      setRuns(r.runs);
    } catch (e) {
      setRunsErr(e instanceof Error ? e.message : "Failed to load runs");
    }
  }, [id, isNew]);
  useEffect(() => {
    if (tab === "runs" && runs === null) void loadRuns();
  }, [tab, runs, loadRuns]);

  const update = (patch: Partial<AutomationDTO>) => {
    setAuto((a) => (a ? { ...a, ...patch } : a));
    setDirty(true);
    setSaved(false);
  };

  const selectedEvent = useMemo(() => catalog?.events.find((e) => e.type === auto?.trigger_config.event_type) ?? null, [catalog, auto?.trigger_config.event_type]);
  const sampleEvent: RunEvent | null = selectedEvent?.sample ?? null;
  const context = useMemo(() => previewContext(sampleEvent, { id, name: auto?.name ?? "" }), [sampleEvent, id, auto?.name]);
  const fieldOptions = useMemo(() => {
    const base = ["event.type", "event.entity", "event.entity_id", "org.id", "org.name", "automation.name", "now", ...listPaths(context.event.data, "event.data"), "entity.id", "entity.status", "entity.name"];
    for (const s of auto?.steps ?? []) base.push(`steps.${s.id}`);
    return [...new Set(base)];
  }, [context, auto?.steps]);

  const filteredEvents = useMemo(() => {
    const q = eventQuery.trim().toLowerCase();
    const list = catalog?.events ?? [];
    return q ? list.filter((e) => e.type.includes(q) || e.entity.includes(q)) : list;
  }, [catalog, eventQuery]);

  const validation = useMemo(() => {
    if (!auto) return null;
    const r = AutomationDefinitionSchema.safeParse(definitionOf(auto));
    return r.success ? null : r.error.issues.map((i) => `${i.path.join(".") || "automation"}: ${i.message}`);
  }, [auto]);

  const save = async () => {
    if (!auto) return;
    setSaving(true);
    setSaveErr(null);
    try {
      if (isNew) {
        const r = await apiJson<{ automation: AutomationDTO }>("/api/automations", { method: "POST", json: definitionOf(auto) });
        router.replace(`/automations/${r.automation.id}`);
        setAuto(r.automation);
      } else {
        const r = await apiJson<{ automation: AutomationDTO }>(`/api/automations/${id}`, { method: "PATCH", json: definitionOf(auto) });
        setAuto(r.automation);
      }
      setDirty(false);
      setSaved(true);
    } catch (e) {
      setSaveErr(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  };

  const test = async () => {
    if (!auto) return;
    setTesting(true);
    setPlanErr(null);
    try {
      const r = await apiJson<{ plan: TestPlan }>(`/api/automations/${id}/test`, { method: "POST", json: { definition: definitionOf(auto), ...(sampleEvent ? { event: { type: sampleEvent.type, data: sampleEvent.data } } : {}) } });
      setPlan(r.plan);
    } catch (e) {
      setPlanErr(e instanceof Error ? e.message : "Test failed");
    } finally {
      setTesting(false);
    }
  };

  const runNow = async () => {
    if (isNew || !auto) return;
    setRunning(true);
    setPlanErr(null);
    try {
      const r = await apiJson<{ run: AutomationRunDTO | null }>(`/api/automations/${id}/run`, { method: "POST", json: sampleEvent ? { event: { type: sampleEvent.type, data: sampleEvent.data } } : {} });
      setRuns(null);
      setTab("runs");
      if (r.run) setOpenRun(r.run);
    } catch (e) {
      setPlanErr(e instanceof Error ? e.message : "Run failed");
    } finally {
      setRunning(false);
    }
  };

  const moveStep = (i: number, dir: -1 | 1) => {
    if (!auto) return;
    const steps = [...auto.steps];
    const j = i + dir;
    if (j < 0 || j >= steps.length) return;
    [steps[i], steps[j]] = [steps[j], steps[i]];
    update({ steps });
  };

  if (loadErr) return <PageContainer title="Automation"><ErrorState message={loadErr} onRetry={() => void load()} /></PageContainer>;
  if (!auto || !catalog) return <PageContainer title="Automation"><Loading label="Loading automation…" /></PageContainer>;

  const tabs = [
    { id: "build" as const, label: "Build" },
    { id: "test" as const, label: "Test" },
    { id: "runs" as const, label: "Runs", count: auto.run_count || undefined },
  ];

  return (
    <PageContainer
      wide
      eyebrow={
        <Link href="/automations" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
          <ChevronLeft className="h-4 w-4" aria-hidden /> Automations
        </Link>
      }
      title={auto.name || (isNew ? "New automation" : "Automation")}
      description={isNew ? "Pick a trigger, add conditions and steps, then test it against a sample event." : `v${auto.version} · ${auto.run_count} runs · ${auto.error_count} errors${auto.legacy ? " · converted from a legacy automation (saving stores the new format)" : ""}`}
      icon={<Zap className="h-5 w-5" aria-hidden />}
      actions={
        <div className="flex flex-wrap items-center gap-2">
          <Checkbox label="Enabled" checked={auto.enabled} onChange={(e) => update({ enabled: e.target.checked })} />
          <Button type="button" variant="outline" onClick={test} disabled={testing}>
            <FlaskConical className="h-4 w-4" aria-hidden /> {testing ? "Testing…" : "Test"}
          </Button>
          {!isNew && (
            <Button type="button" variant="outline" onClick={runNow} disabled={running || dirty} title={dirty ? "Save first" : "Queue a real run with the sample event"}>
              <Play className="h-4 w-4" aria-hidden /> {running ? "Running…" : "Run now"}
            </Button>
          )}
          <Button type="button" onClick={save} disabled={saving || Boolean(validation) || (!dirty && !isNew)}>
            <Save className="h-4 w-4" aria-hidden /> {saving ? "Saving…" : isNew ? "Create" : "Save"}
          </Button>
        </div>
      }
    >
      {saveErr && <Banner tone="error" onDismiss={() => setSaveErr(null)}>{saveErr}</Banner>}
      {saved && !dirty && <Banner tone="success" onDismiss={() => setSaved(false)}>Saved.</Banner>}
      {auto.last_error && <Banner tone="warn">Last error: {auto.last_error}</Banner>}
      {validation && dirty && (
        <Banner tone="warn">
          <ul className="list-disc pl-4">
            {validation.slice(0, 5).map((v) => (
              <li key={v}>{v}</li>
            ))}
          </ul>
        </Banner>
      )}

      <Tabs id="automation-tabs" label="Automation sections" tabs={tabs} value={tab} onChange={setTab} className="mb-4" />

      <TabPanel id="build" value={tab}>
        <div className="space-y-6">
          <section className="grid gap-3 rounded-xl border border-border bg-card p-4 sm:grid-cols-2" aria-labelledby="sec-basics">
            <h2 id="sec-basics" className="sr-only">Basics</h2>
            <Field label="Name" required>
              <Input value={auto.name} onChange={(e) => update({ name: e.target.value })} placeholder="e.g. Overdue invoice reminder" />
            </Field>
            <Field label="Autonomy" hint="Approve: gated writes pause in the Approvals inbox. Auto: everything runs unattended.">
              <Select value={auto.autonomy} onChange={(e) => update({ autonomy: e.target.value as "auto" | "approve" })}>
                <option value="approve">Approve gated writes</option>
                <option value="auto">Fully automatic</option>
              </Select>
            </Field>
            <Field label="Description" className="sm:col-span-2">
              <Textarea rows={2} value={auto.description ?? ""} onChange={(e) => update({ description: e.target.value || null })} />
            </Field>
          </section>

          <section className="rounded-xl border border-border bg-card p-4" aria-labelledby="sec-trigger">
            <h2 id="sec-trigger" className="mb-3 text-sm font-semibold">1. Trigger</h2>
            <div className="grid gap-3 sm:grid-cols-[200px_1fr]">
              <Field label="Type">
                <Select
                  value={auto.trigger_type}
                  onChange={(e) => {
                    const t = e.target.value as AutomationDTO["trigger_type"];
                    update({
                      trigger_type: t,
                      trigger_config:
                        t === "schedule"
                          ? { schedule: auto.trigger_config.schedule ?? { time: "09:00", timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC", days: "daily" } }
                          : t === "webhook"
                            ? { webhook: auto.trigger_config.webhook ?? { token: cryptoToken() } }
                            : t === "event"
                              ? { event_type: auto.trigger_config.event_type ?? "" }
                              : {},
                    });
                  }}
                >
                  <option value="event">When an event happens</option>
                  <option value="schedule">On a schedule</option>
                  <option value="webhook">Inbound webhook</option>
                  <option value="manual">Manual only</option>
                </Select>
              </Field>
              {auto.trigger_type === "event" && (
                <div className="space-y-2">
                  <SearchField label="Search events" placeholder="invoice, ticket, booking…" value={eventQuery} onChange={setEventQuery} />
                  <div className="grid gap-2 md:grid-cols-2">
                    <ul className="max-h-56 overflow-y-auto rounded-md border border-border" aria-label="Event types">
                      {filteredEvents.map((e) => {
                        const active = e.type === auto.trigger_config.event_type;
                        return (
                          <li key={e.type}>
                            <button
                              type="button"
                              onClick={() => update({ trigger_config: { ...auto.trigger_config, event_type: e.type } })}
                              aria-pressed={active}
                              className={`flex min-h-11 w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm hover:bg-secondary/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:min-h-0 ${active ? "bg-primary/10 font-medium" : ""}`}
                            >
                              <span className="truncate">{e.type}</span>
                              {e.recent_count > 0 && <Pill tone="info">{e.recent_count} / 30d</Pill>}
                            </button>
                          </li>
                        );
                      })}
                      {filteredEvents.length === 0 && <li className="px-3 py-2 text-sm text-muted-foreground">No events match.</li>}
                    </ul>
                    <div className="rounded-md border border-dashed border-border bg-secondary/30 p-3">
                      <p className="mb-1 text-[11px] uppercase tracking-wide text-muted-foreground">Sample payload{selectedEvent ? ` · ${selectedEvent.type}` : ""}</p>
                      {selectedEvent ? (
                        <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words text-xs">{JSON.stringify(selectedEvent.sample, null, 2)}</pre>
                      ) : (
                        <p className="text-xs text-muted-foreground">Pick an event, or type a wildcard like <code>invoice.*</code> below.</p>
                      )}
                      <Input className="mt-2" aria-label="Event type or wildcard" placeholder="invoice.* or ticket.created" value={auto.trigger_config.event_type ?? ""} onChange={(e) => update({ trigger_config: { ...auto.trigger_config, event_type: e.target.value } })} />
                    </div>
                  </div>
                </div>
              )}
              {auto.trigger_type === "schedule" && auto.trigger_config.schedule && (
                <div className="grid gap-3 sm:grid-cols-3">
                  <Field label="Time (24h)">
                    <Input type="time" value={auto.trigger_config.schedule.time} onChange={(e) => update({ trigger_config: { schedule: { ...auto.trigger_config.schedule!, time: e.target.value } } })} />
                  </Field>
                  <Field label="Timezone">
                    <Input value={auto.trigger_config.schedule.timezone} onChange={(e) => update({ trigger_config: { schedule: { ...auto.trigger_config.schedule!, timezone: e.target.value } } })} />
                  </Field>
                  <Field label="Days">
                    <Select value={auto.trigger_config.schedule.days} onChange={(e) => update({ trigger_config: { schedule: { ...auto.trigger_config.schedule!, days: e.target.value } } })}>
                      {["daily", "weekdays", "mon", "tue", "wed", "thu", "fri", "sat", "sun"].map((d) => (
                        <option key={d} value={d}>
                          {d}
                        </option>
                      ))}
                    </Select>
                  </Field>
                </div>
              )}
              {auto.trigger_type === "webhook" && (
                <div className="space-y-2 text-sm">
                  <p className="text-muted-foreground">
                    POST JSON to <code className="break-all">/api/automations/hooks/{isNew ? "{id}" : id}?token=…</code>. The body becomes <code>event.data</code>.
                  </p>
                  <Field label="Shared token">
                    <div className="flex gap-2">
                      <Input readOnly value={auto.trigger_config.webhook?.token ?? ""} aria-label="Webhook token" />
                      <Button type="button" variant="outline" onClick={() => update({ trigger_config: { webhook: { token: cryptoToken() } } })}>
                        Rotate
                      </Button>
                    </div>
                  </Field>
                </div>
              )}
              {auto.trigger_type === "manual" && <p className="text-sm text-muted-foreground">Runs only from “Run now”, the API or an agent.</p>}
            </div>
          </section>

          <section className="rounded-xl border border-border bg-card p-4" aria-labelledby="sec-conditions">
            <h2 id="sec-conditions" className="mb-1 text-sm font-semibold">2. Conditions</h2>
            <p className="mb-3 text-xs text-muted-foreground">Fields are dotted paths over the run context: <code>event.data.*</code>, <code>entity.*</code> (the record the event is about), <code>org.*</code>.</p>
            <ConditionBuilder value={auto.conditions} onChange={(c) => update({ conditions: c })} fieldOptions={fieldOptions} listId={listId} />
          </section>

          <section className="rounded-xl border border-border bg-card p-4" aria-labelledby="sec-steps">
            <h2 id="sec-steps" className="mb-3 text-sm font-semibold">3. Steps</h2>
            {auto.steps.length === 0 && <Empty title="No steps yet" text="Add a tool call, a notification, a delay or a branch." />}
            <ol className="space-y-2">
              {auto.steps.map((s, i) => {
                const open = openStep === s.id;
                return (
                  <li key={s.id} className="rounded-lg border border-border">
                    <div className="flex flex-wrap items-center gap-2 px-3 py-2">
                      <button type="button" onClick={() => setOpenStep(open ? null : s.id)} aria-expanded={open} className="flex min-h-11 flex-1 items-center gap-2 text-left text-sm sm:min-h-0">
                        <span className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-secondary text-xs font-medium">{i + 1}</span>
                        <span className="font-medium">{stepTitle(s)}</span>
                        <Pill>{STEP_KIND_LABELS[s.kind]}</Pill>
                        <span className="text-xs text-muted-foreground">#{s.id}</span>
                      </button>
                      <div className="flex items-center gap-1">
                        <Button type="button" variant="ghost" size="icon-sm" touch aria-label="Move up" disabled={i === 0} onClick={() => moveStep(i, -1)}>
                          <ArrowUp className="h-4 w-4" aria-hidden />
                        </Button>
                        <Button type="button" variant="ghost" size="icon-sm" touch aria-label="Move down" disabled={i === auto.steps.length - 1} onClick={() => moveStep(i, 1)}>
                          <ArrowDown className="h-4 w-4" aria-hidden />
                        </Button>
                        <Button type="button" variant="ghost" size="icon-sm" touch aria-label="Remove step" onClick={() => update({ steps: auto.steps.filter((x) => x.id !== s.id) })}>
                          <Trash2 className="h-4 w-4" aria-hidden />
                        </Button>
                      </div>
                    </div>
                    {open && (
                      <div className="space-y-3 border-t border-border p-3">
                        <div className="grid gap-3 sm:grid-cols-2">
                          <Field label="Step id" hint="Used by branches and {{steps.<id>}}">
                            <Input value={s.id} onChange={(e) => update({ steps: auto.steps.map((x) => (x.id === s.id ? ({ ...x, id: e.target.value.replace(/[^a-zA-Z0-9_-]/g, "") } as Step) : x)) })} />
                          </Field>
                          <Field label="Label (optional)">
                            <Input value={s.name ?? ""} onChange={(e) => update({ steps: auto.steps.map((x) => (x.id === s.id ? ({ ...x, name: e.target.value || undefined } as Step) : x)) })} />
                          </Field>
                        </div>
                        <StepConfigEditor step={s} onChange={(n) => update({ steps: auto.steps.map((x) => (x.id === s.id ? n : x)) })} catalog={catalog} context={context} listId={listId} allSteps={auto.steps} />
                      </div>
                    )}
                  </li>
                );
              })}
            </ol>
            <div className="mt-3 flex flex-wrap items-end gap-2">
              <Field label="Add a step">
                <Select value={addKind} onChange={(e) => setAddKind(e.target.value as StepKind)}>
                  {STEP_KINDS.map((k) => (
                    <option key={k} value={k}>
                      {STEP_KIND_LABELS[k]}
                    </option>
                  ))}
                </Select>
              </Field>
              <Button
                type="button"
                variant="outline"
                disabled={auto.steps.length >= 25}
                onClick={() => {
                  const s = defaultStep(addKind, auto.steps);
                  update({ steps: [...auto.steps, s] });
                  setOpenStep(s.id);
                }}
              >
                <Plus className="h-4 w-4" aria-hidden /> Add
              </Button>
              <span className="text-xs text-muted-foreground">{auto.steps.length}/25</span>
            </div>
          </section>
        </div>
      </TabPanel>

      <TabPanel id="test" value={tab}>
        <div className="space-y-4">
          <Banner tone="info">A test renders every step against the sample event and reports what would happen. Nothing is executed or sent.</Banner>
          {planErr && <Banner tone="error">{planErr}</Banner>}
          <div className="flex flex-wrap gap-2">
            <Button type="button" onClick={test} disabled={testing}>
              <FlaskConical className="h-4 w-4" aria-hidden /> {testing ? "Testing…" : `Test with ${sampleEvent ? sampleEvent.type : "a synthetic event"}`}
            </Button>
          </div>
          {plan && (
            <div className="space-y-3">
              <Banner tone={plan.matched ? "success" : "warn"}>{plan.matched ? "Trigger and conditions match the sample event." : plan.reason}</Banner>
              <ol className="space-y-2">
                {plan.steps.map((p, i) => (
                  <li key={`${p.step_id}-${i}`} className="rounded-lg border border-border p-3">
                    <div className="flex flex-wrap items-center gap-2 text-sm">
                      <span className="font-medium">
                        {i + 1}. {p.name ?? p.step_id}
                      </span>
                      <Pill>{p.kind}</Pill>
                      {p.would_pause && <Pill tone="warning">pauses for approval</Pill>}
                    </div>
                    <p className="mt-1 text-sm">{p.summary}</p>
                    {p.warnings.length > 0 && (
                      <ul className="mt-1 list-disc pl-5 text-xs text-destructive">
                        {p.warnings.map((w) => (
                          <li key={w}>{w}</li>
                        ))}
                      </ul>
                    )}
                    <details className="mt-2">
                      <summary className="cursor-pointer text-xs text-muted-foreground">Rendered</summary>
                      <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded bg-secondary/40 p-2 text-xs">{JSON.stringify(p.rendered, null, 2)}</pre>
                    </details>
                  </li>
                ))}
              </ol>
            </div>
          )}
        </div>
      </TabPanel>

      <TabPanel id="runs" value={tab}>
        {isNew ? (
          <Empty title="Save the automation first" text="Runs appear here once the automation has fired." />
        ) : runsErr ? (
          <ErrorState message={runsErr} onRetry={() => void loadRuns()} />
        ) : runs === null ? (
          <Loading label="Loading runs…" />
        ) : runs.length === 0 ? (
          <Empty title="No runs yet" text="Runs are created when the trigger fires, or from “Run now”." />
        ) : (
          <TableScroller label="Run history">
            <table className="w-full text-sm">
              <thead className={THEAD}>
                <tr>
                  <th className={TH}>Started</th>
                  <th className={TH}>Status</th>
                  <th className={TH}>Event</th>
                  <th className={TH}>Steps</th>
                  <th className={TH}>Duration</th>
                  <th className={TH}>Error</th>
                </tr>
              </thead>
              <tbody>
                {runs.map((r) => (
                  <tr key={r.id} className="cursor-pointer border-t border-border hover:bg-secondary/40" onClick={() => setOpenRun(r)}>
                    <td className="px-3 py-2">
                      <button type="button" className="text-left underline-offset-2 hover:underline" onClick={() => setOpenRun(r)}>
                        {fmtDate(r.created_at)}
                      </button>
                    </td>
                    <td className="px-3 py-2"><StatusPill status={r.status} map={RUN_TONE} /></td>
                    <td className="px-3 py-2 text-xs">{r.context?.event.type ?? "—"}</td>
                    <td className="px-3 py-2 tabular-nums">{r.step_results.length}</td>
                    <td className="px-3 py-2 tabular-nums">{runDuration(r)}</td>
                    <td className="max-w-[16rem] truncate px-3 py-2 text-xs text-destructive">{r.error ?? ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableScroller>
        )}
      </TabPanel>

      {openRun && (
        <RunDrawer
          run={openRun}
          onClose={() => setOpenRun(null)}
          onRetried={(r) => {
            setOpenRun(r);
            setRuns((rs) => (rs ? rs.map((x) => (x.id === r.id ? r : x)) : rs));
          }}
        />
      )}
    </PageContainer>
  );
}

function definitionOf(a: AutomationDTO) {
  return { name: a.name, description: a.description ?? null, trigger_type: a.trigger_type, trigger_config: a.trigger_config, conditions: a.conditions, steps: a.steps, autonomy: a.autonomy, enabled: a.enabled };
}

function cryptoToken(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
