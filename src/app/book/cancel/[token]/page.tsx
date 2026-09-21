"use client";

import { useState } from "react";
import { useParams } from "next/navigation";
import { Check, Loader2, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";

export default function CancelBookingPage() {
  const params = useParams<{ token: string }>();
  const [state, setState] = useState<"idle" | "busy" | "done" | "error">("idle");
  const [message, setMessage] = useState<string | null>(null);

  async function cancel() {
    setState("busy");
    try {
      const res = await fetch(`/api/book/cancel/${params.token}`, { method: "POST" });
      if (res.status === 404) throw new Error("This cancellation link is not valid.");
      if (!res.ok) throw new Error("Could not cancel the booking.");
      setState("done");
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Could not cancel the booking.");
      setState("error");
    }
  }

  return (
    <main className="mx-auto max-w-md px-4 py-16">
      <div className="rounded-2xl border border-border bg-card p-8 text-center">
        {state === "done" ? (
          <>
            <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300"><Check className="h-6 w-6" /></div>
            <h1 className="text-xl font-semibold">Booking cancelled</h1>
            <p className="mt-2 text-sm text-muted-foreground">We have let the team know. You can book again any time.</p>
          </>
        ) : (
          <>
            <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-secondary text-muted-foreground"><XCircle className="h-6 w-6" /></div>
            <h1 className="text-xl font-semibold">Cancel your booking?</h1>
            <p className="mt-2 text-sm text-muted-foreground">This frees the time for someone else. It cannot be undone.</p>
            {message && <p className="mt-3 text-sm text-red-600 dark:text-red-400">{message}</p>}
            <Button variant="destructive" className="mt-6" onClick={cancel} disabled={state === "busy"}>
              {state === "busy" && <Loader2 className="h-4 w-4 animate-spin" />} Yes, cancel it
            </Button>
          </>
        )}
      </div>
    </main>
  );
}
