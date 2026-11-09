"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useParams } from "next/navigation";
import { CalendarDays } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ErrorState, Skeleton } from "@/components/ui/feedback";
import { Tabs, type TabDef } from "@/components/ui/tabs";
import { SupportTab } from "@/components/portal/support-tab";
import { PrivacyTab } from "@/components/portal/privacy-tab";
import { DocumentsTab } from "@/components/portal/documents-tab";
import { FilesTab } from "@/components/portal/files-tab";
import { OverviewTab } from "@/components/portal/overview-tab";
import { BookingsTab } from "@/components/portal/bookings-tab";
import { InvoicesTab } from "@/components/portal/invoices-tab";
import { OrdersTab } from "@/components/portal/orders-tab";
import { ProjectsTab } from "@/components/portal/projects-tab";
import { MessagesTab } from "@/components/portal/messages-tab";
import { PORTAL_TAB_LABELS, PORTAL_TABS, type PortalTabId } from "@/components/portal/portal-tabs";
import type { PortalData } from "@/lib/portal";

function PortalSkeleton() {
  return (
    <div className="mx-auto max-w-3xl space-y-4 px-4 py-8" aria-busy="true">
      <span className="sr-only" role="status">Loading your portal…</span>
      <Skeleton className="h-4 w-32" />
      <Skeleton className="h-8 w-64" />
      <Skeleton className="h-11 w-full" />
      <div className="grid gap-4 sm:grid-cols-2">
        {[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-32 rounded-xl" />)}
      </div>
    </div>
  );
}

/** Customer portal: one branded place per contact. Branding comes from the /p layout's CSS variables. */
export default function ClientPortalPage() {
  const params = useParams<{ token: string }>();
  const token = params.token;
  const [data, setData] = useState<PortalData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<PortalTabId>("overview");
  const [unread, setUnread] = useState<number | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/p/portal/${token}`);
      if (res.status === 404) throw new Error("This link has expired or is not valid.");
      if (!res.ok) throw new Error("Could not load your portal.");
      const d = (await res.json()) as PortalData;
      setData(d);
      setUnread((u) => u ?? d.unreadMessages);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load your portal.");
    }
  }, [token]);

  useEffect(() => {
    void load();
  }, [load]);

  const tabs = useMemo<TabDef<PortalTabId>[]>(
    () =>
      PORTAL_TABS.map((id) => ({
        id,
        label: PORTAL_TAB_LABELS[id],
        count:
          id === "messages" ? (unread && unread > 0 ? unread : undefined)
          : id === "bookings" && data && data.upcomingBookings.length > 0 ? data.upcomingBookings.length
          : id === "documents" && data && data.documents.length > 0 ? data.documents.length
          : undefined,
      })),
    [data, unread]
  );

  if (error) {
    return (
      <div className="mx-auto max-w-lg px-4 py-16 text-center">
        <ErrorState message={error} onRetry={data === null && error !== "This link has expired or is not valid." ? () => { setError(null); void load(); } : undefined} />
        <p className="mt-3 text-sm text-muted-foreground">Ask the business to send you a fresh link, or request one from their portal sign-in page.</p>
      </div>
    );
  }
  if (!data) return <PortalSkeleton />;

  return (
    <div className="mx-auto max-w-3xl space-y-5 px-4 py-8 sm:py-12">
      <header>
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{data.org.name}</p>
        <h1 className="mt-1 text-balance text-2xl font-semibold tracking-tight">Hello, {data.contact.name}</h1>
        <p className="mt-1 text-sm text-muted-foreground">Your bookings, invoices, orders and messages in one place.</p>
        {data.bookPath && (
          <Button asChild className="mt-4" touch><a href={data.bookPath}><CalendarDays className="h-4 w-4" aria-hidden /> Book a time</a></Button>
        )}
      </header>

      <Tabs id="portal" tabs={tabs} value={tab} onChange={setTab} label="Portal sections" />

      <div role="tabpanel" id={`portal-panel-${tab}`} aria-labelledby={`portal-tab-${tab}`} tabIndex={0} className="rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
        {tab === "overview" && <OverviewTab data={data} go={setTab} />}
        {tab === "bookings" && <BookingsTab data={data} token={token} onChanged={load} />}
        {tab === "invoices" && <InvoicesTab data={data} token={token} />}
        {tab === "orders" && <OrdersTab data={data} />}
        {tab === "projects" && <ProjectsTab data={data} />}
        {tab === "documents" && <DocumentsTab token={token} signLinks={data.documents} />}
        {tab === "files" && <FilesTab token={token} />}
        {tab === "support" && <SupportTab token={token} />}
        {tab === "messages" && <MessagesTab token={token} onRead={() => setUnread(0)} />}
        {tab === "privacy" && <PrivacyTab token={token} />}
      </div>
    </div>
  );
}
