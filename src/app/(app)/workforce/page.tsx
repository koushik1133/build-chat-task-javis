"use client";

import { Suspense, useCallback, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { CalendarClock } from "lucide-react";
import { PageContainer } from "@/components/page-container";
import { Banner, Loading } from "@/components/ui/feedback";
import { TabPanel, Tabs } from "@/components/ui/tabs";
import { RotaTab } from "@/components/workforce/rota-tab";
import { StaffTab } from "@/components/workforce/staff-tab";
import { LeaveTab } from "@/components/workforce/leave-tab";
import { AttendanceTab } from "@/components/workforce/attendance-tab";
import { PayrollTab } from "@/components/workforce/payroll-tab";
import { jsonFetch } from "@/components/workforce/shared";
import type { StaffDTO } from "@/lib/workforce/pure";

type Tab = "rota" | "staff" | "leave" | "attendance" | "payroll";
const TABS: ReadonlyArray<{ id: Tab; label: string }> = [
  { id: "rota", label: "Rota" },
  { id: "staff", label: "Staff" },
  { id: "leave", label: "Leave" },
  { id: "attendance", label: "Attendance" },
  { id: "payroll", label: "Payroll" },
];
const isTab = (v: string | null): v is Tab => TABS.some((t) => t.id === v);

export type Notice = { tone: "success" | "error"; text: string };

export default function WorkforcePage() {
  return (
    <Suspense
      fallback={
        <PageContainer wide title="Workforce">
          <Loading label="Loading workforce…" />
        </PageContainer>
      }
    >
      <WorkforceInner />
    </Suspense>
  );
}

function WorkforceInner() {
  const router = useRouter();
  const search = useSearchParams();
  const tabParam = search.get("tab");
  const tab: Tab = isTab(tabParam) ? tabParam : "rota";
  const [notice, setNotice] = useState<Notice | null>(null);
  const [staff, setStaff] = useState<StaffDTO[] | null>(null);
  const [staffError, setStaffError] = useState<string | null>(null);

  const notify = useCallback((tone: Notice["tone"], text: string) => {
    setNotice({ tone, text });
    window.setTimeout(() => setNotice((n) => (n?.text === text ? null : n)), 6000);
  }, []);

  const loadStaff = useCallback(async () => {
    setStaffError(null);
    try {
      const d = await jsonFetch<{ staff: StaffDTO[] }>("/api/workforce/staff?all=1", { fallback: "Could not load staff" });
      setStaff(d.staff);
    } catch (err) {
      setStaffError(err instanceof Error ? err.message : "Could not load staff");
      setStaff([]);
    }
  }, []);

  useEffect(() => {
    void loadStaff();
  }, [loadStaff]);

  function setTab(t: Tab) {
    const params = new URLSearchParams(search.toString());
    params.set("tab", t);
    router.replace(`/workforce?${params}`);
  }

  const activeStaff = (staff ?? []).filter((s) => s.active);

  return (
    <PageContainer
      wide
      title="Workforce"
      description="Rota, staff profiles, leave, attendance and payroll export."
      tooltip="Schedule shifts, publish the week to your team, approve leave and export hours for payroll."
      icon={<CalendarClock className="h-6 w-6 text-primary" aria-hidden />}
    >
      <Tabs id="workforce" label="Workforce sections" tabs={TABS} value={tab} onChange={setTab} className="mb-4" />
      {notice && (
        <Banner tone={notice.tone} onDismiss={() => setNotice(null)} className="mb-4">
          {notice.text}
        </Banner>
      )}
      {staffError && (
        <Banner tone="error" onDismiss={() => setStaffError(null)} className="mb-4">
          {staffError}
        </Banner>
      )}

      <TabPanel id="workforce" value="rota">
        {tab === "rota" && <RotaTab staff={activeStaff} notify={notify} />}
      </TabPanel>
      <TabPanel id="workforce" value="staff">
        {tab === "staff" && <StaffTab staff={staff} reload={loadStaff} notify={notify} />}
      </TabPanel>
      <TabPanel id="workforce" value="leave">
        {tab === "leave" && <LeaveTab staff={activeStaff} notify={notify} />}
      </TabPanel>
      <TabPanel id="workforce" value="attendance">
        {tab === "attendance" && <AttendanceTab staff={activeStaff} notify={notify} />}
      </TabPanel>
      <TabPanel id="workforce" value="payroll">
        {tab === "payroll" && <PayrollTab notify={notify} />}
      </TabPanel>
    </PageContainer>
  );
}
