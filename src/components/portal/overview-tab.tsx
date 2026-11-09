"use client";

import { CalendarDays, CheckCircle2, ChevronRight, FileSignature, FileText, Kanban, MessageSquare, Receipt } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Pill } from "@/components/ui/pill";
import type { PortalData } from "@/lib/portal";
import { EmptyNote, ProgressBar, Section, dateOnly, money, whenIn } from "./portal-ui";
import type { PortalTabId } from "./portal-tabs";

interface Todo {
  t: PortalTabId;
  text: string;
  detail?: string;
  icon: LucideIcon;
  tone: "danger" | "warning" | "info";
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** Portal home: what you owe, what is next, and what is waiting on you. */
export function OverviewTab({ data, go }: { data: PortalData; go: (t: PortalTabId) => void }) {
  const next = data.upcomingBookings[0] ?? null;
  const project = data.projects.find((p) => p.status === "active") ?? data.projects[0] ?? null;
  const owed = data.balances.filter((b) => b.closing_minor > 0);
  const unpaid = data.invoices.filter((i) => i.payable);
  const overdue = unpaid.filter((i) => i.dueAt && new Date(i.dueAt).getTime() < Date.now());
  const nextDue = [...unpaid].filter((i) => i.dueAt).sort((a, b) => new Date(a.dueAt ?? 0).getTime() - new Date(b.dueAt ?? 0).getTime())[0];
  const sentQuotes = data.quotes.filter((q) => q.status === "sent");

  const todos: Todo[] = [];
  if (overdue.length > 0) todos.push({ t: "invoices", text: `${plural(overdue.length, "overdue invoice")}`, detail: "Please pay as soon as you can", icon: Receipt, tone: "danger" });
  if (unpaid.length > overdue.length) todos.push({ t: "invoices", text: plural(unpaid.length - overdue.length, "invoice") + " to pay", icon: Receipt, tone: "warning" });
  if (data.documents.length > 0) todos.push({ t: "documents", text: plural(data.documents.length, "document") + " to sign", icon: FileSignature, tone: "warning" });
  if (sentQuotes.length > 0) todos.push({ t: "invoices", text: sentQuotes.length === 1 ? "A quote is waiting for your answer" : `${sentQuotes.length} quotes are waiting for your answer`, icon: FileText, tone: "info" });
  if (data.unreadMessages > 0) todos.push({ t: "messages", text: plural(data.unreadMessages, "unread message"), icon: MessageSquare, tone: "info" });

  return (
    <div className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <Section icon={Receipt} title="What you owe" id="ov-balance">
          {owed.length === 0 ? (
            <p className="flex items-center gap-2 text-sm">
              <CheckCircle2 className="h-5 w-5 text-emerald-600 dark:text-emerald-400" aria-hidden /> You&apos;re all paid up. Thank you.
            </p>
          ) : (
            <>
              <p className="text-2xl font-semibold tabular-nums [overflow-wrap:anywhere]">{owed.map((b) => money(b.closing_minor, b.currency)).join(" · ")}</p>
              <p className="mt-1 text-xs text-muted-foreground">
                {plural(unpaid.length, "open invoice")}
                {nextDue?.dueAt ? ` · next due ${dateOnly(nextDue.dueAt)}` : ""}
              </p>
              <Button className="mt-3" size="sm" touch onClick={() => go("invoices")}>Review and pay</Button>
            </>
          )}
        </Section>

        <Section icon={CalendarDays} title="What's next" id="ov-booking">
          {next ? (
            <>
              <p className="font-medium">{next.typeName ?? "Appointment"}</p>
              <p className="text-sm text-muted-foreground">{whenIn(next.startsAt, data.timezone)}</p>
              <p className="text-xs text-muted-foreground">Times shown in {data.timezone}</p>
              <Button className="mt-3" size="sm" variant="outline" touch onClick={() => go("bookings")}>Reschedule or cancel</Button>
            </>
          ) : (
            <>
              <EmptyNote text="You have nothing booked right now." />
              {data.bookPath && <Button asChild className="mt-3" size="sm" touch><a href={data.bookPath}>Book a time</a></Button>}
            </>
          )}
        </Section>
      </div>

      <Section icon={FileSignature} title="Waiting on you" id="ov-open">
        {todos.length === 0 ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <CheckCircle2 className="h-4 w-4 text-emerald-600 dark:text-emerald-400" aria-hidden /> Nothing needs your attention. We will let you know when something does.
          </p>
        ) : (
          <ul className="-mx-2 space-y-0.5">
            {todos.map((o) => (
              <li key={o.text}>
                <button type="button" onClick={() => go(o.t)} className="flex min-h-11 w-full items-center gap-3 rounded-md px-2 text-left text-sm hover:bg-secondary/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:min-h-10">
                  <o.icon className="h-4 w-4 shrink-0 text-primary" aria-hidden />
                  <span className="min-w-0 flex-1">
                    <span className="font-medium">{o.text}</span>
                    {o.detail && <span className="block text-xs text-muted-foreground">{o.detail}</span>}
                  </span>
                  <Pill tone={o.tone}>{o.tone === "danger" ? "Overdue" : o.tone === "warning" ? "Action needed" : "Reply"}</Pill>
                  <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
                </button>
              </li>
            ))}
          </ul>
        )}
      </Section>

      {project && (
        <Section icon={Kanban} title="Active project" id="ov-project" aside={<Button size="sm" variant="ghost" touch onClick={() => go("projects")}>Details</Button>}>
          <div className="space-y-2">
            <p className="font-medium">{project.name}</p>
            <ProgressBar percent={project.percent} label={`${project.name} progress`} />
            <p className="text-xs text-muted-foreground">
              {project.percent}% complete{project.nextMilestone ? ` · next: ${project.nextMilestone.name}` : ""}{project.dueOn ? ` · due ${dateOnly(project.dueOn)}` : ""}
            </p>
          </div>
        </Section>
      )}
    </div>
  );
}
