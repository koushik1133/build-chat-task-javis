"use client";

import { useCallback, useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { CalendarDays, FileSignature, FileText, Fingerprint, Kanban, LifeBuoy, Loader2, Paperclip, Receipt } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SupportTab } from "@/components/portal/support-tab";
import { PrivacyTab } from "@/components/portal/privacy-tab";
import { DocumentsTab } from "@/components/portal/documents-tab";
import { FilesTab } from "@/components/portal/files-tab";
import { cn } from "@/lib/utils";
import type { PortalData } from "@/lib/portal";

const money = (minor: number, currency: string) => new Intl.NumberFormat(undefined, { style: "currency", currency }).format(minor / 100);
const when = (iso: string, tz: string) => new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short", timeZone: tz }).format(new Date(iso));
const date = (iso: string) => new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(new Date(iso));

function Section({ icon: Icon, title, children }: { icon: typeof FileText; title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-xl border border-border bg-card p-5">
      <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold"><Icon className="h-4 w-4 text-primary" /> {title}</h2>
      {children}
    </section>
  );
}

const Empty = ({ text }: { text: string }) => <p className="text-sm text-muted-foreground">{text}</p>;

export default function ClientPortalPage() {
  const params = useParams<{ token: string }>();
  const [data, setData] = useState<PortalData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [tab, setTab] = useState<"overview" | "documents" | "files" | "support" | "privacy">("overview");

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/p/portal/${params.token}`);
      if (res.status === 404) throw new Error("This link has expired or is not valid.");
      if (!res.ok) throw new Error("Could not load your portal.");
      setData(await res.json());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load your portal.");
    }
  }, [params.token]);

  useEffect(() => { void load(); }, [load]);

  async function cancel(id: string) {
    if (!confirm("Cancel this appointment?")) return;
    setBusy(id);
    try {
      await fetch(`/api/p/portal/${params.token}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "cancel_booking", bookingId: id }),
      });
      await load();
    } finally {
      setBusy(null);
    }
  }

  if (error) {
    return <main className="mx-auto max-w-lg px-4 py-16 text-center text-sm text-muted-foreground">{error}</main>;
  }
  if (!data) {
    return <main className="flex justify-center py-16"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></main>;
  }

  const upcoming = data.bookings.filter((b) => b.status === "confirmed" && new Date(b.endsAt).getTime() > Date.now());

  return (
    <main className="mx-auto max-w-3xl px-4 py-10 sm:py-14 space-y-5">
      <header>
        <p className="text-xs uppercase tracking-wide text-muted-foreground">{data.org.name}</p>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight">Hello, {data.contact.name}</h1>
        <p className="mt-1 text-sm text-muted-foreground">Your quotes, invoices and appointments in one place.</p>
        {data.bookPath && (
          <Button asChild className="mt-4"><a href={data.bookPath}><CalendarDays className="h-4 w-4" /> Book a time</a></Button>
        )}
      </header>

      <div role="tablist" aria-label="Portal sections" className="flex flex-wrap gap-0.5 rounded-lg border border-border bg-card p-1">
        {([["overview", "Overview", FileText], ["documents", "Documents", FileSignature], ["files", "Files", Paperclip], ["support", "Support", LifeBuoy], ["privacy", "Privacy", Fingerprint]] as const).map(([id, label, Icon]) => (
          <button
            key={id}
            role="tab"
            type="button"
            aria-selected={tab === id}
            onClick={() => setTab(id)}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              tab === id ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"
            )}
          >
            <Icon className="h-3.5 w-3.5" aria-hidden="true" /> {label}
          </button>
        ))}
      </div>

      {tab === "documents" ? (
        <DocumentsTab token={params.token} />
      ) : tab === "files" ? (
        <FilesTab token={params.token} />
      ) : tab === "support" ? (
        <SupportTab token={params.token} />
      ) : tab === "privacy" ? (
        <PrivacyTab token={params.token} />
      ) : (
        <>
      <Section icon={CalendarDays} title="Upcoming appointments">
        {upcoming.length === 0 ? <Empty text="No upcoming appointments." /> : (
          <ul className="divide-y divide-border/60">
            {upcoming.map((b) => (
              <li key={b.id} className="flex items-center justify-between gap-3 py-2 text-sm">
                <div>
                  <div className="font-medium">{b.typeName ?? "Appointment"}</div>
                  <div className="text-xs text-muted-foreground">{when(b.startsAt, data.timezone)} ({data.timezone})</div>
                </div>
                <Button variant="outline" size="sm" disabled={busy === b.id} onClick={() => cancel(b.id)}>
                  {busy === b.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Cancel"}
                </Button>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section icon={FileText} title="Quotes">
        {data.quotes.length === 0 ? <Empty text="No quotes yet." /> : (
          <ul className="divide-y divide-border/60">
            {data.quotes.map((q) => (
              <li key={q.id} className="flex items-center justify-between gap-3 py-2 text-sm">
                <div>
                  <div className="font-medium">{q.number} <span className="ml-2 rounded-full bg-secondary px-2 py-0.5 text-[10px] capitalize text-muted-foreground">{q.status}</span></div>
                  <div className="text-xs text-muted-foreground">{money(q.totalMinor, q.currency)}{q.validUntil ? ` · valid until ${date(q.validUntil)}` : ""}</div>
                </div>
                {q.path && <Button asChild variant="outline" size="sm"><a href={q.path}>View</a></Button>}
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section icon={Receipt} title="Invoices">
        {data.balances && data.balances.length > 0 && (
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border bg-secondary/30 px-3 py-2 text-sm">
            <span>
              Balance:{" "}
              <span className="font-semibold tabular-nums">
                {data.balances.map((b) => money(b.closing_minor, b.currency)).join(" · ")}
              </span>
            </span>
            <Button asChild variant="outline" size="sm" touch>
              <a href={`/api/p/portal/${params.token}/statement?format=pdf`} target="_blank" rel="noopener">
                Statement (PDF)<span className="sr-only">, opens in a new tab</span>
              </a>
            </Button>
          </div>
        )}
        {data.invoices.length === 0 ? <Empty text="No invoices yet." /> : (
          <ul className="divide-y divide-border/60">
            {data.invoices.map((i) => (
              <li key={i.id} className="flex items-center justify-between gap-3 py-2 text-sm">
                <div>
                  <div className="font-medium">{i.number} <span className="ml-2 rounded-full bg-secondary px-2 py-0.5 text-[10px] capitalize text-muted-foreground">{i.status.replace("_", " ")}</span></div>
                  <div className="text-xs text-muted-foreground">
                    {money(i.totalMinor, i.currency)}{i.paidMinor > 0 ? ` · paid ${money(i.paidMinor, i.currency)}` : ""}{i.dueAt ? ` · due ${date(i.dueAt)}` : ""}
                  </div>
                </div>
                {i.path && <Button asChild variant="outline" size="sm"><a href={i.path}>View</a></Button>}
              </li>
            ))}
          </ul>
        )}
      </Section>

      {data.cards.length > 0 && (
        <Section icon={Kanban} title="Work in progress">
          <ul className="divide-y divide-border/60">
            {data.cards.map((c) => (
              <li key={c.id} className="flex items-center justify-between gap-3 py-2 text-sm">
                <span className="font-medium">{c.title}</span>
                <span className="text-xs capitalize text-muted-foreground">{c.status.replace(/_/g, " ")}{c.dueDate ? ` · due ${c.dueDate}` : ""}</span>
              </li>
            ))}
          </ul>
        </Section>
      )}
        </>
      )}
    </main>
  );
}
