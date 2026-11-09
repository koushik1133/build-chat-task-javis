"use client";

import { CheckCircle2, Circle, Kanban } from "lucide-react";
import { Pill } from "@/components/ui/pill";
import type { PortalData } from "@/lib/portal";
import { EmptyNote, ProgressBar, Section, dateOnly } from "./portal-ui";

/** Projects (progress + milestones) and legacy production cards. */
export function ProjectsTab({ data }: { data: PortalData }) {
  return (
    <div className="space-y-4">
      {data.projects.length === 0 && data.cards.length === 0 && (
        <Section icon={Kanban} title="Projects" id="prj-empty"><EmptyNote text="No projects yet." /></Section>
      )}
      {data.projects.map((p) => (
        <Section key={p.id} icon={Kanban} title={p.name} id={`prj-${p.id}`} aside={<Pill className="capitalize">{p.status.replace(/_/g, " ")}</Pill>}>
          <ProgressBar percent={p.percent} label={`${p.name} progress`} />
          <p className="mt-1.5 text-xs text-muted-foreground">{p.percent}% complete{p.dueOn ? ` · due ${dateOnly(p.dueOn)}` : ""}</p>
          {p.milestones.length > 0 && (
            <ul className="mt-3 space-y-1.5" aria-label={`${p.name} milestones`}>
              {p.milestones.map((m, i) => (
                <li key={`${m.name}-${i}`} className="flex items-center gap-2 text-sm">
                  {m.done ? <CheckCircle2 className="h-4 w-4 text-emerald-600" aria-label="Done" /> : <Circle className="h-4 w-4 text-muted-foreground" aria-label="Open" />}
                  <span className={m.done ? "text-muted-foreground line-through" : ""}>{m.name}</span>
                  {m.dueOn && <span className="ml-auto text-xs text-muted-foreground">{dateOnly(m.dueOn)}</span>}
                </li>
              ))}
            </ul>
          )}
        </Section>
      ))}
      {data.cards.length > 0 && (
        <Section icon={Kanban} title="Work in progress" id="prj-cards">
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
    </div>
  );
}
