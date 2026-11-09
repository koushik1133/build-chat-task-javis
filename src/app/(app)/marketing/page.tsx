"use client";

import { Suspense, useCallback } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Send } from "lucide-react";
import { PageContainer } from "@/components/page-container";
import { Loading } from "@/components/ui/feedback";
import { TabPanel, Tabs } from "@/components/ui/tabs";
import { CampaignsTab } from "@/components/marketing/campaigns-tab";
import { AudiencesTab } from "@/components/marketing/audiences-tab";
import { TemplatesTab } from "@/components/marketing/templates-tab";
import { SequencesTab } from "@/components/marketing/sequences-tab";
import { NoticeBanner, useNotice } from "@/components/marketing/shared";

type Tab = "campaigns" | "audiences" | "templates" | "sequences";
const TABS: ReadonlyArray<{ id: Tab; label: string }> = [
  { id: "campaigns", label: "Campaigns" },
  { id: "audiences", label: "Audiences" },
  { id: "templates", label: "Templates" },
  { id: "sequences", label: "Sequences" },
];

export default function MarketingPage() {
  return (
    <Suspense
      fallback={
        <PageContainer wide title="Marketing">
          <Loading label="Loading marketing…" />
        </PageContainer>
      }
    >
      <MarketingInner />
    </Suspense>
  );
}

function MarketingInner() {
  const router = useRouter();
  const search = useSearchParams();
  const tabParam = search.get("tab");
  const tab: Tab = TABS.some((t) => t.id === tabParam) ? (tabParam as Tab) : "campaigns";
  const campaignId = search.get("campaign");
  const [notice, notify, dismiss] = useNotice();

  const setParams = useCallback(
    (patch: Record<string, string | null>) => {
      const p = new URLSearchParams(search.toString());
      for (const [k, v] of Object.entries(patch)) {
        if (v) p.set(k, v);
        else p.delete(k);
      }
      router.replace(`/marketing${p.toString() ? `?${p}` : ""}`, { scroll: false });
    },
    [router, search]
  );

  return (
    <PageContainer wide title="Marketing" description="Consent-first email and SMS campaigns, audiences, templates and drip sequences." icon={<Send className="h-5 w-5" />} tooltip="Every send checks the consent ledger, opt-outs and erasure tombstones. Contacts without consent are skipped, never sent.">
      <NoticeBanner notice={notice} onDismiss={dismiss} />
      <Tabs id="marketing-tabs" label="Marketing sections" tabs={TABS} value={tab} onChange={(t) => setParams({ tab: t === "campaigns" ? null : t, campaign: null })} className="mb-4" />
      <TabPanel id="marketing-tabs" value="campaigns">
        {tab === "campaigns" && <CampaignsTab notify={notify} selectedId={campaignId} onSelect={(id) => setParams({ campaign: id })} />}
      </TabPanel>
      <TabPanel id="marketing-tabs" value="audiences">{tab === "audiences" && <AudiencesTab notify={notify} />}</TabPanel>
      <TabPanel id="marketing-tabs" value="templates">{tab === "templates" && <TemplatesTab notify={notify} />}</TabPanel>
      <TabPanel id="marketing-tabs" value="sequences">{tab === "sequences" && <SequencesTab notify={notify} />}</TabPanel>
    </PageContainer>
  );
}
