"use client";

import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { PackageCheck } from "lucide-react";
import { PageContainer } from "@/components/page-container";
import { Banner, Loading } from "@/components/ui/feedback";
import { TabPanel, Tabs } from "@/components/ui/tabs";
import { CarriersTab } from "@/components/shipping/carriers-tab";
import { ReturnsTab } from "@/components/shipping/returns-tab";
import { RulesTab } from "@/components/shipping/rules-tab";
import { ShipmentsTab } from "@/components/shipping/shipments-tab";

type Tab = "shipments" | "returns" | "rules" | "carriers";
const TABS: Tab[] = ["shipments", "returns", "rules", "carriers"];
type Notice = { tone: "success" | "error"; text: string };

export default function ShippingPage() {
  return (
    <Suspense fallback={<PageContainer wide title="Shipping & returns"><Loading label="Loading shipping…" /></PageContainer>}>
      <Inner />
    </Suspense>
  );
}

function Inner() {
  const router = useRouter();
  const search = useSearchParams();
  const raw = search.get("tab");
  const tab: Tab = TABS.includes(raw as Tab) ? (raw as Tab) : "shipments";
  const [notice, setNotice] = useState<Notice | null>(null);
  const go = (patch: Record<string, string | null>) => {
    const sp = new URLSearchParams(search.toString());
    for (const [k, v] of Object.entries(patch)) {
      if (v) sp.set(k, v);
      else sp.delete(k);
    }
    router.replace(`/shipping${sp.toString() ? `?${sp}` : ""}`);
  };
  return (
    <PageContainer wide title="Shipping & returns" description="Buy labels, track parcels and handle customer returns." icon={<PackageCheck className="h-5 w-5" aria-hidden />}>
      {notice && <Banner tone={notice.tone} onDismiss={() => setNotice(null)} className="mb-4">{notice.text}</Banner>}
      <Tabs id="ship-tabs" label="Shipping sections" value={tab} onChange={(t) => go({ tab: t === "shipments" ? null : t, shipment: null, return: null })} className="mb-4 w-fit" tabs={[{ id: "shipments", label: "Shipments" }, { id: "returns", label: "Returns" }, { id: "rules", label: "Rules" }, { id: "carriers", label: "Carriers" }]} />
      <TabPanel id="ship-tabs" value={tab}>
        {tab === "shipments" && <ShipmentsTab selectedId={search.get("shipment")} onSelect={(id) => go({ shipment: id })} notify={setNotice} />}
        {tab === "returns" && <ReturnsTab selectedId={search.get("return")} onSelect={(id) => go({ return: id })} notify={setNotice} />}
        {tab === "rules" && <RulesTab notify={setNotice} />}
        {tab === "carriers" && <CarriersTab notify={setNotice} />}
      </TabPanel>
    </PageContainer>
  );
}
