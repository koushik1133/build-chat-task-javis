"use client";

import { Suspense, useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { ArrowLeft, Archive, FolderKanban, Pencil } from "lucide-react";
import { PageContainer } from "@/components/page-container";
import { AttachmentPanel } from "@/components/attachments/attachment-panel";
import { Button } from "@/components/ui/button";
import { Banner, ErrorState, Loading } from "@/components/ui/feedback";
import { Pill } from "@/components/ui/pill";
import { TabPanel, Tabs } from "@/components/ui/tabs";
import { Gantt } from "@/components/projects/gantt";
import { OverviewTab } from "@/components/projects/overview-tab";
import { TasksTab } from "@/components/projects/tasks-tab";
import { CostsTab } from "@/components/projects/costs-tab";
import { EditProjectDialog } from "@/components/projects/edit-project-dialog";
import type { Notice, ProjectDetail } from "@/components/projects/types";
import { PROJECT_STATUS_LABEL, type TimelineData } from "@/lib/projects/pure";
import { PROJECT_TONE, fmtDay, jsonFetch, loadMemberOptions, type MemberOption } from "@/components/projects/shared";

type Tab = "overview" | "tasks" | "timeline" | "costs" | "files";
const TABS: ReadonlyArray<{ id: Tab; label: string }> = [
  { id: "overview", label: "Overview" },
  { id: "tasks", label: "Tasks" },
  { id: "timeline", label: "Timeline" },
  { id: "costs", label: "Time & costs" },
  { id: "files", label: "Files" },
];
const isTab = (v: string | null): v is Tab => TABS.some((t) => t.id === v);


export default function ProjectPage() {
  return (
    <Suspense
      fallback={
        <PageContainer wide title="Project">
          <Loading label="Loading project…" />
        </PageContainer>
      }
    >
      <ProjectInner />
    </Suspense>
  );
}

function ProjectInner() {
  const params = useParams<{ id: string }>();
  const id = String(params?.id ?? "");
  const router = useRouter();
  const search = useSearchParams();
  const tab: Tab = isTab(search.get("tab")) ? (search.get("tab") as Tab) : "overview";
  const [detail, setDetail] = useState<ProjectDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [members, setMembers] = useState<MemberOption[]>([]);
  const [timeline, setTimeline] = useState<TimelineData | null>(null);
  const [timelineErr, setTimelineErr] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);

  const notify = useCallback((tone: Notice["tone"], text: string) => {
    setNotice({ tone, text });
    window.setTimeout(() => setNotice((n) => (n?.text === text ? null : n)), 6000);
  }, []);

  const load = useCallback(async () => {
    setError(null);
    try {
      const d = await jsonFetch<ProjectDetail>(`/api/projects/${encodeURIComponent(id)}`, { fallback: "Could not load project" });
      setDetail(d);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load project");
    }
  }, [id]);

  const loadTimeline = useCallback(async () => {
    setTimelineErr(null);
    try {
      const d = await jsonFetch<{ timeline: TimelineData }>(`/api/projects/${encodeURIComponent(id)}/timeline`, { fallback: "Could not load timeline" });
      setTimeline(d.timeline);
    } catch (err) {
      setTimelineErr(err instanceof Error ? err.message : "Could not load timeline");
    }
  }, [id]);

  useEffect(() => {
    void load();
    void loadMemberOptions().then(setMembers);
  }, [load]);
  useEffect(() => {
    if (tab === "timeline") void loadTimeline();
  }, [tab, loadTimeline]);

  function setTab(t: Tab) {
    const p = new URLSearchParams(search.toString());
    p.set("tab", t);
    router.replace(`/projects/${encodeURIComponent(id)}?${p}`);
  }

  async function archive() {
    if (!detail) return;
    if (!window.confirm(`Archive "${detail.project.name}"? It disappears from the list; tasks and history are kept.`)) return;
    try {
      await jsonFetch(`/api/projects/${encodeURIComponent(id)}`, { method: "DELETE", fallback: "Could not archive" });
      router.push("/projects");
    } catch (err) {
      notify("error", err instanceof Error ? err.message : "Could not archive");
    }
  }

  const p = detail?.project;

  return (
    <PageContainer
      wide
      eyebrow={
        <Link href="/projects" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
          <ArrowLeft className="h-4 w-4" aria-hidden /> Projects
        </Link>
      }
      title={p?.name ?? "Project"}
      description={p ? [p.code, p.contact_name, p.due_on ? `due ${fmtDay(p.due_on)}` : null].filter(Boolean).join(" · ") || undefined : undefined}
      icon={<FolderKanban className="h-6 w-6 text-primary" aria-hidden />}
      actions={
        p ? (
          <div className="flex gap-2">
            <Button variant="outline" touch onClick={() => setEditing(true)}>
              <Pencil className="h-4 w-4" aria-hidden /> Edit
            </Button>
            {!p.archived_at && (
              <Button variant="ghost" touch onClick={archive} aria-label="Archive project">
                <Archive className="h-4 w-4" aria-hidden /> Archive
              </Button>
            )}
          </div>
        ) : undefined
      }
    >
      {p && (
        <div className="mb-4 flex flex-wrap items-center gap-2">
          <Pill tone={PROJECT_TONE[p.status]}>{PROJECT_STATUS_LABEL[p.status]}</Pill>
          {p.archived_at && <Pill tone="warning">Archived</Pill>}
          {p.color && <span className="inline-block h-3 w-3 rounded-full" style={{ background: p.color }} aria-hidden />}
        </div>
      )}
      {notice && (
        <Banner tone={notice.tone} onDismiss={() => setNotice(null)} className="mb-4">
          {notice.text}
        </Banner>
      )}
      {error ? (
        <ErrorState message={error} onRetry={load} />
      ) : !detail ? (
        <Loading label="Loading project…" />
      ) : (
        <>
          <Tabs id="project" label="Project sections" tabs={TABS} value={tab} onChange={setTab} className="mb-4" />
          <TabPanel id="project" value="overview">
            {tab === "overview" && <OverviewTab detail={detail} members={members} reload={load} notify={notify} />}
          </TabPanel>
          <TabPanel id="project" value="tasks">
            {tab === "tasks" && <TasksTab project={detail.project} milestones={detail.milestones} members={members} reloadProject={load} notify={notify} />}
          </TabPanel>
          <TabPanel id="project" value="timeline">
            {tab === "timeline" && (timelineErr ? <ErrorState message={timelineErr} onRetry={loadTimeline} /> : !timeline ? <Loading label="Loading timeline…" /> : <Gantt data={timeline} />)}
          </TabPanel>
          <TabPanel id="project" value="costs">
            {tab === "costs" && <CostsTab project={detail.project} budget={detail.budget} reloadProject={load} notify={notify} />}
          </TabPanel>
          <TabPanel id="project" value="files">
            {tab === "files" && <AttachmentPanel entityKind="project" entityId={detail.project.id} canEdit={!detail.project.archived_at} />}
          </TabPanel>
          {editing && (
            <EditProjectDialog
              project={detail.project}
              members={members}
              onClose={() => setEditing(false)}
              onSaved={() => {
                setEditing(false);
                notify("success", "Project updated.");
                void load();
              }}
            />
          )}
        </>
      )}
    </PageContainer>
  );
}
