"use client";

import { ShoppingBag } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Pill } from "@/components/ui/pill";
import type { PortalData } from "@/lib/portal";
import { EmptyNote, Section, dateOnly, money } from "./portal-ui";

const TONE = { paid: "success", fulfilled: "success", pending_payment: "warning", cancelled: "danger", refunded: "neutral" } as const;

export function OrdersTab({ data }: { data: PortalData }) {
  return (
    <Section icon={ShoppingBag} title="Your orders" id="ord-list">
      {data.orders.length === 0 ? (
        <EmptyNote text="No orders yet." />
      ) : (
        <ul className="divide-y divide-border/60">
          {data.orders.map((o) => (
            <li key={o.id} className="flex items-center justify-between gap-3 py-2 text-sm">
              <div>
                <div className="font-medium">{o.number} <Pill tone={TONE[o.status as keyof typeof TONE] ?? "neutral"} className="ml-2 capitalize">{o.status.replace(/_/g, " ")}</Pill></div>
                <div className="text-xs text-muted-foreground">{money(o.totalMinor, o.currency)} · {dateOnly(o.createdAt)}</div>
              </div>
              {o.path && <Button asChild variant="outline" size="sm" touch><a href={o.path}>Track order</a></Button>}
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}
