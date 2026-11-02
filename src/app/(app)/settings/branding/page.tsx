"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Check, Globe2, ImageIcon, Loader2, Palette, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input, Select, Textarea } from "@/components/ui/input";
import { Field } from "@/components/ui/field";
import { Banner, Loading } from "@/components/ui/feedback";
import { PageContainer } from "@/components/page-container";
import { useT } from "@/components/i18n/provider";
import { cn } from "@/lib/utils";
import { readableTextOn } from "@/lib/branding-colors";
import { LOCALE_LABELS, LOCALES, type Locale } from "@/lib/i18n";
import { CURRENCIES, formatMoney } from "@/lib/i18n/format";

/* eslint-disable @next/next/no-img-element -- org-supplied logo URLs */

interface Branding {
  brand_name: string;
  logo_url: string | null;
  primary_color: string;
  accent_color: string;
  email_footer: string | null;
  custom_domain: string | null;
  support_email: string | null;
  favicon_url: string | null;
  updated_at: string | null;
  configured: boolean;
}

interface OrgSettings {
  locale: Locale;
  currency: string;
  timezone: string;
}

type Form = {
  brand_name: string;
  primary_color: string;
  accent_color: string;
  email_footer: string;
  custom_domain: string;
  support_email: string;
};

const HEX = /^#[0-9a-fA-F]{6}$/;
const FILE_INPUT =
  "block w-full rounded-md text-sm text-muted-foreground file:mr-3 file:rounded-md file:border file:border-border file:bg-secondary file:px-3 file:py-2 file:text-xs file:font-medium file:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";
const spinner = <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden />;

function toForm(b: Branding): Form {
  return {
    brand_name: b.brand_name ?? "",
    primary_color: b.primary_color,
    accent_color: b.accent_color,
    email_footer: b.email_footer ?? "",
    custom_domain: b.custom_domain ?? "",
    support_email: b.support_email ?? "",
  };
}

function ColorField({ id, label, value, onChange }: { id: string; label: string; value: string; onChange: (v: string) => void }) {
  const valid = HEX.test(value);
  const errorId = `${id}-error`;
  return (
    <div className="min-w-0">
      <label htmlFor={id} className="mb-1 block text-xs font-medium">
        {label}
      </label>
      <div className="flex items-center gap-2">
        <input
          type="color"
          aria-label={`${label} picker`}
          value={valid ? value : "#000000"}
          onChange={(e) => onChange(e.target.value)}
          className="h-11 w-12 shrink-0 cursor-pointer rounded-md border border-border bg-transparent p-0.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:h-9 sm:w-11"
        />
        <Input
          id={id}
          value={value}
          onChange={(e) => onChange(e.target.value.trim())}
          placeholder="#f97316"
          maxLength={7}
          spellCheck={false}
          autoComplete="off"
          aria-invalid={!valid}
          aria-describedby={valid ? undefined : errorId}
          className={cn("font-mono", !valid && "border-red-500/60")}
        />
      </div>
      {!valid && (
        <p id={errorId} role="alert" className="mt-1 text-xs text-destructive">
          Use a 6-digit hex colour like #f97316.
        </p>
      )}
    </div>
  );
}

export default function BrandingSettingsPage() {
  const t = useT();
  const [branding, setBranding] = useState<Branding | null>(null);
  const [form, setForm] = useState<Form | null>(null);
  const [emailPreview, setEmailPreview] = useState<string>("");
  const [canEdit, setCanEdit] = useState(true);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const logoRef = useRef<HTMLInputElement>(null);
  const faviconRef = useRef<HTMLInputElement>(null);
  const [logoPreview, setLogoPreview] = useState<string | null>(null);
  const [faviconPicked, setFaviconPicked] = useState(false);

  // Org preferences (locale / currency / timezone)
  const [settings, setSettings] = useState<OrgSettings | null>(null);
  const [settingsSaving, setSettingsSaving] = useState(false);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const [settingsSaved, setSettingsSaved] = useState(false);

  const timezones = useMemo<string[]>(() => {
    try {
      return Intl.supportedValuesOf("timeZone");
    } catch {
      return ["UTC"];
    }
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [bRes, sRes] = await Promise.all([fetch("/api/orgs/branding", { cache: "no-store" }), fetch("/api/orgs/settings", { cache: "no-store" })]);
      const b = (await bRes.json().catch(() => null)) as { branding?: Branding; emailPreview?: string; canEdit?: boolean; error?: string } | null;
      if (!bRes.ok || !b?.branding) throw new Error(b?.error ?? t("common.errorLoad", { thing: t("settings.branding.title").toLowerCase() }));
      setBranding(b.branding);
      setForm(toForm(b.branding));
      setEmailPreview(b.emailPreview ?? "");
      setCanEdit(b.canEdit !== false);
      const s = (await sRes.json().catch(() => null)) as { settings?: OrgSettings } | null;
      if (sRes.ok && s?.settings) setSettings(s.settings);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("common.error"));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  const dirty = useMemo(() => (branding && form ? JSON.stringify(toForm(branding)) !== JSON.stringify(form) : false), [branding, form]);
  const hasChanges = dirty || Boolean(logoPreview) || faviconPicked;

  useEffect(() => {
    if (!hasChanges) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [hasChanges]);

  // Release the object URL when the preview changes or the page unmounts.
  useEffect(() => {
    return () => {
      if (logoPreview) URL.revokeObjectURL(logoPreview);
    };
  }, [logoPreview]);

  function update<K extends keyof Form>(key: K, value: Form[K]) {
    setForm((f) => (f ? { ...f, [key]: value } : f));
    setSaved(false);
  }

  function onLogoPicked(file: File | null) {
    setLogoPreview(file ? URL.createObjectURL(file) : null);
    setSaved(false);
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!form || saving) return;
    if (!HEX.test(form.primary_color) || !HEX.test(form.accent_color)) {
      setError("Colours must be 6-digit hex values like #f97316.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const fd = new FormData();
      fd.set("brand_name", form.brand_name.trim());
      fd.set("primary_color", form.primary_color.toLowerCase());
      fd.set("accent_color", form.accent_color.toLowerCase());
      fd.set("email_footer", form.email_footer.trim());
      fd.set("custom_domain", form.custom_domain.trim().toLowerCase());
      fd.set("support_email", form.support_email.trim());
      const logo = logoRef.current?.files?.[0];
      const favicon = faviconRef.current?.files?.[0];
      if (logo) fd.set("logo", logo);
      if (favicon) fd.set("favicon", favicon);
      const res = await fetch("/api/orgs/branding", { method: "PATCH", body: fd });
      const data = (await res.json().catch(() => null)) as { branding?: Branding; emailPreview?: string; error?: string; issues?: Array<{ path: Array<string | number>; message: string }> } | null;
      if (!res.ok || !data?.branding) {
        const issue = data?.issues?.[0];
        throw new Error(issue ? `${issue.path.join(".")}: ${issue.message}` : (data?.error ?? t("common.errorSave", { thing: t("settings.branding.title").toLowerCase() })));
      }
      setBranding(data.branding);
      setForm(toForm(data.branding));
      setEmailPreview(data.emailPreview ?? emailPreview);
      if (logoRef.current) logoRef.current.value = "";
      if (faviconRef.current) faviconRef.current.value = "";
      onLogoPicked(null);
      setFaviconPicked(false);
      setSaved(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("common.error"));
    } finally {
      setSaving(false);
    }
  }

  async function reset() {
    if (resetting) return;
    if (!window.confirm(t("common.confirmDelete", { thing: t("settings.branding.title").toLowerCase() }))) return;
    setResetting(true);
    setError(null);
    try {
      const res = await fetch("/api/orgs/branding", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reset: true }),
      });
      if (!res.ok) throw new Error(t("common.errorSave", { thing: t("settings.branding.title").toLowerCase() }));
      await load();
      setSaved(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("common.error"));
    } finally {
      setResetting(false);
    }
  }

  async function saveSettings(e: React.FormEvent) {
    e.preventDefault();
    if (!settings || settingsSaving) return;
    setSettingsSaving(true);
    setSettingsError(null);
    setSettingsSaved(false);
    try {
      const res = await fetch("/api/orgs/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(settings),
      });
      const data = (await res.json().catch(() => null)) as { settings?: OrgSettings; error?: string } | null;
      if (!res.ok || !data?.settings) throw new Error(data?.error ?? t("common.errorSave", { thing: t("settings.title").toLowerCase() }));
      setSettings(data.settings);
      setSettingsSaved(true);
      // Locale lives in the server-rendered provider; refresh so the UI re-renders in the new language.
      window.location.reload();
    } catch (err) {
      setSettingsError(err instanceof Error ? err.message : t("common.error"));
    } finally {
      setSettingsSaving(false);
    }
  }

  const previewPrimary = form && HEX.test(form.primary_color) ? form.primary_color : "#f97316";
  const previewAccent = form && HEX.test(form.accent_color) ? form.accent_color : "#f59e0b";
  const previewName = form?.brand_name.trim() || "Your brand";
  const previewLogo = logoPreview ?? branding?.logo_url ?? null;

  return (
    <PageContainer
      wide
      title={t("settings.branding.title")}
      description={t("settings.branding.description")}
      tooltip="Branding applies to quote, invoice, payment, booking and help pages plus outbound email. The app itself keeps its own look."
    >
      {error && (
        <Banner tone="error" onDismiss={() => setError(null)}>
          {error}
        </Banner>
      )}

      {loading || !form ? (
        <Loading label={t("common.loading")} />
      ) : (
        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,22rem)]">
          <form onSubmit={save} className="min-w-0 space-y-5 rounded-xl border border-border bg-card p-4 sm:p-6" aria-describedby={!canEdit ? "branding-readonly" : undefined}>
            {!canEdit && (
              <p id="branding-readonly" className="rounded-md bg-secondary px-3 py-2 text-xs text-muted-foreground">
                {t("auth.forbidden")}
              </p>
            )}
            <fieldset disabled={!canEdit || saving} className="space-y-5">
              <Field label={t("settings.branding.brandName")} required>
                <Input value={form.brand_name} onChange={(e) => update("brand_name", e.target.value)} maxLength={80} required autoComplete="organization" />
              </Field>

              <div className="grid gap-4 sm:grid-cols-2">
                <Field label={t("settings.branding.logo")} hint="PNG, SVG, JPEG or WebP, up to 2 MB">
                  <input ref={logoRef} type="file" accept="image/png,image/jpeg,image/webp,image/svg+xml" onChange={(e) => onLogoPicked(e.target.files?.[0] ?? null)} className={FILE_INPUT} />
                </Field>
                <Field label={t("settings.branding.favicon")} hint="ICO, PNG or SVG, 32×32 works best">
                  <input
                    ref={faviconRef}
                    type="file"
                    accept="image/png,image/svg+xml,image/x-icon,image/vnd.microsoft.icon"
                    onChange={(e) => {
                      setFaviconPicked(Boolean(e.target.files?.length));
                      setSaved(false);
                    }}
                    className={FILE_INPUT}
                  />
                </Field>
              </div>

              <div className="grid gap-4 sm:grid-cols-2">
                <ColorField id="primary_color" label={t("settings.branding.primaryColor")} value={form.primary_color} onChange={(v) => update("primary_color", v)} />
                <ColorField id="accent_color" label={t("settings.branding.accentColor")} value={form.accent_color} onChange={(v) => update("accent_color", v)} />
              </div>

              <div className="grid gap-4 sm:grid-cols-2">
                <Field label={t("settings.branding.supportEmail")} hint={t("common.optional")}>
                  <Input type="email" value={form.support_email} onChange={(e) => update("support_email", e.target.value)} placeholder="help@yourbrand.com" spellCheck={false} autoComplete="off" />
                </Field>
                <Field label={t("settings.branding.customDomain")} hint="Point a CNAME at this app, then enter the hostname.">
                  <Input value={form.custom_domain} onChange={(e) => update("custom_domain", e.target.value)} placeholder="portal.yourbrand.com" spellCheck={false} autoComplete="off" inputMode="url" />
                </Field>
              </div>

              <Field label={t("settings.branding.emailFooter")} hint={t("common.optional")}>
                <Textarea rows={3} value={form.email_footer} onChange={(e) => update("email_footer", e.target.value)} maxLength={1000} placeholder="Your Brand Ltd · 12 Market St · Unsubscribe at any time." />
              </Field>
            </fieldset>

            <div className="flex flex-wrap items-center gap-2 border-t border-border pt-4">
              <Button type="submit" touch disabled={!canEdit || saving || !hasChanges}>
                {saving ? spinner : <Check className="h-4 w-4" aria-hidden />}
                {saving ? t("common.saving") : t("common.save")}
              </Button>
              <Button type="button" variant="outline" touch disabled={!canEdit || resetting || !branding?.configured} onClick={reset}>
                {resetting ? spinner : <RotateCcw className="h-4 w-4" aria-hidden />}
                {t("settings.branding.reset")}
              </Button>
              <span role="status" aria-live="polite" className="text-xs text-muted-foreground">
                {saved ? t("common.saved") : hasChanges ? t("common.unsavedChanges") : ""}
              </span>
            </div>
          </form>

          <aside className="min-w-0 space-y-4" aria-labelledby="preview-heading">
            <h2 id="preview-heading" className="flex items-center gap-2 text-sm font-semibold">
              <Palette className="h-4 w-4 text-primary" aria-hidden /> {t("settings.branding.livePreview")}
            </h2>

            {/* Public page preview */}
            <div className="overflow-hidden rounded-xl border border-border bg-background shadow-sm">
              <div className="flex items-center gap-3 border-b border-border bg-card px-4 py-3">
                {previewLogo ? (
                  <img src={previewLogo} alt="" width={120} height={28} className="h-7 w-auto max-w-[120px] object-contain" />
                ) : (
                  <span aria-hidden className="flex h-7 w-7 items-center justify-center rounded-lg text-xs font-bold" style={{ background: previewPrimary, color: readableTextOn(previewPrimary) }}>
                    {previewName.slice(0, 1).toUpperCase()}
                  </span>
                )}
                <span className="truncate text-sm font-semibold">{previewName}</span>
              </div>
              <div className="space-y-3 p-4">
                <div className="space-y-1">
                  <p className="text-xs uppercase tracking-wider text-muted-foreground">{t("billing.quoteNumber", { number: "Q-000012" })}</p>
                  <p className="text-lg font-semibold">{formatMoney(125_000, settings?.currency ?? "USD", undefined)}</p>
                </div>
                <div className="flex flex-wrap gap-2" aria-hidden>
                  <span className="inline-flex h-9 items-center rounded-md px-4 text-sm font-medium" style={{ background: previewPrimary, color: readableTextOn(previewPrimary) }}>
                    {t("billing.status.accepted")}
                  </span>
                  <span className="inline-flex h-9 items-center rounded-md border px-4 text-sm font-medium" style={{ borderColor: previewAccent, color: previewAccent }}>
                    {t("common.preview")}
                  </span>
                </div>
                {form.support_email && <p className="text-xs text-muted-foreground">{form.support_email}</p>}
              </div>
            </div>

            {/* Email preview (server-rendered HTML in a sandboxed frame) */}
            <div className="overflow-hidden rounded-xl border border-border bg-card">
              <div className="flex items-center gap-2 border-b border-border px-3 py-2 text-xs font-medium text-muted-foreground">
                <ImageIcon className="h-3.5 w-3.5" aria-hidden /> Email
              </div>
              {emailPreview ? <iframe title="Branded email preview" sandbox="" srcDoc={emailPreview} className="h-64 w-full bg-card" /> : <p className="px-3 py-6 text-center text-xs text-muted-foreground">{t("common.empty")}</p>}
              <p className="px-3 py-2 text-[11px] text-muted-foreground">Shows saved values only. Save to refresh.</p>
            </div>
          </aside>

          {/* Workspace preferences */}
          <form onSubmit={saveSettings} className="min-w-0 space-y-4 rounded-xl border border-border bg-card p-4 sm:p-6 lg:col-span-2" aria-labelledby="prefs-heading">
            <h2 id="prefs-heading" className="flex items-center gap-2 text-sm font-semibold">
              <Globe2 className="h-4 w-4 text-primary" aria-hidden /> {t("settings.locale")} · {t("settings.currency")} · {t("settings.timezone")}
            </h2>
            {settingsError && (
              <Banner tone="error" onDismiss={() => setSettingsError(null)} className="mb-0">
                {settingsError}
              </Banner>
            )}
            {settings ? (
              <fieldset disabled={!canEdit || settingsSaving} className="grid gap-4 sm:grid-cols-3">
                <Field label={t("settings.locale")}>
                  <Select value={settings.locale} onChange={(e) => setSettings({ ...settings, locale: e.target.value as Locale })}>
                    {LOCALES.map((l) => (
                      <option key={l} value={l}>
                        {LOCALE_LABELS[l]}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label={t("settings.currency")}>
                  <Select value={settings.currency} onChange={(e) => setSettings({ ...settings, currency: e.target.value })}>
                    {CURRENCIES.map((c) => (
                      <option key={c.code} value={c.code}>
                        {c.code} · {c.symbol} · {c.name}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label={t("settings.timezone")}>
                  <Select value={settings.timezone} onChange={(e) => setSettings({ ...settings, timezone: e.target.value })}>
                    {!timezones.includes(settings.timezone) && <option value={settings.timezone}>{settings.timezone}</option>}
                    {timezones.map((tz) => (
                      <option key={tz} value={tz}>
                        {tz}
                      </option>
                    ))}
                  </Select>
                </Field>
              </fieldset>
            ) : (
              <p className="text-sm text-muted-foreground">{t("common.errorLoad", { thing: t("settings.title").toLowerCase() })}</p>
            )}
            <div className="flex flex-wrap items-center gap-3">
              <Button type="submit" touch disabled={!canEdit || settingsSaving || !settings}>
                {settingsSaving ? spinner : <Check className="h-4 w-4" aria-hidden />}
                {settingsSaving ? t("common.saving") : t("common.save")}
              </Button>
              <span role="status" aria-live="polite" className="text-xs text-muted-foreground">
                {settingsSaved ? t("common.saved") : ""}
              </span>
            </div>
          </form>
        </div>
      )}
    </PageContainer>
  );
}
