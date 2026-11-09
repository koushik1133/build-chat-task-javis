"use client";

import { useCallback, useEffect, useState } from "react";
import { Scale } from "lucide-react";
import { PageContainer } from "@/components/page-container";
import { api, Banner, ErrorState, Loading, TabPanel, Tabs } from "@/components/finance/shared";
import { VERIFY_NOTICE } from "@/lib/tax-compliance/regimes";
import { SetupTab } from "@/components/tax/setup-tab";
import { ReportsTab } from "@/components/tax/reports-tab";
import { FilingsTab } from "@/components/tax/filings-tab";
import { EInvoicesTab } from "@/components/tax/einvoices-tab";
import { ExemptionsTab } from "@/components/tax/exemptions-tab";
import type { EInvoiceRow, Exemption, Filing, TaxProfile } from "@/components/tax/types";

type Tab = "setup" | "reports" | "filings" | "einvoices" | "exemptions";
const TABS: readonly Tab[] = ["setup", "reports", "filings", "einvoices", "exemptions"];

export default function TaxPage() {
  const [tab, setTab] = useState<Tab>("setup");
  const [profile, setProfile] = useState<TaxProfile | null>(null);
  const [filings, setFilings] = useState<Filing[]>([]);
  const [einv, setEinv] = useState<EInvoiceRow[]>([]);
  const [exemptions, setExemptions] = useState<Exemption[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [p, f, e, x] = await Promise.all([
        api<{ profile: TaxProfile | null }>("/api/tax/profile"),
        api<{ filings: Filing[] }>("/api/tax/filings"),
        api<{ e_invoices: EInvoiceRow[] }>("/api/tax/e-invoices"),
        api<{ exemptions: Exemption[] }>("/api/tax/exemptions"),
      ]);
      setProfile(p.profile);
      setFilings(f.filings);
      setEinv(e.e_invoices);
      setExemptions(x.exemptions);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load tax settings.");
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    const t = new URLSearchParams(window.location.search).get("tab");
    if (TABS.includes(t as Tab)) setTab(t as Tab);
    void load();
  }, [load]);

  return (
    <PageContainer wide title="Tax & compliance" icon={<Scale className="h-5 w-5" aria-hidden />} description="GST, VAT and sales-tax rules, filing-ready reports and e-invoice exports.">
      <Banner tone="warn" className="mb-4">{VERIFY_NOTICE}</Banner>
      {loading ? <Loading label="Loading tax settings" /> : error ? <ErrorState message={error} onRetry={() => void load()} /> : (
        <>
          <div className="mb-4">
            <Tabs id="tax" label="Tax sections" value={tab} onChange={setTab} tabs={[
              { id: "setup", label: "Setup" }, { id: "reports", label: "Reports" }, { id: "filings", label: "Filings", count: filings.length },
              { id: "einvoices", label: "E-invoices", count: einv.length }, { id: "exemptions", label: "Exemptions", count: exemptions.length },
            ]} />
          </div>
          <TabPanel id="tax" value={tab}>
            {tab === "setup" && <SetupTab profile={profile} onSaved={setProfile} />}
            {tab === "reports" && <ReportsTab defaultRegime={profile?.regime ?? "generic"} onPrepared={() => void load()} />}
            {tab === "filings" && <FilingsTab filings={filings} onChanged={() => void load()} />}
            {tab === "einvoices" && <EInvoicesTab rows={einv} onChanged={() => void load()} />}
            {tab === "exemptions" && <ExemptionsTab rows={exemptions} onChanged={() => void load()} />}
          </TabPanel>
        </>
      )}
    </PageContainer>
  );
}
