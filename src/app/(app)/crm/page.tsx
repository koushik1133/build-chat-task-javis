"use client";

import { useState, useEffect, useCallback } from "react";
import {
  Globe, Plus, Search, Filter, Users, DollarSign,
  Mail, Phone, Building2, Tag, X, Loader2, Pencil, Trash2, Check
} from "lucide-react";
import { Button } from "@/components/ui/button";

type Contact = {
  id: string;
  domain: string;
  full_name: string;
  email: string | null;
  phone: string | null;
  company: string | null;
  role: string | null;
  tags: string; // JSON
  lifecycle: string;
  notes: string | null;
  deal_value: number;
  last_contact: string | null;
  created_at: string;
  updated_at: string;
};

type Lifecycle = "lead" | "prospect" | "customer" | "churned" | "donor" | "patient" | "student";

const LIFECYCLE_COLORS: Record<string, string> = {
  lead:     "bg-blue-50 text-blue-700 dark:bg-blue-950 dark:text-blue-400",
  prospect: "bg-amber-50 text-amber-700 dark:bg-amber-950 dark:text-amber-400",
  customer: "bg-emerald-50 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-400",
  churned:  "bg-red-50 text-red-700 dark:bg-red-950 dark:text-red-400",
  donor:    "bg-rose-50 text-rose-700 dark:bg-rose-950 dark:text-rose-400",
  patient:  "bg-purple-50 text-purple-700 dark:bg-purple-950 dark:text-purple-400",
  student:  "bg-indigo-50 text-indigo-700 dark:bg-indigo-950 dark:text-indigo-400",
};

const LIFECYCLE_OPTIONS: Lifecycle[] = ["lead", "prospect", "customer", "churned", "donor", "patient", "student"];

const DOMAIN_OPTIONS = [
  { value: "general", label: "All Domains" },
  { value: "agency", label: "Agency" },
  { value: "healthcare", label: "Healthcare" },
  { value: "education", label: "Education" },
  { value: "legal", label: "Legal" },
  { value: "finance", label: "Finance" },
  { value: "realestate", label: "Real Estate" },
  { value: "ecommerce", label: "E-commerce" },
  { value: "nonprofit", label: "Non-profit" },
  { value: "business", label: "Business" },
];

function parseTagsSafe(tags: unknown): string[] {
  if (Array.isArray(tags)) return tags.map(String);
  if (typeof tags === "string") {
    const trimmed = tags.trim();
    if (!trimmed) return [];
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (Array.isArray(parsed)) return parsed.map(String);
      if (typeof parsed === "string") return parsed.split(",").map((t) => t.trim()).filter(Boolean);
    } catch {
      // not JSON — treat as comma-separated
    }
    return trimmed.split(",").map((t) => t.trim()).filter(Boolean);
  }
  return [];
}

export default function CrmPage() {
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [filterDomain, setFilterDomain] = useState("general");
  const [filterLifecycle, setFilterLifecycle] = useState("");

  const [showAdd, setShowAdd] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const [form, setForm] = useState({
    full_name: "", email: "", phone: "", company: "", role: "",
    tags: "", lifecycle: "lead" as Lifecycle, notes: "", deal_value: 0, domain: "general"
  });
  const [saving, setSaving] = useState(false);

  const fetchContacts = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (filterDomain && filterDomain !== "general") params.set("domain", filterDomain);
      if (filterLifecycle) params.set("lifecycle", filterLifecycle);
      if (search) params.set("q", search);

      const res = await fetch(`/api/crm/contacts?${params}`);
      const data = await res.json().catch(() => ({}));
      setContacts(data.contacts ?? []);
    } finally { setLoading(false); }
  }, [filterDomain, filterLifecycle, search]);

  useEffect(() => {
    const timer = setTimeout(() => fetchContacts(), search ? 400 : 0);
    return () => clearTimeout(timer);
  }, [fetchContacts, search]);

  function openAdd() {
    setEditingId(null);
    setForm({ full_name: "", email: "", phone: "", company: "", role: "", tags: "", lifecycle: "lead", notes: "", deal_value: 0, domain: "general" });
    setShowAdd(true);
  }

  function openEdit(contact: Contact) {
    setEditingId(contact.id);
    const tags = parseTagsSafe(contact.tags);
    setForm({
      full_name: contact.full_name, email: contact.email ?? "", phone: contact.phone ?? "",
      company: contact.company ?? "", role: contact.role ?? "",
      tags: tags.join(", "), lifecycle: contact.lifecycle as Lifecycle,
      notes: contact.notes ?? "", deal_value: contact.deal_value, domain: contact.domain
    });
    setShowAdd(true);
  }

  async function handleSave() {
    if (!form.full_name.trim()) return;
    setSaving(true);
    try {
      const tags = form.tags.split(",").map(t => t.trim()).filter(Boolean);
      const payload = { ...form, tags };

      if (editingId) {
        const res = await fetch("/api/crm/contacts", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: editingId, ...payload }),
        });
        const data = await res.json();
        if (data.contact) {
          setContacts(c => c.map(x => x.id === editingId ? data.contact : x));
          setShowAdd(false);
        }
      } else {
        const res = await fetch("/api/crm/contacts", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        const data = await res.json();
        if (data.contact) {
          setContacts(c => [data.contact, ...c]);
          setShowAdd(false);
        }
      }
    } finally { setSaving(false); }
  }

  async function handleDelete(id: string) {
    setDeletingId(id);
    try {
      await fetch(`/api/crm/contacts?id=${id}`, { method: "DELETE" });
      setContacts(c => c.filter(x => x.id !== id));
    } finally { setDeletingId(null); }
  }

  const totalDealValue = contacts.reduce((acc, c) => acc + Number(c.deal_value || 0), 0);
  const byLifecycle = LIFECYCLE_OPTIONS.reduce((acc, l) => {
    acc[l] = contacts.filter(c => c.lifecycle === l).length;
    return acc;
  }, {} as Record<string, number>);

  return (
    <div className="h-full overflow-y-auto overflow-x-hidden px-4 py-5 sm:px-6 sm:py-7 lg:px-8 lg:py-8">
      <div className="mx-auto w-full max-w-7xl space-y-6">

        {/* ── Header ── */}
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <h1 className="text-xl font-semibold tracking-tight sm:text-2xl flex items-center gap-2">
              <Globe className="h-6 w-6 text-primary" />
              Universal CRM
            </h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Unified contacts database for all domains — clients, leads, donors, patients, students, and investors.
            </p>
          </div>
          <Button onClick={openAdd} className="shrink-0">
            <Plus className="h-3.5 w-3.5 mr-1" /> Add Contact
          </Button>
        </div>

        {/* ── Stats ── */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          <div className="rounded-xl border border-border bg-card p-4">
            <div className="flex items-center justify-between text-muted-foreground mb-2">
              <span className="text-xs">Total Contacts</span>
              <Users className="h-4 w-4 text-primary" />
            </div>
            <div className="text-2xl font-bold">{contacts.length}</div>
            <div className="text-[11px] text-muted-foreground mt-1">Across all domains</div>
          </div>
          <div className="rounded-xl border border-border bg-card p-4">
            <div className="flex items-center justify-between text-muted-foreground mb-2">
              <span className="text-xs">Pipeline Value</span>
              <DollarSign className="h-4 w-4 text-emerald-500" />
            </div>
            <div className="text-2xl font-bold text-emerald-600 dark:text-emerald-400">
              ${totalDealValue.toLocaleString()}
            </div>
            <div className="text-[11px] text-muted-foreground mt-1">Total deal value</div>
          </div>
          <div className="rounded-xl border border-border bg-card p-4">
            <div className="flex items-center justify-between text-muted-foreground mb-2">
              <span className="text-xs">Active Customers</span>
              <Check className="h-4 w-4 text-blue-500" />
            </div>
            <div className="text-2xl font-bold">{byLifecycle.customer || 0}</div>
            <div className="text-[11px] text-muted-foreground mt-1">Converted contacts</div>
          </div>
          <div className="rounded-xl border border-border bg-card p-4">
            <div className="flex items-center justify-between text-muted-foreground mb-2">
              <span className="text-xs">Active Leads</span>
              <Tag className="h-4 w-4 text-amber-500" />
            </div>
            <div className="text-2xl font-bold text-amber-600 dark:text-amber-400">{(byLifecycle.lead || 0) + (byLifecycle.prospect || 0)}</div>
            <div className="text-[11px] text-muted-foreground mt-1">In pipeline</div>
          </div>
        </div>

        {/* ── Filters ── */}
        <div className="flex flex-col sm:flex-row gap-3">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
            <input
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search by name, email, or company..."
              className="w-full rounded-lg border border-border bg-background pl-9 pr-4 py-2 text-sm outline-none focus:ring-2 focus:ring-primary/30"
            />
          </div>
          <div className="flex gap-2">
            <select value={filterDomain} onChange={e => setFilterDomain(e.target.value)}
              className="rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none">
              {DOMAIN_OPTIONS.map(d => <option key={d.value} value={d.value}>{d.label}</option>)}
            </select>
            <select value={filterLifecycle} onChange={e => setFilterLifecycle(e.target.value)}
              className="rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none">
              <option value="">All Stages</option>
              {LIFECYCLE_OPTIONS.map(l => <option key={l} value={l}>{l.charAt(0).toUpperCase() + l.slice(1)}</option>)}
            </select>
            <Button variant="outline" size="sm" onClick={fetchContacts}>
              <Filter className="h-3.5 w-3.5" />
            </Button>
          </div>
        </div>

        {/* ── Contacts Table ── */}
        {loading ? (
          <div className="flex items-center gap-2 py-8 text-sm text-muted-foreground justify-center">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading contacts...
          </div>
        ) : contacts.length === 0 ? (
          <div className="rounded-xl border border-dashed border-border p-12 text-center">
            <Users className="h-8 w-8 text-muted-foreground mx-auto mb-3" />
            <p className="text-sm font-medium mb-1">No contacts found</p>
            <p className="text-xs text-muted-foreground mb-4">
              Start adding contacts — clients, leads, donors, patients, investors, or students.
            </p>
            <Button size="sm" onClick={openAdd}>
              <Plus className="h-3.5 w-3.5 mr-1" /> Add First Contact
            </Button>
          </div>
        ) : (
          <div className="rounded-xl border border-border bg-card overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border/60 bg-secondary/30">
                    <th className="text-left px-4 py-3 text-xs font-medium text-muted-foreground">Contact</th>
                    <th className="text-left px-4 py-3 text-xs font-medium text-muted-foreground hidden sm:table-cell">Company</th>
                    <th className="text-left px-4 py-3 text-xs font-medium text-muted-foreground hidden md:table-cell">Domain</th>
                    <th className="text-left px-4 py-3 text-xs font-medium text-muted-foreground">Stage</th>
                    <th className="text-left px-4 py-3 text-xs font-medium text-muted-foreground hidden lg:table-cell">Value</th>
                    <th className="px-4 py-3 text-xs font-medium text-muted-foreground text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border/40">
                  {contacts.map(contact => {
                    const tags = parseTagsSafe(contact.tags);
                    return (
                      <tr key={contact.id} className="hover:bg-secondary/20 transition-colors">
                        <td className="px-4 py-3">
                          <div className="font-medium">{contact.full_name}</div>
                          <div className="text-xs text-muted-foreground flex items-center gap-2 mt-0.5">
                            {contact.email && <span className="flex items-center gap-1"><Mail className="h-3 w-3" />{contact.email}</span>}
                            {contact.phone && <span className="flex items-center gap-1"><Phone className="h-3 w-3" />{contact.phone}</span>}
                          </div>
                          {tags.length > 0 && (
                            <div className="flex gap-1 mt-1 flex-wrap">
                              {tags.slice(0, 3).map(tag => (
                                <span key={tag} className="text-[10px] px-1.5 py-0.5 rounded bg-secondary text-muted-foreground">{tag}</span>
                              ))}
                            </div>
                          )}
                        </td>
                        <td className="px-4 py-3 hidden sm:table-cell">
                          {contact.company ? (
                            <div className="flex items-center gap-1 text-xs">
                              <Building2 className="h-3 w-3 text-muted-foreground" />
                              <span>{contact.company}</span>
                            </div>
                          ) : <span className="text-muted-foreground text-xs">—</span>}
                          {contact.role && <div className="text-[10px] text-muted-foreground mt-0.5">{contact.role}</div>}
                        </td>
                        <td className="px-4 py-3 hidden md:table-cell">
                          <span className="text-xs capitalize text-muted-foreground">{contact.domain}</span>
                        </td>
                        <td className="px-4 py-3">
                          <span className={`text-[10px] font-medium px-2 py-0.5 rounded-full capitalize ${LIFECYCLE_COLORS[contact.lifecycle] ?? "bg-secondary text-muted-foreground"}`}>
                            {contact.lifecycle}
                          </span>
                        </td>
                        <td className="px-4 py-3 hidden lg:table-cell">
                          {Number(contact.deal_value) > 0 ? (
                            <span className="text-sm font-semibold text-emerald-600 dark:text-emerald-400">
                              ${Number(contact.deal_value).toLocaleString()}
                            </span>
                          ) : <span className="text-muted-foreground text-xs">—</span>}
                        </td>
                        <td className="px-4 py-3 text-right">
                          <div className="flex items-center gap-1 justify-end">
                            <button onClick={() => openEdit(contact)}
                              className="h-7 w-7 rounded flex items-center justify-center hover:bg-secondary transition-colors">
                              <Pencil className="h-3.5 w-3.5 text-muted-foreground" />
                            </button>
                            <button onClick={() => handleDelete(contact.id)} disabled={deletingId === contact.id}
                              className="h-7 w-7 rounded flex items-center justify-center hover:bg-red-50 dark:hover:bg-red-950/20 transition-colors">
                              {deletingId === contact.id
                                ? <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
                                : <Trash2 className="h-3.5 w-3.5 text-muted-foreground hover:text-red-500" />
                              }
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div className="px-4 py-2.5 border-t border-border/40 text-xs text-muted-foreground">
              Showing {contacts.length} contact{contacts.length !== 1 ? "s" : ""}
            </div>
          </div>
        )}
      </div>

      {/* ── Add / Edit Contact Modal ── */}
      {showAdd && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-4" onClick={() => setShowAdd(false)}>
          <div className="bg-card border border-border rounded-xl p-6 w-full max-w-lg shadow-2xl space-y-4 max-h-[90vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between border-b border-border/40 pb-3">
              <h2 className="font-semibold text-base">{editingId ? "Edit Contact" : "New Contact"}</h2>
              <button onClick={() => setShowAdd(false)}><X className="h-4 w-4 text-muted-foreground" /></button>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-xs font-medium text-muted-foreground mb-1 block">Full Name *</label>
                <input value={form.full_name} onChange={e => setForm(f => ({ ...f, full_name: e.target.value }))}
                  placeholder="Jane Smith" className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-primary/30" />
              </div>
              <div>
                <label className="text-xs font-medium text-muted-foreground mb-1 block">Domain</label>
                <select value={form.domain} onChange={e => setForm(f => ({ ...f, domain: e.target.value }))}
                  className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none">
                  {DOMAIN_OPTIONS.filter(d => d.value !== "general").map(d => <option key={d.value} value={d.value}>{d.label}</option>)}
                  <option value="general">General</option>
                </select>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-xs font-medium text-muted-foreground mb-1 block">Email</label>
                <input value={form.email} onChange={e => setForm(f => ({ ...f, email: e.target.value }))}
                  placeholder="jane@company.com" className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none" />
              </div>
              <div>
                <label className="text-xs font-medium text-muted-foreground mb-1 block">Phone</label>
                <input value={form.phone} onChange={e => setForm(f => ({ ...f, phone: e.target.value }))}
                  placeholder="+1 555 0100" className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none" />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-xs font-medium text-muted-foreground mb-1 block">Company</label>
                <input value={form.company} onChange={e => setForm(f => ({ ...f, company: e.target.value }))}
                  placeholder="Acme Corp" className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none" />
              </div>
              <div>
                <label className="text-xs font-medium text-muted-foreground mb-1 block">Role / Title</label>
                <input value={form.role} onChange={e => setForm(f => ({ ...f, role: e.target.value }))}
                  placeholder="CTO, Director..." className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none" />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-xs font-medium text-muted-foreground mb-1 block">Lifecycle Stage</label>
                <select value={form.lifecycle} onChange={e => setForm(f => ({ ...f, lifecycle: e.target.value as Lifecycle }))}
                  className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none">
                  {LIFECYCLE_OPTIONS.map(l => <option key={l} value={l}>{l.charAt(0).toUpperCase() + l.slice(1)}</option>)}
                </select>
              </div>
              <div>
                <label className="text-xs font-medium text-muted-foreground mb-1 block">Deal Value ($)</label>
                <input type="number" value={form.deal_value} onChange={e => setForm(f => ({ ...f, deal_value: Number(e.target.value) }))}
                  placeholder="0" className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none" />
              </div>
            </div>

            <div>
              <label className="text-xs font-medium text-muted-foreground mb-1 block">Tags (comma-separated)</label>
              <input value={form.tags} onChange={e => setForm(f => ({ ...f, tags: e.target.value }))}
                placeholder="enterprise, warm-lead, saas..." className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none" />
            </div>

            <div>
              <label className="text-xs font-medium text-muted-foreground mb-1 block">Notes</label>
              <textarea value={form.notes} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))}
                rows={2} placeholder="Key notes about this contact..."
                className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none resize-none" />
            </div>

            <div className="flex gap-3 pt-2">
              <Button variant="outline" onClick={() => setShowAdd(false)} className="flex-1">Cancel</Button>
              <Button onClick={handleSave} disabled={saving || !form.full_name.trim()} className="flex-1">
                {saving ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <Check className="h-4 w-4 mr-2" />}
                {editingId ? "Save Changes" : "Add Contact"}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
