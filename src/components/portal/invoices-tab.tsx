"use client";

import { FileText, Receipt } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Pill } from "@/components/ui/pill";
import type { PortalData } from "@/lib/portal";
import { EmptyNote, Section, dateOnly, money } from "./portal-ui";

const TONE = { paid: "success", overdue: "danger", partial: "warning", partially_paid: "warning", sent: "info" } as const;

/** Invoices with pay links, statement PDF and quotes. */
export function InvoicesTab({ data, token }: { data: PortalData; token: string }) {
  return (
    <div className="space-y-4">
      <Section icon={Receipt} title="Invoices & payments" id="inv-list">
        {data.statement.balances.length > 0 && (
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border bg-secondary/30 px-3 py-2 text-sm">
            <span>
              Balance: <span className="font-semibold tabular-nums">{data.statement.balances.map((b) => money(b.closing_minor, b.currency)).join(" · ")}</span>
            </span>
            <Button asChild variant="outline" size="sm" touch>
              <a href={`/api/p/portal/${token}/statement?format=pdf`} target="_blank" rel="noopener">
                Statement (PDF)<span className="sr-only">, opens in a new tab</span>
              </a>
            </Button>
          </div>
        )}
        {data.invoices.length === 0 ? (
          <EmptyNote text="No invoices yet." />
        ) : (
          <ul className="divide-y divide-border/60">
            {data.invoices.map((i) => (
              <li key={i.id} className="flex flex-wrap items-center justify-between gap-3 py-2 text-sm">
                <div className="min-w-0">
                  <div className="font-medium">
                    {i.number} <Pill tone={TONE[i.status as keyof typeof TONE] ?? "neutral"} className="ml-2 capitalize">{i.status.replace(/_/g, " ")}</Pill>
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {money(i.totalMinor, i.currency)}
                    {i.paidMinor > 0 ? ` · paid ${money(i.paidMinor, i.currency)}` : ""}
                    {i.dueAt ? ` · due ${dateOnly(i.dueAt)}` : ""}
                  </div>
                </div>
                {i.path && (
                  <Button asChild variant={i.payable ? "default" : "outline"} size="sm" touch>
                    <a href={i.path}>{i.payable ? `Pay ${money(i.outstandingMinor, i.currency)}` : "View"}</a>
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section icon={FileText} title="Quotes" id="inv-quotes">
        {data.quotes.length === 0 ? (
          <EmptyNote text="No quotes yet." />
        ) : (
          <ul className="divide-y divide-border/60">
            {data.quotes.map((q) => (
              <li key={q.id} className="flex items-center justify-between gap-3 py-2 text-sm">
                <div>
                  <div className="font-medium">{q.number} <Pill className="ml-2 capitalize">{q.status}</Pill></div>
                  <div className="text-xs text-muted-foreground">{money(q.totalMinor, q.currency)}{q.validUntil ? ` · valid until ${dateOnly(q.validUntil)}` : ""}</div>
                </div>
                {q.path && <Button asChild variant="outline" size="sm" touch><a href={q.path}>View</a></Button>}
              </li>
            ))}
          </ul>
        )}
      </Section>
    </div>
  );
}
