"use client";

import { useEffect, useState } from "react";
import {
  Users, Inbox, Sparkles, Send,
  CheckCircle2, Code2, Copy, X, Edit3
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { InfoTooltip } from "@/components/ui/info-tooltip";

type Lead = {
  id: string;
  site_id: string;
  data: string;
  status: "new" | "draft_ready" | "sent";
  research_summary: string | null;
  draft_email_subject: string | null;
  draft_email_body: string | null;
  created_at: string;
  sent_at: string | null;
  enriched_at: string | null;
};

type ParsedData = {
  name?: string;
  email?: string;
  company?: string;
  message?: string;
  source?: string;
};

export default function LeadsPage() {
  const [leads, setLeads] = useState<Lead[]>([]);
  const [sites, setSites] = useState<{ id: string; title: string }[]>([]);
  const [selectedSiteId, setSelectedSiteId] = useState<string>("");
  const [loading, setLoading] = useState(true);
  const [selectedLead, setSelectedLead] = useState<Lead | null>(null);
  const [enrichingId, setEnrichingId] = useState<string | null>(null);
  const [sendingId, setSendingId] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  
  // Edit mode
  const [isEditing, setIsEditing] = useState(false);
  const [editSubject, setEditSubject] = useState("");
  const [editBody, setEditBody] = useState("");

  useEffect(() => {
    fetchLeads();
    fetchSites();
  }, []);

  async function fetchLeads() {
    try {
      const res = await fetch("/api/leads").then((r) => r.json());
      if (res.leads) setLeads(res.leads);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  }

  async function fetchSites() {
    try {
      const r = await fetch("/api/build/sites");
      if (!r.ok) return;
      const res = await r.json();
      if (Array.isArray(res.sites)) {
        setSites(res.sites);
        if (res.sites.length > 0) setSelectedSiteId(res.sites[0].id);
      }
    } catch (err) {
      console.error(err);
    }
  }

  async function enrichLead(lead: Lead) {
    setEnrichingId(lead.id);
    try {
      const res = await fetch("/api/leads/enrich", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ leadId: lead.id }),
      });
      const data = await res.json();
      if (data.success) {
        await fetchLeads();
        if (selectedLead?.id === lead.id) {
          // Re-fetch or manually update the selected lead
          setSelectedLead({ ...lead, status: "draft_ready", research_summary: data.research, draft_email_subject: data.subject, draft_email_body: data.body });
        }
      }
    } catch (err) {
      console.error(err);
      alert("Failed to enrich lead.");
    } finally {
      setEnrichingId(null);
    }
  }

  async function sendEmail(lead: Lead) {
    setSendingId(lead.id);
    try {
      const res = await fetch("/api/leads/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          leadId: lead.id,
          subject: isEditing ? editSubject : lead.draft_email_subject,
          body: isEditing ? editBody : lead.draft_email_body,
        }),
      });
      const data = await res.json();
      if (data.success) {
        await fetchLeads();
        setSelectedLead(null);
        setIsEditing(false);
      } else {
        alert(data.error || "Failed to send email.");
      }
    } catch (err) {
      console.error(err);
      alert("Error sending email.");
    } finally {
      setSendingId(null);
    }
  }

  function handleCopyEmbed() {
    const origin = typeof window !== "undefined" ? window.location.origin : "";
    const code = `<script>
  (function() {
    var s = document.createElement('script');
    s.src = '${origin}/api/leads/widget/${selectedSiteId}/embed.js';
    s.async = true;
    document.head.appendChild(s);
  })();
</script>`;
    navigator.clipboard.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <div className="flex h-screen w-full flex-col bg-background/50">
      {/* Header */}
      <header className="flex h-14 shrink-0 items-center justify-between border-b border-border bg-card/50 px-6 backdrop-blur-md">
        <div className="flex items-center gap-3">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-orange-500/10 text-orange-500">
            <Inbox className="h-4 w-4" />
          </div>
          <div>
            <h1 className="text-sm font-semibold flex items-center gap-2">
              Lead Inbox
              <InfoTooltip text="Leads from your embedded website widgets appear here. AI instantly researches their company and drafts a custom outreach email for you to approve!" />
            </h1>
            <p className="text-[10px] text-muted-foreground">AI-powered lead research and outreach</p>
          </div>
        </div>
      </header>

      <div className="flex flex-1 overflow-hidden relative">
        {/* Main List */}
        <div className="flex-1 overflow-y-auto p-6 scrollbar-thin">
          {loading ? (
            <div className="flex items-center justify-center py-20 text-muted-foreground">
              <span className="animate-pulse">Loading leads...</span>
            </div>
          ) : leads.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-20 text-center">
              <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-secondary">
                <Users className="h-6 w-6 text-muted-foreground" />
              </div>
              <h3 className="text-lg font-medium">No leads yet</h3>
              <p className="mt-1 max-w-sm text-sm text-muted-foreground">
                When visitors submit forms on your sites or widget, they&apos;ll appear here for automatic enrichment.
              </p>
            </div>
          ) : (
            <div className="rounded-xl border border-border bg-card shadow-sm">
              <table className="w-full text-left text-sm">
                <thead>
                  <tr className="border-b border-border bg-muted/50 text-xs font-medium text-muted-foreground">
                    <th className="px-4 py-3 font-medium">Contact</th>
                    <th className="px-4 py-3 font-medium">Company</th>
                    <th className="px-4 py-3 font-medium">Status</th>
                    <th className="px-4 py-3 font-medium">Date</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {leads.map((lead) => {
                    let parsed: ParsedData = {};
                    try { parsed = JSON.parse(lead.data); } catch {}
                    const isSelected = selectedLead?.id === lead.id;

                    return (
                      <tr 
                        key={lead.id} 
                        onClick={() => {
                          setSelectedLead(lead);
                          setIsEditing(false);
                        }}
                        className={`cursor-pointer transition-colors hover:bg-secondary/50 ${isSelected ? 'bg-primary/5' : ''}`}
                      >
                        <td className="px-4 py-3">
                          <div className="font-medium text-foreground">{parsed.name || "Unknown"}</div>
                          <div className="text-xs text-muted-foreground">{parsed.email || "No email"}</div>
                        </td>
                        <td className="px-4 py-3 text-muted-foreground">
                          {parsed.company || "—"}
                        </td>
                        <td className="px-4 py-3">
                          {lead.status === "new" && (
                            <span className="inline-flex items-center rounded-full border border-blue-200 bg-blue-50 px-2 py-0.5 text-[10px] font-medium text-blue-700 dark:border-blue-900 dark:bg-blue-950 dark:text-blue-400">
                              New
                            </span>
                          )}
                          {lead.status === "draft_ready" && (
                            <span className="inline-flex items-center rounded-full border border-purple-200 bg-purple-50 px-2 py-0.5 text-[10px] font-medium text-purple-700 dark:border-purple-900 dark:bg-purple-950 dark:text-purple-400">
                              Draft Ready
                            </span>
                          )}
                          {lead.status === "sent" && (
                            <span className="inline-flex items-center rounded-full border border-green-200 bg-green-50 px-2 py-0.5 text-[10px] font-medium text-green-700 dark:border-green-900 dark:bg-green-950 dark:text-green-400">
                              <CheckCircle2 className="mr-1 h-3 w-3" /> Sent
                            </span>
                          )}
                        </td>
                        <td className="px-4 py-3 text-xs text-muted-foreground">
                          {new Date(lead.created_at).toLocaleDateString()}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          {/* Embed Code Generator Section */}
          <div className="mt-8 rounded-xl border border-border bg-card shadow-sm p-6 max-w-3xl">
            <div className="flex items-center gap-2 mb-4">
              <Code2 className="h-5 w-5 text-primary" />
              <h2 className="text-base font-semibold flex items-center gap-2">
                Install Lead Widget
                <InfoTooltip text="Copy and paste this HTML <script> tag into your website (WordPress, Webflow, Shopify, etc.). It renders a floating 'Contact Us' form that automatically sends submissions directly to this inbox." />
              </h2>
            </div>
            <p className="text-sm text-muted-foreground mb-6">
              Drop this one line of code into your client&apos;s website to add a floating lead capture widget. 
              Submissions will route directly into this inbox and trigger AI enrichment.
            </p>

            <div className="space-y-4">
              <div className="flex flex-col gap-1.5">
                <label className="text-xs font-medium text-foreground">Select Site to Link</label>
                <select 
                  className="rounded-md border border-input bg-background px-3 py-2 text-sm max-w-sm"
                  value={selectedSiteId}
                  onChange={(e) => setSelectedSiteId(e.target.value)}
                >
                  {sites.map(s => (
                    <option key={s.id} value={s.id}>{s.title}</option>
                  ))}
                  {sites.length === 0 && <option value="">No sites available</option>}
                </select>
              </div>

              <div className="relative">
                <pre className="overflow-x-auto rounded-lg bg-zinc-950 p-4 text-[13px] leading-relaxed text-zinc-50 font-mono">
                  <code>
{`<script>
  (function() {
    var s = document.createElement('script');
    s.src = '${typeof window !== "undefined" ? window.location.origin : ""}/api/leads/widget/${selectedSiteId || 'SITE_ID'}/embed.js';
    s.async = true;
    document.head.appendChild(s);
  })();
</script>`}
                  </code>
                </pre>
                <Button
                  size="sm"
                  variant="secondary"
                  className="absolute right-2 top-2 h-7 gap-1.5 bg-zinc-800 text-zinc-300 hover:bg-zinc-700 hover:text-white border-0"
                  onClick={handleCopyEmbed}
                  disabled={!selectedSiteId}
                >
                  {copied ? <CheckCircle2 className="h-3 w-3 text-green-400" /> : <Copy className="h-3 w-3" />}
                  {copied ? "Copied" : "Copy Code"}
                </Button>
              </div>
            </div>
          </div>
        </div>

        {/* Slide-over Side Panel */}
        {selectedLead && (
          <div className="w-full sm:w-[420px] sm:shrink-0 border-l border-border bg-card shadow-2xl flex flex-col h-full animate-in slide-in-from-right-8 duration-200">
            <div className="flex items-center justify-between border-b border-border p-4">
              <h2 className="font-semibold text-sm">Lead Details</h2>
              <button 
                onClick={() => setSelectedLead(null)}
                className="rounded-md p-1.5 text-muted-foreground hover:bg-secondary hover:text-foreground"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="flex-1 overflow-y-auto p-5 scrollbar-thin">
              {(() => {
                let parsed: ParsedData = {};
                try { parsed = JSON.parse(selectedLead.data); } catch {}
                
                return (
                  <div className="space-y-6">
                    {/* Basic Info */}
                    <div>
                      <div className="text-lg font-semibold">{parsed.name || "Unknown"}</div>
                      <div className="text-sm text-muted-foreground">{parsed.email}</div>
                      {parsed.company && (
                        <div className="mt-2 inline-flex items-center rounded-md bg-secondary px-2 py-1 text-xs font-medium text-foreground">
                          {parsed.company}
                        </div>
                      )}
                      {parsed.message && (
                        <div className="mt-3 rounded-md bg-muted/50 p-3 text-sm text-foreground">
                          &quot;{parsed.message}&quot;
                        </div>
                      )}
                    </div>

                    {/* AI Research Section */}
                    <div className="rounded-xl border border-border overflow-hidden">
                      <div className="bg-muted/50 px-4 py-2.5 flex items-center justify-between border-b border-border">
                        <div className="flex items-center gap-1.5 text-sm font-medium">
                          <Sparkles className="h-3.5 w-3.5 text-primary" />
                          AI Research
                        </div>
                        {selectedLead.status === "new" && (
                          <Button 
                            size="sm" 
                            variant="secondary" 
                            className="h-6 text-xs gap-1"
                            onClick={() => enrichLead(selectedLead)}
                            disabled={enrichingId === selectedLead.id}
                          >
                            {enrichingId === selectedLead.id ? "Researching..." : "Run Research"}
                          </Button>
                        )}
                      </div>
                      <div className="p-4 text-sm text-muted-foreground leading-relaxed whitespace-pre-wrap">
                        {selectedLead.research_summary || "No research performed yet."}
                      </div>
                    </div>

                    {/* AI Outreach Draft */}
                    {(selectedLead.status === "draft_ready" || selectedLead.status === "sent") && (
                      <div className="rounded-xl border border-border overflow-hidden">
                        <div className="bg-muted/50 px-4 py-2.5 flex items-center justify-between border-b border-border">
                          <div className="flex items-center gap-1.5 text-sm font-medium">
                            <Send className="h-3.5 w-3.5 text-primary" />
                            Draft Outreach
                          </div>
                          {selectedLead.status === "draft_ready" && !isEditing && (
                            <Button 
                              size="sm" 
                              variant="ghost" 
                              className="h-6 text-xs gap-1"
                              onClick={() => {
                                setIsEditing(true);
                                setEditSubject(selectedLead.draft_email_subject || "");
                                setEditBody(selectedLead.draft_email_body || "");
                              }}
                            >
                              <Edit3 className="h-3 w-3" /> Edit
                            </Button>
                          )}
                        </div>
                        
                        <div className="p-4 space-y-3">
                          {isEditing ? (
                            <>
                              <div>
                                <label className="text-[10px] uppercase font-bold text-muted-foreground mb-1 block">Subject</label>
                                <input 
                                  value={editSubject}
                                  onChange={e => setEditSubject(e.target.value)}
                                  className="w-full text-sm font-medium bg-background border border-input rounded-md px-2 py-1.5"
                                />
                              </div>
                              <div>
                                <label className="text-[10px] uppercase font-bold text-muted-foreground mb-1 block">Body</label>
                                <textarea 
                                  value={editBody}
                                  onChange={e => setEditBody(e.target.value)}
                                  className="w-full text-sm text-muted-foreground bg-background border border-input rounded-md px-2 py-1.5 h-40 resize-y"
                                />
                              </div>
                            </>
                          ) : (
                            <>
                              <div>
                                <div className="text-[10px] uppercase font-bold text-muted-foreground mb-1">Subject</div>
                                <div className="text-sm font-medium">{selectedLead.draft_email_subject}</div>
                              </div>
                              <div>
                                <div className="text-[10px] uppercase font-bold text-muted-foreground mb-1">Body</div>
                                <div className="text-sm text-muted-foreground whitespace-pre-wrap">{selectedLead.draft_email_body}</div>
                              </div>
                            </>
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                );
              })()}
            </div>
            
            {/* Footer Actions */}
            {selectedLead.status === "draft_ready" && (
              <div className="border-t border-border bg-muted/20 p-4">
                <Button 
                  className="w-full gap-2" 
                  onClick={() => sendEmail(selectedLead)}
                  disabled={sendingId === selectedLead.id}
                >
                  {sendingId === selectedLead.id ? "Sending..." : "Approve & Send Email"}
                </Button>
              </div>
            )}
            {selectedLead.status === "sent" && (
              <div className="border-t border-border bg-green-500/10 p-4 text-center">
                <p className="text-sm font-medium text-green-600 dark:text-green-400">
                  ✓ Email sent on {new Date(selectedLead.sent_at!).toLocaleDateString()}
                </p>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
