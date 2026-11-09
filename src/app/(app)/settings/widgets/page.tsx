"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Check, Copy, Download, ExternalLink, Loader2, MessageSquareCode, RefreshCw, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Banner, Empty, ErrorState, Loading } from "@/components/ui/feedback";
import { Checkbox, Input, Select, Textarea } from "@/components/ui/input";
import { Pill } from "@/components/ui/pill";
import { PageContainer } from "@/components/page-container";
import { isAbortError, useAbortable } from "@/components/ui/hooks";
import {
  CONSENT_MODES,
  DEFAULT_CONSENT_TEXT,
  MAX_CONSENT_TEXT,
  MAX_GREETING,
  WIDGET_MODES,
  WIDGET_POSITIONS,
  embedSnippet,
  type WidgetConfig,
  type WidgetMode,
  type WidgetSiteDTO,
} from "@/lib/webchat/config";
import { cn } from "@/lib/utils";

type Notice = { tone: "success" | "error"; text: string };

interface SettingsPayload {
  sites: WidgetSiteDTO[];
  branding: { primaryColor: string; brandName: string };
  orgSlug: string | null;
  appUrl: string;
}

const MODE_META: Record<WidgetMode, { label: string; hint: string }> = {
  chat: { label: "AI chat", hint: "The receptionist answers visitors; they can leave details for a human." },
  lead: { label: "Contact form", hint: "Classic name / email / message form into your leads inbox." },
  booking: { label: "Booking", hint: "Visitors pick a time from your active booking types." },
  help: { label: "Help centre", hint: "Search your public knowledge base and open a ticket." },
};

async function readError(res: Response, fallback: string): Promise<string> {
  const d = await res.json().catch(() => null);
  return d && (d.detail || d.error) ? String(typeof d.detail === "string" ? d.detail : d.error) : `${fallback} (${res.status})`;
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  }
  return (
    <Button type="button" size="sm" variant="outline" touch onClick={copy} aria-live="polite">
      {copied ? <Check className="h-3.5 w-3.5" aria-hidden /> : <Copy className="h-3.5 w-3.5" aria-hidden />}
      <span className="ml-1.5">{copied ? "Copied" : "Copy snippet"}</span>
    </Button>
  );
}

export default function WidgetSettingsPage() {
  const [data, setData] = useState<SettingsPayload | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [siteId, setSiteId] = useState<string>("");
  const [config, setConfig] = useState<WidgetConfig | null>(null);
  const [consentText, setConsentText] = useState("");
  const [origins, setOrigins] = useState("");
  const [saving, setSaving] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [previewKey, setPreviewKey] = useState(0);
  const abortSignal = useAbortable();

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      const res = await fetch("/api/widget/settings", { signal: abortSignal(), cache: "no-store" });
      if (!res.ok) throw new Error(await readError(res, "Could not load widget settings"));
      const json = (await res.json()) as SettingsPayload;
      setData(json);
      setSiteId((cur) => cur || json.sites[0]?.id || "");
    } catch (err) {
      if (isAbortError(err)) return;
      setLoadError(err instanceof Error ? err.message : "Could not load widget settings");
    }
  }, [abortSignal]);

  useEffect(() => {
    void load();
  }, [load]);

  const site = useMemo(() => data?.sites.find((s) => s.id === siteId) ?? null, [data, siteId]);

  useEffect(() => {
    if (!site) return;
    setConfig({ ...site.config, modes: { ...site.config.modes } });
    setConsentText(site.consentText ?? "");
    setOrigins(site.allowedOrigins.join("\n"));
    setNotice(null);
  }, [site]);

  const effectiveColor = config?.color ?? data?.branding.primaryColor ?? "#f97316";
  const snippet = useMemo(() => (data && site && config ? embedSnippet(data.appUrl, site.id, { ...config, color: config.color }) : ""), [data, site, config]);
  const previewUrl = useMemo(() => {
    if (!site || !config) return "";
    const q = new URLSearchParams({ site: site.id, mode: config.defaultMode, position: config.position, consent: config.consentMode, color: effectiveColor, greeting: config.greeting, v: String(previewKey) });
    return `/widget-demo?${q.toString()}`;
  }, [site, config, effectiveColor, previewKey]);

  function patch<K extends keyof WidgetConfig>(key: K, value: WidgetConfig[K]) {
    setConfig((c) => (c ? { ...c, [key]: value } : c));
  }
  function toggleMode(m: WidgetMode, on: boolean) {
    setConfig((c) => {
      if (!c) return c;
      const modes = { ...c.modes, [m]: on };
      const defaultMode = modes[c.defaultMode] ? c.defaultMode : (WIDGET_MODES.find((x) => modes[x]) ?? "chat");
      return { ...c, modes, defaultMode };
    });
  }

  async function save() {
    if (!site || !config) return;
    setSaving(true);
    setNotice(null);
    try {
      const res = await fetch("/api/widget/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          siteId: site.id,
          config,
          consentText: consentText.trim() || null,
          allowedOrigins: origins.split(/[\n,]/).map((o) => o.trim()).filter(Boolean),
        }),
      });
      if (!res.ok) throw new Error(await readError(res, "Could not save"));
      const json = (await res.json()) as { site: WidgetSiteDTO };
      setData((d) => (d ? { ...d, sites: d.sites.map((s) => (s.id === json.site.id ? json.site : s)) } : d));
      setNotice({ tone: "success", text: "Widget settings saved. The preview has been refreshed." });
      setPreviewKey((k) => k + 1);
    } catch (err) {
      setNotice({ tone: "error", text: err instanceof Error ? err.message : "Could not save" });
    } finally {
      setSaving(false);
    }
  }

  async function install(action: "install" | "uninstall") {
    if (!site) return;
    setInstalling(true);
    setNotice(null);
    try {
      const res = await fetch("/api/widget/settings", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ siteId: site.id, action }) });
      if (!res.ok) throw new Error(await readError(res, "Could not update the site"));
      setData((d) => (d ? { ...d, sites: d.sites.map((s) => (s.id === site.id ? { ...s, installed: action === "install" } : s)) } : d));
      setNotice({ tone: "success", text: action === "install" ? "Script added to your site builder page. Republish the site to go live." : "Script removed from your site builder page." });
    } catch (err) {
      setNotice({ tone: "error", text: err instanceof Error ? err.message : "Could not update the site" });
    } finally {
      setInstalling(false);
    }
  }

  const enabledCount = config ? WIDGET_MODES.filter((m) => config.modes[m]).length : 0;

  return (
    <PageContainer
      wide
      title="Website widgets"
      description="Put the AI receptionist, a contact form, booking and help on any website with one script tag."
      icon={<MessageSquareCode className="h-5 w-5" aria-hidden />}
      actions={
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="outline" size="sm" touch onClick={() => void load()} aria-label="Reload">
            <RefreshCw className="h-4 w-4" aria-hidden />
          </Button>
          <Button type="button" size="sm" touch onClick={save} disabled={!site || saving}>
            {saving ? <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden /> : <Check className="h-4 w-4" aria-hidden />}
            <span className="ml-1.5">Save</span>
          </Button>
        </div>
      }
    >
      {notice && <Banner tone={notice.tone}>{notice.text}</Banner>}

      {loadError ? (
        <ErrorState message={loadError} onRetry={() => void load()} />
      ) : !data ? (
        <Loading label="Loading widget settings…" />
      ) : data.sites.length === 0 ? (
        <Empty title="No sites yet" text="Create a site in the builder first — each widget is tied to a site so its leads and chats land in the right place." />
      ) : !config || !site ? (
        <Loading />
      ) : (
        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,420px)]">
          <div className="space-y-6">
            <section className="rounded-xl border border-border bg-card p-4 sm:p-5">
              <div className="flex flex-wrap items-end gap-3">
                <Field label="Site" className="min-w-[220px] flex-1">
                  <Select value={siteId} onChange={(e) => setSiteId(e.target.value)}>
                    {data.sites.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.title}
                      </option>
                    ))}
                  </Select>
                </Field>
                <div className="flex items-center gap-2 pb-2">
                  <Pill tone={config.enabled ? "success" : "neutral"}>{config.enabled ? "Enabled" : "Disabled"}</Pill>
                  <Pill tone={site.installed ? "info" : "neutral"}>{site.installed ? "Installed on builder site" : "Not installed"}</Pill>
                </div>
              </div>
              <Checkbox className="mt-3" label="Show the widget on this site" checked={config.enabled} onChange={(e) => patch("enabled", e.target.checked)} />
            </section>

            <section className="rounded-xl border border-border bg-card p-4 sm:p-5">
              <h2 className="text-sm font-semibold">Modes</h2>
              <p className="mt-1 text-xs text-muted-foreground">Pick what visitors can do. Several modes show as tabs inside the panel.</p>
              <div className="mt-3 grid gap-3 sm:grid-cols-2">
                {WIDGET_MODES.map((m) => (
                  <label key={m} className={cn("flex cursor-pointer gap-3 rounded-lg border p-3 text-sm", config.modes[m] ? "border-primary/50 bg-primary/5" : "border-border")}>
                    <input type="checkbox" className="mt-0.5 h-4 w-4 shrink-0 accent-primary" checked={config.modes[m]} onChange={(e) => toggleMode(m, e.target.checked)} />
                    <span>
                      <span className="font-medium">{MODE_META[m].label}</span>
                      <span className="mt-0.5 block text-xs text-muted-foreground">{MODE_META[m].hint}</span>
                    </span>
                  </label>
                ))}
              </div>
              {enabledCount === 0 && <p className="mt-2 text-xs text-destructive">Enable at least one mode or the widget will not render.</p>}
              <Field label="Open on" className="mt-4 max-w-xs" hint="Which tab is selected when the panel opens.">
                <Select value={config.defaultMode} onChange={(e) => patch("defaultMode", e.target.value as WidgetMode)}>
                  {WIDGET_MODES.filter((m) => config.modes[m]).map((m) => (
                    <option key={m} value={m}>
                      {MODE_META[m].label}
                    </option>
                  ))}
                </Select>
              </Field>
            </section>

            <section className="rounded-xl border border-border bg-card p-4 sm:p-5">
              <h2 className="text-sm font-semibold">Appearance</h2>
              <div className="mt-3 grid gap-4 sm:grid-cols-2">
                <Field label="Greeting" hint={`${config.greeting.length}/${MAX_GREETING}`} className="sm:col-span-2">
                  <Input value={config.greeting} maxLength={MAX_GREETING} onChange={(e) => patch("greeting", e.target.value)} />
                </Field>
                <Field label="Colour" hint="Defaults to your brand colour.">
                  <div className="flex items-center gap-2">
                    <input
                      type="color"
                      aria-label="Widget colour"
                      value={effectiveColor}
                      onChange={(e) => patch("color", e.target.value)}
                      className="h-11 w-14 cursor-pointer rounded-md border border-border bg-transparent p-1"
                    />
                    <Input value={effectiveColor} readOnly aria-label="Colour hex value" className="font-mono" />
                    {config.color && (
                      <Button type="button" variant="ghost" size="sm" onClick={() => patch("color", null)}>
                        Reset
                      </Button>
                    )}
                  </div>
                </Field>
                <Field label="Position">
                  <Select value={config.position} onChange={(e) => patch("position", e.target.value as WidgetConfig["position"])}>
                    {WIDGET_POSITIONS.map((p) => (
                      <option key={p} value={p}>
                        {p === "bottom-right" ? "Bottom right" : "Bottom left"}
                      </option>
                    ))}
                  </Select>
                </Field>
              </div>
            </section>

            <section className="rounded-xl border border-border bg-card p-4 sm:p-5">
              <h2 className="text-sm font-semibold">Consent</h2>
              <p className="mt-1 text-xs text-muted-foreground">Shown on the contact, booking and “leave your details” forms. Answers are recorded in the consent ledger.</p>
              <div className="mt-3 grid gap-4">
                <Field label="Consent checkbox" className="max-w-xs">
                  <Select value={config.consentMode} onChange={(e) => patch("consentMode", e.target.value as WidgetConfig["consentMode"])}>
                    {CONSENT_MODES.map((c) => (
                      <option key={c} value={c}>
                        {c === "required" ? "Required to submit" : c === "optional" ? "Optional" : "Hidden"}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="Consent text" hint={`${consentText.length}/${MAX_CONSENT_TEXT} · leave blank to use the default: “${DEFAULT_CONSENT_TEXT}”`}>
                  <Textarea rows={2} maxLength={MAX_CONSENT_TEXT} value={consentText} onChange={(e) => setConsentText(e.target.value)} placeholder={DEFAULT_CONSENT_TEXT} />
                </Field>
              </div>
            </section>

            <section className="rounded-xl border border-border bg-card p-4 sm:p-5">
              <h2 className="text-sm font-semibold">Allowed origins</h2>
              <Field
                label="Websites that may embed this widget"
                hint="One per line, e.g. https://www.example.com. Leave empty to allow any site (the widget is public by design)."
                className="mt-3"
              >
                <Textarea rows={3} value={origins} onChange={(e) => setOrigins(e.target.value)} placeholder={"https://www.example.com\nhttps://example.com"} className="font-mono text-xs" />
              </Field>
            </section>
          </div>

          <aside className="space-y-6 lg:sticky lg:top-4 lg:self-start">
            <section className="rounded-xl border border-border bg-card p-4 sm:p-5">
              <div className="flex items-center justify-between gap-2">
                <h2 className="text-sm font-semibold">Install</h2>
                <a href={previewUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-xs text-primary underline-offset-2 hover:underline">
                  Open demo page <ExternalLink className="h-3 w-3" aria-hidden />
                </a>
              </div>
              <p className="mt-1 text-xs text-muted-foreground">Paste before <code>&lt;/body&gt;</code> on any site. Save first so the snippet reflects your settings.</p>
              <pre className="mt-3 overflow-x-auto rounded-lg bg-secondary p-3 text-[11px] leading-relaxed [overflow-wrap:anywhere] whitespace-pre-wrap">
                <code>{snippet}</code>
              </pre>
              <div className="mt-3 flex flex-wrap gap-2">
                <CopyButton text={snippet} />
                {site.installed ? (
                  <Button type="button" size="sm" variant="outline" touch onClick={() => install("uninstall")} disabled={installing}>
                    {installing ? <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" aria-hidden /> : <Trash2 className="h-3.5 w-3.5" aria-hidden />}
                    <span className="ml-1.5">Remove from builder site</span>
                  </Button>
                ) : (
                  <Button type="button" size="sm" touch onClick={() => install("install")} disabled={installing}>
                    {installing ? <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" aria-hidden /> : <Download className="h-3.5 w-3.5" aria-hidden />}
                    <span className="ml-1.5">Install on your KernelHub site</span>
                  </Button>
                )}
              </div>
            </section>

            <section className="rounded-xl border border-border bg-card p-4 sm:p-5">
              <div className="flex items-center justify-between gap-2">
                <h2 className="text-sm font-semibold">Live preview</h2>
                <Button type="button" variant="ghost" size="sm" onClick={() => setPreviewKey((k) => k + 1)} aria-label="Refresh preview">
                  <RefreshCw className="h-3.5 w-3.5" aria-hidden />
                </Button>
              </div>
              <p className="mt-1 text-xs text-muted-foreground">Unsaved colour, position, greeting and consent changes are previewed live; mode toggles apply after saving.</p>
              <div className="mt-3 overflow-hidden rounded-lg border border-border bg-background">
                <iframe key={previewUrl} src={previewUrl} title="Widget preview" className="h-[520px] w-full" sandbox="allow-scripts allow-same-origin allow-forms allow-popups" />
              </div>
            </section>
          </aside>
        </div>
      )}
    </PageContainer>
  );
}
