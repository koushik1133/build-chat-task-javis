"use client";

import { useState } from "react";
import { useParams } from "next/navigation";
import { Loader2, Mail } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Banner } from "@/components/ui/feedback";

/** "Email me my portal link" — public, branded by the /p layout, never reveals whether an email is on file. */
export default function PortalLookupPage() {
  const { org } = useParams<{ org: string }>();
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await fetch("/api/p/portal/request-link", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ org, email }) });
      if (r.status === 429) throw new Error("Too many requests. Please try again in a few minutes.");
      const d = (await r.json().catch(() => ({}))) as { message?: string };
      setDone(d.message ?? "If we have a record for that email, a portal link is on its way.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto max-w-md px-4 py-12">
      <h1 className="text-2xl font-semibold tracking-tight">Access your portal</h1>
      <p className="mt-1 text-sm text-muted-foreground">Enter the email you use with us and we will send you a private link to your bookings, invoices and messages.</p>
      <div className="mt-6" aria-live="polite">
        {done ? (
          <Banner tone="success">{done}</Banner>
        ) : (
          <form onSubmit={submit} className="space-y-4">
            {error && <Banner tone="error">{error}</Banner>}
            <Field label="Email address" required>
              <Input type="email" required autoComplete="email" inputMode="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" />
            </Field>
            <Button type="submit" touch disabled={busy || !email.trim()} className="w-full">
              {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Mail className="h-4 w-4" aria-hidden />} Email me a link
            </Button>
          </form>
        )}
      </div>
    </div>
  );
}
