"use client";

import { CalendarDays, Kanban, Receipt, FileSignature, MessageSquare } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { PortalData } from "@/lib/portal";
import { EmptyNote, ProgressBar, Section, dateOnly, money, whenIn } from "./portal-ui";
import type { PortalTabId } from "./portal-tabs";

/** Portal home: what is owed, what is next, and what needs attention. */
export function OverviewTab({ data, go }: { data: PortalData; go: (t: PortalTabId) => void }) {
  const next = data.upcomingBookings[0] ?? null;
  const project = data.projects.find((p) => p.status === "active") ?? data.projects[0] ?? null;
  const owed = data.balances.filter((b) => b.closing_minor > 0);
  const unpaid = data.invoices.filter((i) => i.payable);
  const openItems: Array<{ t: PortalTabId; text: string } | null> = [
    unpaid.length > 0 ? { t: "invoices" as const, text: `${unpaid.length} unpaid invoice${unpaid.length === 1 ? "" : "s"}` } : null,
    data.documents.length > 0 ? { t: "documents" as const, text: `${data.documents.length} document${data.documents.length === 1 ? "" : "s"} to sign` } : null,
    data.unreadMessages > 0 ? { t: "messages" as const, text: `${data.unreadMessages} unread message${data.unreadMessages === 1 ? "" : "s"}` } : null,
    data.quotes.some((q) => q.status === "sent") ? { t: "invoices" as const, text: "A quote is waiting for your answer" } : null,
  ];
  const items = openItems.filter((x): x is { t: PortalTabId; text: string } => x !== null);

  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <Section icon={Receipt} title="Balance due" id="ov-balance">
        {owed.length === 0 ? (
          <EmptyNote text="You're all paid up." />
        ) : (
          <>
            <p className="text-2xl font-semibold tabular-nums">{owed.map((b) => money(b.closing_minor, b.currency)).join(" · ")}</p>
            <Button className="mt-3" size="sm" variant="outline" touch onClick={() => go("invoices")}>View invoices</Button>
          </>
        )}
      </Section>

      <Section icon={CalendarDays} title="Next appointment" id="ov-booking">
        {next ? (
          <>
            <p className="font-medium">{next.typeName ?? "Appointment"}</p>
            <p className="text-sm text-muted-foreground">{whenIn(next.startsAt, data.timezone)} ({data.timezone})</p>
            <Button className="mt-3" size="sm" variant="outline" touch onClick={() => go("bookings")}>Manage</Button>
          </>
        ) : (
          <>
            <EmptyNote text="No upcoming appointments." />
            {data.bookPath && <Button asChild className="mt-3" size="sm" touch><a href={data.bookPath}>Book a time</a></Button>}
          </>
        )}
      </Section>

      <Section icon={Kanban} title="Active project" id="ov-project">
        {project ? (
          <div className="space-y-2">
            <p className="font-medium">{project.name}</p>
            <ProgressBar percent={project.percent} label={`${project.name} progress`} />
            <p className="text-xs text-muted-foreground">
              {project.percent}% complete{project.nextMilestone ? ` · next: ${project.nextMilestone.name}` : ""}{project.dueOn ? ` · due ${dateOnly(project.dueOn)}` : ""}
            </p>
          </div>
        ) : (
          <EmptyNote text="No projects yet." />
        )}
      </Section>

      <Section icon={FileSignature} title="Needs your attention" id="ov-open">
        {items.length === 0 ? (
          <EmptyNote text="Nothing needs your attention." />
        ) : (
          <ul className="space-y-1">
            {items.map((o) => (
              <li key={o.text}>
                <button type="button" onClick={() => go(o.t)} className="flex min-h-11 w-full items-center gap-2 rounded-md px-2 text-left text-sm hover:bg-secondary/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:min-h-8">
                  {o.t === "messages" ? <MessageSquare className="h-4 w-4 text-primary" aria-hidden /> : <FileSignature className="h-4 w-4 text-primary" aria-hidden />}
                  {o.text}
                </button>
              </li>
            ))}
          </ul>
        )}
      </Section>
    </div>
  );
}
