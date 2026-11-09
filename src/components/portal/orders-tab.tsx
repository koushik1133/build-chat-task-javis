"use client";

import { ShoppingBag } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Pill } from "@/components/ui/pill";
import type { PortalData } from "@/lib/portal";
import { EmptyNote, Section, dateOnly, money } from "./portal-ui";
import { CustomerReturns } from "@/components/shipping/customer-returns";

const TONE = { paid: "success", fulfilled: "success", pending_payment: "warning", cancelled: "danger", refunded: "neutral" } as const;

export function OrdersTab({ data, token }: { data: PortalData; token?: string }) {
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
              <div className="flex flex-wrap items-center justify-end gap-2">
                {o.path && <Button asChild variant="outline" size="sm" touch><a href={o.path}>Track order</a></Button>}
                {o.path && (o.status === "fulfilled" || o.status === "paid") && <Button asChild variant="outline" size="sm" touch><a href={`/track/${o.path.split("/").pop()}`}>Shipment tracking</a></Button>}
                {token && (o.status === "fulfilled" || o.status === "paid") && <CustomerReturns compact infoUrl={`/api/p/portal/${token}/returns?order_id=${encodeURIComponent(o.id)}`} postUrl={`/api/p/portal/${token}/returns`} extraBody={{ order_id: o.id }} />}
              </div>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}
