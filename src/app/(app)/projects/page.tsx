"use client";

import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { FolderKanban, Plus } from "lucide-react";
import { PageContainer } from "@/components/page-container";
import { Button } from "@/components/ui/button";
import { Dialog, DialogFooter } from "@/components/ui/dialog";
import { Banner, Empty, ErrorState, Loading } from "@/components/ui/feedback";
import { Field } from "@/components/ui/field";
import { Checkbox, Input, Select, Textarea } from "@/components/ui/input";
import { LoadMore, usePagedList } from "@/components/ui/load-more";
import { Pill } from "@/components/ui/pill";
import { SearchField } from "@/components/ui/search-field";
import { useDebouncedValue } from "@/components/ui/hooks";
import { fmtMoney } from "@/lib/money/format";
import { PROJECT_STATUSES, PROJECT_STATUS_LABEL, type ProjectBudget, type ProjectDTO, type ProjectProgress, type ProjectStatus } from "@/lib/projects/pure";
import { cn } from "@/lib/utils";
import { PROJECT_TONE, cap, fmtDay, jsonFetch, loadMemberOptions, memberLabel, type MemberOption } from "@/components/projects/shared";

type Row = ProjectDTO & { progress: ProjectProgress | null; budget: ProjectBudget | null };
type Filter = ProjectStatus | "all" | "open";
const isFilter = (v: string | null): v is Filter => v === "all" || v === "open" || (PROJECT_STATUSES as readonly string[]).includes(v ?? "");

export default function ProjectsPage() {
  return (
    <Suspense
      fallback={
        <PageContainer wide title="Projects">
          <Loading label="Loading projects…" />
        </PageContainer>
      }
    >
      <ProjectsInner />
    </Suspense>
  );
}

function ProjectsInner() {
  const router = useRouter();
  const search = useSearchParams();
  const filter: Filter = isFilter(search.get("status")) ? (search.get("status") as Filter) : "open";
  const [q, setQ] = useState(search.get("q") ?? "");
  const dq = useDebouncedValue(q, 300);
  const [showNew, setShowNew] = useState(search.get("new") === "1");
  const [notice, setNotice] = useState<{ tone: "success" | "error"; text: string } | null>(null);
  const [members, setMembers] = useState<MemberOption[]>([]);

  useEffect(() => {
    void loadMemberOptions().then(setMembers);
  }, []);

  const fetchPage = useCallback(
    async (cursor: string | null) => {
      const params = new URLSearchParams({ summary: "1", limit: "24" });
      if (filter !== "all" && filter !== "open") params.set("status", filter);
      if (dq.trim()) params.set("q", dq.trim());
      if (cursor) params.set("cursor", cursor);
      const d = await jsonFetch<{ projects: Row[]; next_cursor: string | null }>(`/api/projects?${params}`, { fallback: "Could not load projects" });
      const rows = filter === "open" ? d.projects.filter((p) => p.status === "planning" || p.status === "active" || p.status === "on_hold") : d.projects;
      return { rows, next_cursor: d.next_cursor };
    },
    [filter, dq]
  );
  const list = usePagedList<Row>(fetchPage);
  useEffect(() => {
    void list.reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetchPage]);

  function setFilter(f: Filter) {
    const params = new URLSearchParams(search.toString());
    params.set("status", f);
    router.replace(`/projects?${params}`);
  }

  const counts = useMemo(() => ({ open: list.rows.filter((p) => p.status === "active").length }), [list.rows]);

  return (
    <PageContainer
      wide
      title="Projects"
      description="Milestones, tasks with owners and due dates, budget vs actual and a timeline — per client job."
      tooltip="Create a project from scratch or from an accepted quote. Log time and expenses against it to see budget burn."
      icon={<FolderKanban className="h-6 w-6 text-primary" aria-hidden />}
      actions={
        <Button touch onClick={() => setShowNew(true)}>
          <Plus className="h-4 w-4" aria-hidden /> New project
        </Button>
      }
    >
      {notice && (
        <Banner tone={notice.tone} onDismiss={() => setNotice(null)} className="mb-4">
          {notice.text}
        </Banner>
      )}
      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center">
        <SearchField value={q} onChange={setQ} label="Search projects" placeholder="Search by name or code…" className="sm:max-w-xs" />
        <div className="flex flex-wrap gap-1.5" role="group" aria-label="Filter by status">
          {(["open", "all", ...PROJECT_STATUSES] as Filter[]).map((f) => (
            <button
              key={f}
              type="button"
              onClick={() => setFilter(f)}
              aria-pressed={filter === f}
              className={cn(
                "min-h-11 touch-manipulation rounded-full border px-3 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none sm:min-h-9",
                filter === f ? "border-primary bg-primary text-primary-foreground" : "border-border bg-card hover:bg-secondary/60"
              )}
            >
              {f === "open" ? "Open" : f === "all" ? "All" : PROJECT_STATUS_LABEL[f]}
            </button>
          ))}
        </div>
      </div>

      {list.error ? (
        <ErrorState message={list.error} onRetry={list.reload} />
      ) : list.loading ? (
        <Loading label="Loading projects…" />
      ) : list.rows.length === 0 ? (
        <Empty
          icon={<FolderKanban className="h-8 w-8" aria-hidden />}
          title={dq || filter !== "open" ? "No projects match" : "No projects yet"}
          text={dq || filter !== "open" ? "Try another filter or search." : "Start from scratch or turn an accepted quote into a project with milestones."}
          action={
            <Button touch onClick={() => setShowNew(true)}>
              <Plus className="h-4 w-4" aria-hidden /> New project
            </Button>
          }
        />
      ) : (
        <>
          <p className="sr-only" aria-live="polite">
            {list.rows.length} projects, {counts.open} active
          </p>
          <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {list.rows.map((p) => (
              <li key={p.id}>
                <ProjectCard p={p} members={members} />
              </li>
            ))}
          </ul>
          <LoadMore hasMore={Boolean(list.cursor)} loading={list.loadingMore} count={list.rows.length} onMore={list.more} noun="projects" className="mt-4" />
        </>
      )}

      {showNew && (
        <NewProjectDialog
          members={members}
          onClose={() => setShowNew(false)}
          onCreated={(p) => {
            setShowNew(false);
            setNotice({ tone: "success", text: `Created ${p.name}.` });
            router.push(`/projects/${encodeURIComponent(p.id)}`);
          }}
        />
      )}
    </PageContainer>
  );
}

function ProjectCard({ p, members }: { p: Row; members: MemberOption[] }) {
  const pct = p.progress?.percent ?? 0;
  const burn = p.budget?.burn_pct;
  const late = p.progress?.days_remaining !== null && p.progress?.days_remaining !== undefined && p.progress.days_remaining < 0 && p.status !== "done" && p.status !== "cancelled";
  return (
    <Link
      href={`/projects/${encodeURIComponent(p.id)}`}
      className="block h-full rounded-xl border border-border bg-card p-4 transition-colors hover:bg-secondary/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none"
      style={p.color ? { borderLeftColor: p.color, borderLeftWidth: 4 } : undefined}
    >
      <div className="mb-2 flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="break-words font-semibold leading-snug">{p.name}</p>
          <p className="truncate text-xs text-muted-foreground">
            {p.code ?? "—"}
            {p.contact_name ? ` · ${p.contact_name}` : ""}
          </p>
        </div>
        <Pill tone={PROJECT_TONE[p.status]} className="shrink-0">
          {PROJECT_STATUS_LABEL[p.status]}
        </Pill>
      </div>
      <div className="mb-1 flex items-center justify-between text-xs text-muted-foreground">
        <span>
          {p.progress ? `${p.progress.tasks_done}/${p.progress.tasks_total} tasks` : "—"}
          {p.progress && p.progress.overdue_tasks > 0 && <span className="ml-1 font-medium text-red-600 dark:text-red-400">· {p.progress.overdue_tasks} overdue</span>}
        </span>
        <span className="tabular-nums">{pct}%</span>
      </div>
      <div className="h-2 w-full overflow-hidden rounded-full bg-secondary" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label="Tasks done">
        <div className="h-full rounded-full bg-primary transition-[width] motion-reduce:transition-none" style={{ width: `${pct}%` }} />
      </div>
      <dl className="mt-3 grid grid-cols-3 gap-2 text-xs">
        <div>
          <dt className="text-muted-foreground">Due</dt>
          <dd className={cn("font-medium tabular-nums", late && "text-red-600 dark:text-red-400")}>{fmtDay(p.due_on)}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Budget</dt>
          <dd className={cn("font-medium tabular-nums", p.budget?.over_budget && "text-red-600 dark:text-red-400")}>
            {p.budget_minor > 0 ? `${burn ?? 0}% used` : "—"}
          </dd>
        </div>
        <div className="min-w-0">
          <dt className="text-muted-foreground">Owner</dt>
          <dd className="truncate font-medium">{memberLabel(members, p.owner_member_id)}</dd>
        </div>
      </dl>
    </Link>
  );
}

interface QuoteOpt {
  id: string;
  number: string;
  contact_name: string | null;
  total_minor: number;
  currency: string;
  status: string;
}

function NewProjectDialog({ members, onClose, onCreated }: { members: MemberOption[]; onClose: () => void; onCreated: (p: ProjectDTO) => void }) {
  const [mode, setMode] = useState<"scratch" | "quote">("scratch");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [status, setStatus] = useState<ProjectStatus>("planning");
  const [startsOn, setStartsOn] = useState("");
  const [dueOn, setDueOn] = useState("");
  const [budget, setBudget] = useState("");
  const [currency, setCurrency] = useState("USD");
  const [billing, setBilling] = useState<"fixed" | "hourly" | "none">("none");
  const [rate, setRate] = useState("");
  const [owner, setOwner] = useState("");
  const [color, setColor] = useState("#6366f1");
  const [quotes, setQuotes] = useState<QuoteOpt[] | null>(null);
  const [quoteId, setQuoteId] = useState("");
  const [milestonesFromItems, setMilestonesFromItems] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (mode !== "quote" || quotes !== null) return;
    jsonFetch<{ quotes: QuoteOpt[] }>("/api/quotes")
      .then((d) => setQuotes(d.quotes))
      .catch(() => setQuotes([]));
  }, [mode, quotes]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      if (mode === "quote") {
        if (!quoteId) throw new Error("Pick a quote");
        const d = await jsonFetch<{ project: ProjectDTO }>("/api/projects/from-quote", {
          method: "POST",
          body: JSON.stringify({ quoteId, ...(name.trim() ? { name: name.trim() } : {}), milestonesFromItems, starts_on: startsOn || null, due_on: dueOn || null }),
          fallback: "Could not create project",
        });
        onCreated(d.project);
        return;
      }
      const d = await jsonFetch<{ project: ProjectDTO }>("/api/projects", {
        method: "POST",
        body: JSON.stringify({
          name: name.trim(),
          description_md: description.trim() || null,
          status,
          starts_on: startsOn || null,
          due_on: dueOn || null,
          budget_minor: Math.round((Number(budget) || 0) * 100),
          currency: currency.trim().toUpperCase() || "USD",
          billing_mode: billing,
          hourly_rate_minor: Math.round((Number(rate) || 0) * 100),
          owner_member_id: owner || null,
          color: color || null,
        }),
        fallback: "Could not create project",
      });
      onCreated(d.project);
    } catch (e2) {
      setErr(e2 instanceof Error ? e2.message : "Could not create project");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog title="New project" description="From scratch, or from a quote (budget, client and milestones come across)." onClose={onClose} size="lg">
      <form onSubmit={submit} className="space-y-3">
        {err && (
          <Banner tone="error" onDismiss={() => setErr(null)}>
            {err}
          </Banner>
        )}
        <div className="flex gap-1.5" role="group" aria-label="Create from">
          {(["scratch", "quote"] as const).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => setMode(m)}
              aria-pressed={mode === m}
              className={cn(
                "min-h-11 touch-manipulation rounded-md border px-3 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:min-h-9",
                mode === m ? "border-primary bg-primary text-primary-foreground" : "border-border hover:bg-secondary/60"
              )}
            >
              {m === "scratch" ? "From scratch" : "From a quote"}
            </button>
          ))}
        </div>
        {mode === "quote" && (
          <>
            <Field label="Quote" required>
              <Select value={quoteId} onChange={(e) => setQuoteId(e.target.value)} required>
                <option value="">{quotes === null ? "Loading quotes…" : quotes.length === 0 ? "No quotes yet" : "Choose a quote"}</option>
                {(quotes ?? []).map((q) => (
                  <option key={q.id} value={q.id}>
                    {q.number} · {q.contact_name ?? "No contact"} · {fmtMoney(q.total_minor, q.currency)} · {cap(q.status)}
                  </option>
                ))}
              </Select>
            </Field>
            <Checkbox label="Create a milestone per quote line item" checked={milestonesFromItems} onChange={(e) => setMilestonesFromItems(e.target.checked)} />
          </>
        )}
        <Field label="Name" required={mode === "scratch"} hint={mode === "quote" ? "Optional — defaults to the client and quote number." : undefined}>
          <Input value={name} onChange={(e) => setName(e.target.value)} required={mode === "scratch"} maxLength={200} placeholder="Kitchen refit — Smith" />
        </Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Starts">
            <Input type="date" value={startsOn} onChange={(e) => setStartsOn(e.target.value)} />
          </Field>
          <Field label="Due">
            <Input type="date" value={dueOn} onChange={(e) => setDueOn(e.target.value)} />
          </Field>
        </div>
        {mode === "scratch" && (
          <>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Status">
                <Select value={status} onChange={(e) => setStatus(e.target.value as ProjectStatus)}>
                  {PROJECT_STATUSES.map((s) => (
                    <option key={s} value={s}>
                      {PROJECT_STATUS_LABEL[s]}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Owner">
                <Select value={owner} onChange={(e) => setOwner(e.target.value)}>
                  <option value="">Me</option>
                  {members.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.label}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>
            <div className="grid gap-3 sm:grid-cols-3">
              <Field label="Budget">
                <Input type="number" min={0} step="0.01" inputMode="decimal" value={budget} onChange={(e) => setBudget(e.target.value)} placeholder="0.00" />
              </Field>
              <Field label="Currency">
                <Input value={currency} onChange={(e) => setCurrency(e.target.value)} maxLength={3} />
              </Field>
              <Field label="Billing">
                <Select value={billing} onChange={(e) => setBilling(e.target.value as typeof billing)}>
                  <option value="none">Not billed</option>
                  <option value="fixed">Fixed price</option>
                  <option value="hourly">Hourly</option>
                </Select>
              </Field>
            </div>
            {billing === "hourly" && (
              <Field label="Hourly rate" hint="Used for time entries logged without a rate.">
                <Input type="number" min={0} step="0.01" inputMode="decimal" value={rate} onChange={(e) => setRate(e.target.value)} />
              </Field>
            )}
            <Field label="Description">
              <Textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={3} maxLength={20_000} />
            </Field>
            <Field label="Colour" hint="Shown on the project card and in lists.">
              <Input type="color" value={color} onChange={(e) => setColor(e.target.value)} className="h-11 w-20 p-1 sm:h-10" />
            </Field>
          </>
        )}
        <DialogFooter>
          <Button type="button" variant="outline" touch onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button type="submit" touch disabled={busy || (mode === "quote" && !quoteId)}>
            {busy ? "Creating…" : "Create project"}
          </Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}
