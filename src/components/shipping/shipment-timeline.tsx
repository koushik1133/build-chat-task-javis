"use client";

import { useEffect, useState } from "react";
import { api } from "@/components/finance/shared";
import { ErrorState, Loading } from "@/components/ui/feedback";
import { fmtWhen, type ShipmentEventView } from "./shared";

/** Tracking history for one shipment (staff). */
export function ShipmentTimeline({ shipmentId, refreshKey = 0 }: { shipmentId: string; refreshKey?: number }) {
  const [events, setEvents] = useState<ShipmentEventView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    api<{ events: ShipmentEventView[] }>(`/api/shipping/shipments/${shipmentId}`)
      .then((r) => live && (setEvents(r.events), setError(null)))
      .catch((e: unknown) => live && setError(e instanceof Error ? e.message : "Could not load tracking"));
    return () => {
      live = false;
    };
  }, [shipmentId, refreshKey]);
  if (error) return <ErrorState message={error} />;
  if (!events) return <Loading label="Loading tracking…" />;
  if (events.length === 0) return <p className="text-xs text-muted-foreground">No tracking events yet.</p>;
  return (
    <ol className="space-y-2 border-l border-border pl-3" aria-label="Tracking history">
      {[...events].reverse().map((e) => (
        <li key={e.id} className="relative text-xs">
          <span className="absolute -left-[17px] top-1 h-2 w-2 rounded-full bg-primary" aria-hidden />
          <p className="font-medium">{e.description ?? e.status.replace(/_/g, " ")}</p>
          <p className="text-muted-foreground">{fmtWhen(e.occurred_at)}{e.location ? ` · ${e.location}` : ""}</p>
        </li>
      ))}
    </ol>
  );
}
