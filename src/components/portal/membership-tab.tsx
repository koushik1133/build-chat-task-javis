"use client";

import { useState } from "react";
import { CreditCard, IdCard, Loader2, Pause, Play } from "lucide-react";
import { Button } from "@/components/ui/button";
import { confirmDialog } from "@/components/ui/confirm-dialog";
import { Banner } from "@/components/ui/feedback";
import { Pill, type Tone } from "@/components/ui/pill";
import type { PortalData } from "@/lib/portal";
import type { PortalMembership } from "@/lib/memberships/portal";
import { EmptyNote, Section, dateOnly, money } from "./portal-ui";

const TONE: Record<string, Tone> = { active: "success", trialing: "info", past_due: "danger", paused: "warning", cancelled: "neutral", expired: "neutral", incomplete: "warning" };
const INVOICE_TONE: Record<string, Tone> = { paid: "success", sent: "warning", overdue: "danger", partially_paid: "warning", void: "neutral" };

function every(interval: string, count: number): string {
  return count === 1 ? interval : `${count} ${interval}s`;
}

type Action = "cancel" | "keep" | "pause" | "resume" | "update_payment_method";

/** Membership self-service: plan, next charge, benefits, payment method, pause/resume, cancel at period end. */
export function MembershipTab({ data, token, onChanged }: { data: PortalData; token: string; onChanged: () => Promise<void> }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ tone: "success" | "error"; text: string } | null>(null);
  const items = data.memberships ?? [];

  async function run(m: PortalMembership, action: Action, extra: Record<string, unknown> = {}, okText = "Done.") {
    setBusy(`${m.id}:${action}`);
    setNotice(null);
    try {
      const res = await fetch(`/api/p/portal/${token}/memberships`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, subscription_id: m.id, ...extra }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new Error(body?.message ?? "That did not work. Please contact us.");
      setNotice({ tone: "success", text: okText });
      await onChanged();
    } catch (err) {
      setNotice({ tone: "error", text: err instanceof Error ? err.message : "That did not work." });
    } finally {
      setBusy(null);
    }
  }

  async function cancel(m: PortalMembership) {
    const ok = await confirmDialog({
      title: "Cancel your membership?",
      body: `You keep access until ${m.currentPeriodEnd ? dateOnly(m.currentPeriodEnd) : "the end of your current period"}, then it ends and you will not be charged again.`,
      confirmLabel: "Cancel at period end",
      cancelLabel: "Keep membership",
      tone: "danger",
    });
    if (ok) await run(m, "cancel", {}, "Your membership will end at the close of this period.");
  }

  if (items.length === 0) {
    return (
      <Section icon={IdCard} title="Membership" id="mem-empty">
        <EmptyNote text="You have no memberships yet." />
      </Section>
    );
  }

  return (
    <div className="space-y-4">
      {notice && (
        <div role="status">
          <Banner tone={notice.tone} onDismiss={() => setNotice(null)}>{notice.text}</Banner>
        </div>
      )}
      {items.map((m) => (
        <Section
          key={m.id}
          icon={IdCard}
          title={m.planName}
          id={`mem-${m.id}`}
          aside={<Pill tone={TONE[m.status] ?? "neutral"} className="capitalize">{m.status.replace(/_/g, " ")}</Pill>}
        >
          <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
            <div>
              <dt className="text-xs text-muted-foreground">Price</dt>
              <dd>{money(m.amountMinor * m.quantity, m.currency)} / {every(m.interval, m.intervalCount)}{m.quantity > 1 ? ` (x${m.quantity})` : ""}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">{m.cancelAtPeriodEnd ? "Ends on" : m.trialEndsAt && m.status === "trialing" ? "Trial ends" : "Next charge"}</dt>
              <dd>
                {m.cancelAtPeriodEnd
                  ? m.currentPeriodEnd ? dateOnly(m.currentPeriodEnd) : "—"
                  : m.status === "trialing" && m.trialEndsAt ? dateOnly(m.trialEndsAt)
                  : m.nextChargeAt && m.status !== "cancelled" && m.status !== "expired" ? dateOnly(m.nextChargeAt) : "—"}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Payment method</dt>
              <dd>{m.hasPaymentMethod ? "Card on file" : "None saved (you pay each invoice)"}</dd>
            </div>
            {m.pauseUntil && (
              <div>
                <dt className="text-xs text-muted-foreground">Paused until</dt>
                <dd>{dateOnly(m.pauseUntil)}</dd>
              </div>
            )}
          </dl>

          {m.benefits.length > 0 && (
            <ul className="mt-3 list-disc space-y-1 pl-5 text-sm" aria-label="Your benefits">
              {m.benefits.map((b, i) => <li key={`${i}-${b.label}`}>{b.label}</li>)}
            </ul>
          )}

          {m.status === "past_due" && <Banner tone="warn" className="mt-3">Your last payment did not go through. Update your payment method or pay the open invoice below.</Banner>}
          {m.cancelAtPeriodEnd && <Banner tone="info" className="mt-3">Your membership is set to end at the close of this period.</Banner>}

          <div className="mt-4 flex flex-wrap gap-2">
            {m.payUrl && <Button asChild size="sm" touch><a href={m.payUrl}>Pay now</a></Button>}
            {m.simulatedPaymentMethod && (
              <>
                <Button variant="outline" size="sm" touch disabled={busy !== null} onClick={() => void run(m, "update_payment_method", { simulate: "ok" }, "Test card saved.")}>
                  {busy === `${m.id}:update_payment_method` ? <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden /> : <CreditCard className="h-4 w-4" aria-hidden />} Save test card
                </Button>
                <Button variant="outline" size="sm" touch disabled={busy !== null} onClick={() => void run(m, "update_payment_method", { simulate: "decline" }, "Declining test card saved.")}>
                  Save declining test card
                </Button>
              </>
            )}
            {m.canPause && (
              <Button variant="outline" size="sm" touch disabled={busy !== null} onClick={() => void run(m, "pause", {}, "Membership paused.")}>
                <Pause className="h-4 w-4" aria-hidden /> Pause
              </Button>
            )}
            {m.canResume && (
              <Button variant="outline" size="sm" touch disabled={busy !== null} onClick={() => void run(m, "resume", {}, "Welcome back. Your membership is active again.")}>
                <Play className="h-4 w-4" aria-hidden /> Resume
              </Button>
            )}
            {m.cancelAtPeriodEnd && m.status !== "cancelled" && m.status !== "expired" && (
              <Button variant="outline" size="sm" touch disabled={busy !== null} onClick={() => void run(m, "keep", {}, "Your membership will continue.")}>Keep my membership</Button>
            )}
            {m.canCancel && (
              <Button variant="outline" size="sm" touch disabled={busy !== null} onClick={() => void cancel(m)}>Cancel membership</Button>
            )}
          </div>

          {m.invoices.length > 0 && (
            <div className="mt-5">
              <h3 className="mb-1 text-xs font-medium text-muted-foreground">Invoices</h3>
              <ul className="divide-y divide-border/60">
                {m.invoices.map((i) => (
                  <li key={i.id} className="flex items-center justify-between gap-3 py-2 text-sm">
                    <div>
                      <span className="font-medium">{i.number}</span>{" "}
                      <Pill tone={INVOICE_TONE[i.status] ?? "neutral"} className="ml-1 capitalize">{i.status.replace(/_/g, " ")}</Pill>
                      <div className="text-xs text-muted-foreground">{money(i.totalMinor, i.currency)} · {dateOnly(i.createdAt)}</div>
                    </div>
                    {i.path && <Button asChild variant="outline" size="sm" touch><a href={i.path}>View</a></Button>}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </Section>
      ))}
    </div>
  );
}
