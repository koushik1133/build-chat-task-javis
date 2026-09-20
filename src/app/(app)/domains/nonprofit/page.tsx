"use client";
import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";

interface Donor {
  id: string;
  full_name?: string;
  email?: string;
  total_donated?: number | string;
  cause_tags?: string;
}

interface RetentionResult {
  at_risk_count?: number | string;
  tips?: string;
}

export default function NonprofitHub() {
  const [activeTab, setActiveTab] = useState("Donor CRM");
  const [donors, setDonors] = useState<Donor[]>([]);

  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [totalDonated, setTotalDonated] = useState("");
  const [causeTags, setCauseTags] = useState("");

  const [loading, setLoading] = useState(false);
  const [proposal, setProposal] = useState("");
  const [report, setReport] = useState("");
  const [retention, setRetention] = useState<RetentionResult | null>(null);

  useEffect(() => {
    fetchDonors();
  }, []);

  const fetchDonors = async () => {
    try {
      const res = await fetch("/api/domains/nonprofit?action=donors");
      if (res.ok) {
        const data = await res.json();
        setDonors(Array.isArray(data.donors) ? data.donors : []);
      }
    } catch (e) {
      console.error(e);
    }
  };

  const addDonor = async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/domains/nonprofit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "add_donor",
          full_name: fullName, email, phone,
          total_donated: Number(totalDonated), cause_tags: causeTags
        })
      });
      if (res.ok) {
        fetchDonors();
        setFullName(""); setEmail(""); setPhone(""); setTotalDonated(""); setCauseTags("");
      }
    } catch {
      alert("Something went wrong. Please try again.");
    } finally {
      setLoading(false);
    }
  };

  const generateProposal = async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/domains/nonprofit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "generate_grant_proposal",
          org_name: "Hope Foundation", mission: "Providing clean water to remote villages.",
          project_title: "Clean Water Initiative 2024", requested_amount: 50000,
          target_population: "Rural villages in sub-Saharan Africa", impact_metrics: "50 wells built, 10,000 people served"
        })
      });
      if (res.ok) {
        const data = await res.json();
        setProposal(data.proposal ?? "");
      }
    } catch {
      alert("Something went wrong. Please try again.");
    } finally {
      setLoading(false);
    }
  };

  const generateReport = async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/domains/nonprofit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "generate_impact_report",
          org_name: "Hope Foundation", period: "Q3 2023",
          total_raised: 120000, programs: [{ name: "Clean Water", beneficiaries: 5000, outcomes: "Reduced waterborne diseases by 40%" }]
        })
      });
      if (res.ok) {
        const data = await res.json();
        setReport(data.report ?? "");
      }
    } catch {
      alert("Something went wrong. Please try again.");
    } finally {
      setLoading(false);
    }
  };

  const generateTips = async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/domains/nonprofit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "donor_retention_tips"
        })
      });
      if (res.ok) {
        const data = await res.json();
        setRetention(data);
      }
    } catch {
      alert("Something went wrong. Please try again.");
    } finally {
      setLoading(false);
    }
  };

  const totalRaisedOverall = donors.reduce((acc, curr) => acc + (Number(curr.total_donated) || 0), 0);

  return (
    <div className="h-full overflow-y-auto overflow-x-hidden p-4 sm:p-6 lg:p-8 max-w-6xl mx-auto space-y-6">
      <div className="flex items-center space-x-3 mb-8">
        <h1 className="text-3xl font-bold text-rose-600">❤️ Non-profit Hub</h1>
      </div>

      <div className="flex space-x-2 border-b border-border pb-2 overflow-x-auto whitespace-nowrap">
        {["Donor CRM", "Grant Proposal Generator", "Impact Report", "Donor Retention"].map((tab) => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className={`px-4 py-2 rounded-t-lg font-medium transition-colors ${
              activeTab === tab
                ? "bg-rose-600/10 text-rose-600 border-b-2 border-rose-600"
                : "text-muted-foreground hover:bg-card"
            }`}
          >
            {tab}
          </button>
        ))}
      </div>

      {activeTab === "Donor CRM" && (
        <div className="space-y-4">
          <div className="rounded-xl border border-border bg-card p-5 mb-4">
            <h2 className="text-2xl font-bold text-rose-600">Total Raised: ${totalRaisedOverall.toLocaleString()}</h2>
          </div>
          <div className="rounded-xl border border-border bg-card p-5 space-y-4">
            <h2 className="text-xl font-semibold">Add Donor</h2>
            <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
              <input placeholder="Full Name" className="p-2 rounded border bg-background" value={fullName} onChange={e=>setFullName(e.target.value)} />
              <input placeholder="Email" className="p-2 rounded border bg-background" value={email} onChange={e=>setEmail(e.target.value)} />
              <input placeholder="Phone" className="p-2 rounded border bg-background" value={phone} onChange={e=>setPhone(e.target.value)} />
              <input type="number" placeholder="Total Donated" className="p-2 rounded border bg-background" value={totalDonated} onChange={e=>setTotalDonated(e.target.value)} />
              <input placeholder="Cause Tags" className="p-2 rounded border bg-background" value={causeTags} onChange={e=>setCauseTags(e.target.value)} />
            </div>
            <Button onClick={addDonor} disabled={loading}>Add Donor</Button>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            {donors.map(d => (
              <div key={d.id} className="rounded-xl border border-border bg-card p-5">
                <h3 className="font-bold">{d.full_name}</h3>
                <p className="text-sm text-muted-foreground">{d.email}</p>
                <div className="mt-2 text-lg font-semibold text-rose-600">Donated: ${d.total_donated}</div>
                <div className="text-sm mt-1">Tags: {d.cause_tags}</div>
              </div>
            ))}
          </div>
        </div>
      )}

      {activeTab === "Grant Proposal Generator" && (
        <div className="rounded-xl border border-border bg-card p-5 space-y-4">
          <Button onClick={generateProposal} disabled={loading}>Generate Sample Grant Proposal</Button>
          {proposal && <div className="p-4 bg-muted rounded whitespace-pre-wrap">{proposal}</div>}
        </div>
      )}

      {activeTab === "Impact Report" && (
        <div className="rounded-xl border border-border bg-card p-5 space-y-4">
          <Button onClick={generateReport} disabled={loading}>Generate Sample Impact Report</Button>
          {report && <div className="p-4 bg-muted rounded whitespace-pre-wrap">{report}</div>}
        </div>
      )}

      {activeTab === "Donor Retention" && (
        <div className="rounded-xl border border-border bg-card p-5 space-y-4">
          <Button onClick={generateTips} disabled={loading}>Generate Retention Tips</Button>
          {retention && (
            <div className="space-y-4">
              <h3 className="text-xl font-bold text-red-500">At Risk Donors: {retention.at_risk_count}</h3>
              <div className="p-4 bg-muted rounded whitespace-pre-wrap">{retention.tips}</div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
