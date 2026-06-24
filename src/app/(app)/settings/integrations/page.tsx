"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import {
  Bell, Mail, MessageSquare, CheckCircle2, AlertCircle,
  Loader2, FlaskConical, ChevronRight, Sparkles, ExternalLink,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { dispatchNotificationRefresh } from "@/components/notification-bell";

type Integrations = {
  slack_connected: boolean;
  slack_channel_name: string | null;
  slack_webhook_masked: string | null;
  email_connected: boolean;
  email_verified: boolean;
  email_pending: string | null;
  email_default_to: string | null;
  email_from_name: string | null;
  email_available: boolean;
  notifications_enabled: boolean;
};

export default function ConnectionsPage() {
  const [data, setData] = useState<Integrations | null>(null);
  const [loading, setLoading] = useState(true);
  const [slackUrl, setSlackUrl] = useState("");
  const [slackChannel, setSlackChannel] = useState("");
  const [emailTo, setEmailTo] = useState("");
  const [emailFromName, setEmailFromName] = useState("");
  const [emailCode, setEmailCode] = useState("");
  const [codeSent, setCodeSent] = useState(false);
  const [savingSlack, setSavingSlack] = useState(false);
  const [sendingCode, setSendingCode] = useState(false);
  const [verifyingCode, setVerifyingCode] = useState(false);
  const [testResults, setTestResults] = useState<Record<string, string>>({});

  useEffect(() => {
    fetch("/api/integrations")
      .then(r => r.json())
      .then(d => {
        const i = d.integrations as Integrations;
        setData(i);
        setSlackUrl(i.slack_webhook_masked ?? "");
        setSlackChannel(i.slack_channel_name ?? "");
        setEmailTo(i.email_default_to ?? i.email_pending ?? "");
        setEmailFromName(i.email_from_name ?? "");
        setCodeSent(!!i.email_pending && !i.email_verified);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  async function connectSlack() {
    const url = slackUrl.trim();
    const isMasked = url.includes("***");

    if (!url && !data?.slack_connected) {
      setTestResults(r => ({ ...r, slack: "✗ Paste your full Slack webhook URL first." }));
      return;
    }
    if (!isMasked && url && !url.includes("hooks.slack.com")) {
      setTestResults(r => ({ ...r, slack: "✗ That doesn't look like a Slack webhook URL." }));
      return;
    }
    if (isMasked && !data?.slack_connected) {
      setTestResults(r => ({ ...r, slack: "✗ Paste your full Slack webhook URL first." }));
      return;
    }

    setSavingSlack(true);
    setTestResults(r => ({ ...r, slack: "Connecting…" }));
    const res = await fetch("/api/integrations/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "slack",
        slack_webhook_url: isMasked ? undefined : url,
        slack_channel_name: slackChannel,
      }),
    }).then(r => r.json()).catch(() => null);

    if (res?.integrations) {
      const i = res.integrations as Integrations;
      setData(i);
      setSlackUrl(i.slack_webhook_masked ?? "");
    }

    setTestResults(r => ({
      ...r,
      slack: res?.success ? `✓ ${res.message}` : `✗ ${res.detail ?? res?.message ?? "Failed"}`,
    }));
    setSavingSlack(false);
  }

  async function sendEmailCode() {
    if (!emailTo.trim()) return;
    setSendingCode(true);
    const res = await fetch("/api/integrations/email", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "send-code", email: emailTo, email_from_name: emailFromName }),
    }).then(r => r.json()).catch(() => null);

    if (res?.success) {
      setCodeSent(true);
      setTestResults(r => ({ ...r, email: `✓ ${res.message}` }));
    } else {
      setTestResults(r => ({ ...r, email: `✗ ${res?.message ?? "Could not send code"}` }));
    }
    setSendingCode(false);
  }

  async function verifyEmailCode() {
    if (!emailCode.trim()) return;
    setVerifyingCode(true);
    const res = await fetch("/api/integrations/email", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "verify", code: emailCode }),
    }).then(r => r.json()).catch(() => null);

    if (res?.success && res.integrations) {
      const i = res.integrations as Integrations;
      setData(i);
      setCodeSent(false);
      setEmailCode("");
      setEmailTo(i.email_default_to ?? "");
      setTestResults(r => ({ ...r, email: `✓ ${res.message}` }));
    } else {
      setTestResults(r => ({ ...r, email: `✗ ${res?.message ?? "Verification failed"}` }));
    }
    setVerifyingCode(false);
  }

  async function test(type: "slack" | "email" | "notification") {
    if (type === "slack") {
      await connectSlack();
      return;
    }

    setTestResults(r => ({ ...r, [type]: "Testing…" }));
    const res = await fetch("/api/integrations/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type }),
    }).then(r => r.json()).catch(() => null);

    setTestResults(r => ({
      ...r,
      [type]: res?.success ? `✓ ${res.message}` : `✗ ${res.detail ?? res?.message ?? "Failed"}`,
    }));

    if (type === "notification" && res?.success && res.notification) {
      dispatchNotificationRefresh(res.notification);
    }
  }

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const connectedCount = [
    data?.notifications_enabled,
    data?.email_connected,
    data?.slack_connected,
  ].filter(Boolean).length;

  return (
    <div className="h-full overflow-y-auto overflow-x-hidden px-4 py-5 sm:px-6 sm:py-7 lg:px-8 lg:py-8">
      <div className="mx-auto w-full max-w-2xl space-y-8">
        <div>
          <p className="mb-1 text-xs font-medium text-primary">Settings</p>
          <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">Connections</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            One-time setup. Connect Slack and email once — every automation uses these automatically.
          </p>
        </div>

        <div className="rounded-xl border border-border bg-card p-4 flex items-center gap-4">
          <div className="rounded-full bg-primary/10 p-2">
            <Sparkles className="h-5 w-5 text-primary" />
          </div>
          <div className="flex-1">
            <p className="text-sm font-medium">{connectedCount} of 3 connected</p>
            <p className="text-xs text-muted-foreground">Website alerts work instantly. Connect Slack & email below.</p>
          </div>
          <Link href="/automations">
            <Button size="sm" variant="outline">
              Automations <ChevronRight className="h-3.5 w-3.5" />
            </Button>
          </Link>
        </div>

        {/* Website notifications — always on */}
        <ConnectionCard
          icon={Bell}
          title="Website notifications"
          subtitle="Bell icon in the sidebar — no setup needed"
          connected={!!data?.notifications_enabled}
          connectedLabel="Always on"
        >
          <p className="text-xs text-muted-foreground mb-3">
            Automations with &quot;Send Notification&quot; appear in your KernelHub bell icon instantly.
          </p>
          <Button size="sm" variant="outline" onClick={() => test("notification")}>
            <FlaskConical className="h-3.5 w-3.5" /> Send test notification
          </Button>
          {testResults.notification && <TestResult msg={testResults.notification} />}
        </ConnectionCard>

        {/* Email */}
        <ConnectionCard
          icon={Mail}
          title="Email alerts"
          subtitle={data?.email_available
            ? "Enter where you want alerts sent — we handle delivery"
            : "Your admin enables email for the whole platform (one-time)"}
          connected={!!data?.email_connected}
          connectedLabel={data?.email_default_to ?? undefined}
        >
          {!data?.email_available ? (
            <div className="rounded-lg bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 p-3 text-xs text-amber-800 dark:text-amber-200">
              Email sending is configured by your KernelHub team using your company domain
              (e.g. <code className="bg-white/50 dark:bg-black/20 px-1 rounded">ai@yourcompany.com</code>).
              You only need to enter your personal inbox below once it&apos;s enabled.
            </div>
          ) : (
            <>
              <p className="text-[11px] text-muted-foreground/80 mb-3 italic">
                (Note: You will receive verification and alert emails from <strong>shagantikoushik@gmail.com</strong> because we did not buy a custom domain yet. Later, it will change to a genuine address like <strong>noreply@kernelhub.com</strong>)
              </p>
              {data?.email_verified ? (
                <div className="rounded-lg border border-green-200 dark:border-green-800 bg-green-50 dark:bg-green-950/30 p-3 mb-3">
                  <p className="text-xs font-medium text-green-800 dark:text-green-200 flex items-center gap-1">
                    <CheckCircle2 className="h-3.5 w-3.5" /> Verified: {data.email_default_to}
                  </p>
                </div>
              ) : (
                <>
                  <Field label="Your email address">
                    <input type="email" value={emailTo} onChange={e => setEmailTo(e.target.value)}
                      placeholder="you@company.com" className={inputCls} disabled={codeSent} />
                  </Field>
                  <Field label="Company name (optional — shown in email sender)">
                    <input value={emailFromName} onChange={e => setEmailFromName(e.target.value)}
                      placeholder="Acme Corp" className={inputCls} disabled={codeSent} />
                  </Field>
                  {!codeSent ? (
                    <Button size="sm" onClick={sendEmailCode} disabled={sendingCode || !emailTo.trim()}>
                      {sendingCode ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Send verification code"}
                    </Button>
                  ) : (
                    <div className="space-y-3">
                      <p className="text-xs text-muted-foreground">
                        We sent a 6-digit code to <strong className="text-foreground">{data?.email_pending ?? emailTo}</strong>. Check your inbox (and spam).
                      </p>
                      <Field label="Verification code">
                        <input
                          value={emailCode}
                          onChange={e => setEmailCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
                          placeholder="123456"
                          className={cn(inputCls, "tracking-widest font-mono text-center text-lg")}
                          maxLength={6}
                          inputMode="numeric"
                        />
                      </Field>
                      <div className="flex gap-2 flex-wrap">
                        <Button size="sm" onClick={verifyEmailCode} disabled={verifyingCode || emailCode.length < 6}>
                          {verifyingCode ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Verify email"}
                        </Button>
                        <Button size="sm" variant="outline" onClick={() => { setCodeSent(false); setEmailCode(""); sendEmailCode(); }} disabled={sendingCode}>
                          Resend code
                        </Button>
                      </div>
                    </div>
                  )}
                </>
              )}
              {data?.email_verified && (
                <Button size="sm" variant="outline" className="mt-3" onClick={() => test("email")}>
                  <FlaskConical className="h-3.5 w-3.5" /> Test email
                </Button>
              )}
              {testResults.email && <TestResult msg={testResults.email} />}
            </>
          )}
        </ConnectionCard>

        {/* Slack */}
        <ConnectionCard
          icon={MessageSquare}
          title="Slack"
          subtitle="Post automation alerts to a Slack channel"
          connected={!!data?.slack_connected}
          connectedLabel={data?.slack_channel_name ? `#${data.slack_channel_name.replace(/^#/, "")}` : "Connected"}
        >
          <div className="rounded-lg bg-secondary/50 p-3 mb-4 space-y-2">
            <p className="text-xs font-semibold">How to connect (5 minutes, one time)</p>
            <ol className="text-xs text-muted-foreground space-y-1.5 list-decimal list-inside">
              <li>Open <a href="https://api.slack.com/apps" target="_blank" rel="noopener noreferrer" className="text-primary hover:underline inline-flex items-center gap-0.5">Slack Apps <ExternalLink className="h-3 w-3" /></a> → Create New App → From scratch</li>
              <li>Go to <strong className="text-foreground">Incoming Webhooks</strong> → turn On</li>
              <li>Click <strong className="text-foreground">Add New Webhook to Workspace</strong> → pick a channel → Allow</li>
              <li>Copy the webhook URL and paste it below</li>
            </ol>
          </div>
          <Field label="Slack channel name (optional, for your reference)">
            <input value={slackChannel} onChange={e => setSlackChannel(e.target.value)}
              placeholder="#general" className={inputCls} />
          </Field>
          <Field label="Webhook URL">
            <input value={slackUrl} onChange={e => setSlackUrl(e.target.value)}
              placeholder="https://hooks.slack.com/services/T.../B.../..."
              className={inputCls} />
            {data?.slack_connected && slackUrl.includes("***") && (
              <p className="text-[11px] text-muted-foreground mt-1">Leave as-is to keep current connection, or paste a new URL to change channel.</p>
            )}
          </Field>
          <div className="flex gap-2 mt-3">
            <Button size="sm" onClick={connectSlack} disabled={savingSlack || (!slackUrl.trim() && !data?.slack_connected)}>
              {savingSlack ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : data?.slack_connected && slackUrl.includes("***") ? "Test Slack again" : data?.slack_connected ? "Update & test Slack" : "Connect & test Slack"}
            </Button>
          </div>
          <p className="text-[11px] text-muted-foreground mt-2">
            Saves your webhook and sends a test message in one step — no separate Save needed.
          </p>
          {testResults.slack && <TestResult msg={testResults.slack} />}
        </ConnectionCard>

        <p className="text-xs text-center text-muted-foreground pb-8">
          Need help? Your team can walk you through this once — then automations work forever.
        </p>
      </div>
    </div>
  );
}

function ConnectionCard({
  icon: Icon, title, subtitle, connected, connectedLabel, children,
}: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  subtitle: string;
  connected: boolean;
  connectedLabel?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-xl border border-border bg-card overflow-hidden">
      <div className="flex items-start gap-3 p-5 border-b border-border bg-secondary/30">
        <div className={cn("rounded-lg p-2", connected ? "bg-green-100 dark:bg-green-950" : "bg-secondary")}>
          <Icon className={cn("h-5 w-5", connected ? "text-green-600 dark:text-green-400" : "text-muted-foreground")} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <h2 className="font-semibold text-sm">{title}</h2>
            {connected && (
              <span className="inline-flex items-center gap-1 text-[10px] font-medium rounded-full px-2 py-0.5 bg-green-50 text-green-700 dark:bg-green-950 dark:text-green-400">
                <CheckCircle2 className="h-3 w-3" />
                {connectedLabel ?? "Connected"}
              </span>
            )}
          </div>
          <p className="text-xs text-muted-foreground mt-0.5">{subtitle}</p>
        </div>
      </div>
      <div className="p-5">{children}</div>
    </div>
  );
}

function TestResult({ msg }: { msg: string }) {
  const ok = msg.startsWith("✓");
  return (
    <p className={cn("text-xs mt-2 flex items-center gap-1", ok ? "text-green-600" : "text-red-500")}>
      {ok ? <CheckCircle2 className="h-3 w-3" /> : <AlertCircle className="h-3 w-3" />}
      {msg.replace(/^[✓✗]\s*/, "")}
    </p>
  );
}

const inputCls = "w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-primary/30";

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="mb-3">
      <label className="text-xs font-medium text-muted-foreground mb-1 block">{label}</label>
      {children}
    </div>
  );
}
