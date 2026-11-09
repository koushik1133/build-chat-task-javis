"use client";

import { Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { HeartHandshake } from "lucide-react";
import { PageContainer } from "@/components/page-container";
import { Loading } from "@/components/ui/feedback";
import { TabPanel, Tabs } from "@/components/ui/tabs";
import { FeedbackTab } from "@/components/engagement/feedback-tab";
import { LoyaltyTab } from "@/components/engagement/loyalty-tab";
import { GiftCardsTab } from "@/components/engagement/giftcards-tab";
import { VouchersTab } from "@/components/engagement/vouchers-tab";
import { ReferralsTab } from "@/components/engagement/referrals-tab";

const TABS = [
  { id: "feedback", label: "Feedback" },
  { id: "loyalty", label: "Loyalty" },
  { id: "gift-cards", label: "Gift cards" },
  { id: "vouchers", label: "Vouchers" },
  { id: "referrals", label: "Referrals" },
] as const;
type TabId = (typeof TABS)[number]["id"];

export default function EngagementPage() {
  return (
    <Suspense fallback={<PageContainer wide title="Loyalty & feedback"><Loading label="Loading…" /></PageContainer>}>
      <Inner />
    </Suspense>
  );
}

function Inner() {
  const router = useRouter();
  const search = useSearchParams();
  const raw = search.get("tab");
  const tab: TabId = TABS.some((t) => t.id === raw) ? (raw as TabId) : "feedback";
  return (
    <PageContainer wide title="Loyalty & feedback" description="Surveys, rewards, gift cards, discount codes and referrals." icon={<HeartHandshake className="h-5 w-5" aria-hidden />}>
      <Tabs id="eng" tabs={TABS} value={tab} onChange={(t) => router.replace(`/engagement?tab=${t}`, { scroll: false })} label="Engagement sections" className="mb-5" />
      <TabPanel id="eng" value={tab}>
        {tab === "feedback" && <FeedbackTab />}
        {tab === "loyalty" && <LoyaltyTab />}
        {tab === "gift-cards" && <GiftCardsTab />}
        {tab === "vouchers" && <VouchersTab />}
        {tab === "referrals" && <ReferralsTab />}
      </TabPanel>
    </PageContainer>
  );
}
