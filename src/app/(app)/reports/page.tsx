"use client";

import { useCallback, useEffect, useState } from "react";
import { PieChart, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tabs, TabPanel } from "@/components/ui/tabs";
import { Banner, ErrorState } from "@/components/ui/feedback";
import { isAbortError, useAbortable } from "@/components/ui/hooks";
import { PageContainer } from "@/components/page-container";
import { api } from "@/components/finance/shared";
import { ReportBuilder } from "@/components/reports/builder";
import { SavedReports } from "@/components/reports/saved-list";
import { Dashboards } from "@/components/reports/dashboards";
import { AgencyRollup, JobCostingWidget, RangePicker, useRangeQs, useReportRange } from "@/components/reports/job-costing-widget";
import type { Catalogue, SavedReportDTO } from "@/components/reports/types";

type Tab = "builder" | "saved" | "dashboards" | "costing";
const TABS = [
  { id: "dashboards" as const, label: "Dashboards" },
  { id: "builder" as const, label: "Builder" },
  { id: "saved" as const, label: "Saved" },
  { id: "costing" as const, label: "Job costing" },
];

interface Me { role: string; permissions: Record<string, { view: boolean; edit: boolean }> }

/**
 * /reports — Builder (dataset → fields → filters → chart → save), Saved
 * (run / export / schedule), Dashboards (role defaults) and the original
 * Job costing report with the accounting export.
 */
export default function ReportsPage() {
  const [tab, setTab] = useState<Tab>("dashboards");
  const [catalogue, setCatalogue] = useState<Catalogue | null>(null);
  const [reports, setReports] = useState<SavedReportDTO[]>([]);
  const [me, setMe] = useState<Me | null>(null);
  const [editing, setEditing] = useState<SavedReportDTO | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const nextSignal = useAbortable();
  const { preset, range, pick, setRange } = useReportRange();
  const qs = useRangeQs(range)();

  const load = useCallback(async () => {
    const signal = nextSignal();
    setLoading(true);
    setError(null);
    try {
      const [c, s, m] = await Promise.all([
        api<Catalogue>("/api/reports/datasets", { signal }),
        api<{ reports: SavedReportDTO[] }>("/api/reports/saved", { signal }),
        api<Me>("/api/me", { signal }).catch(() => ({ role: "member", permissions: {} }) as Me),
      ]);
      setCatalogue(c);
      setReports(s.reports);
      setMe(m);
    } catch (e) {
      if (isAbortError(e)) return;
      setError(e instanceof Error ? e.message : "Could not load reports.");
    } finally {
      if (!signal.aborted) setLoading(false);
    }
  }, [nextSignal]);
  useEffect(() => { void load(); }, [load]);

  const canEdit = Boolean(me?.permissions?.reports?.edit ?? false);
  const canAdmin = Boolean(me?.permissions?.team?.edit ?? false);
  const counts = { saved: reports.length };

  return (
    <PageContainer
      wide
      title="Reports"
      description="Build reports on any module, save and schedule them, and arrange dashboards per role."
      tooltip="Datasets are limited to the modules your role can view. Dates and buckets use the workspace time zone; money is shown in each row's currency."
      icon={<PieChart className="h-5 w-5" aria-hidden />}
      actions={
        <Button variant="outline" size="icon" touch onClick={() => void load()} disabled={loading} aria-label="Refresh">
          <RefreshCw className={loading ? "h-4 w-4 animate-spin motion-reduce:animate-none" : "h-4 w-4"} aria-hidden />
        </Button>
      }
    >
      <Tabs id="reports-tabs" label="Report sections" tabs={TABS.map((t) => (t.id === "saved" ? { ...t, count: counts.saved } : t))} value={tab} onChange={(t) => { setTab(t); if (t !== "builder") setEditing(null); }} className="mb-5" />
      {error && <ErrorState message={error} onRetry={() => void load()} className="mb-4" />}
      {notice && <Banner tone="success" onDismiss={() => setNotice(null)}>{notice}</Banner>}

      <TabPanel id="reports-tabs" value="dashboards" className={tab === "dashboards" ? "" : "hidden"}>
        {tab === "dashboards" && <Dashboards reports={reports} role={me?.role ?? "member"} canAdmin={canAdmin} />}
      </TabPanel>
      <TabPanel id="reports-tabs" value="builder" className={tab === "builder" ? "" : "hidden"}>
        {tab === "builder" && (
          <ReportBuilder
            key={editing?.id ?? "new"}
            catalogue={catalogue}
            initial={editing}
            canEdit={canEdit}
            onSaved={(r) => {
              setReports((list) => (list.some((x) => x.id === r.id) ? list.map((x) => (x.id === r.id ? r : x)) : [r, ...list]));
              setNotice(`Saved “${r.name}”.`);
              setEditing(null);
              setTab("saved");
            }}
          />
        )}
      </TabPanel>
      <TabPanel id="reports-tabs" value="saved" className={tab === "saved" ? "" : "hidden"}>
        {tab === "saved" && <SavedReports reports={reports} canEdit={canEdit} onEdit={(r) => { setEditing(r); setTab("builder"); }} onChanged={() => void load()} />}
      </TabPanel>
      <TabPanel id="reports-tabs" value="costing" className={tab === "costing" ? "" : "hidden"}>
        {tab === "costing" && (
          <div className="space-y-6">
            <RangePicker preset={preset} range={range} onPreset={pick} onRange={setRange} />
            <JobCostingWidget qs={qs} onShowYear={preset !== "ytd" ? () => pick("ytd") : undefined} />
            <AgencyRollup qs={qs} />
          </div>
        )}
      </TabPanel>
    </PageContainer>
  );
}
