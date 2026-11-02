/**
 * i18n core — client-safe (no server imports).
 *
 * - `LOCALES` / `Locale`: supported UI languages.
 * - `getMessages(locale)`: the full catalog for a locale (falls back to en per key).
 * - `t(messages, key, vars)`: interpolate `{name}` placeholders.
 * - `resolveLocale(...)`: detection order org setting → cookie → Accept-Language → en.
 *
 * Server helpers that read cookies/headers/DB live in `./server`.
 */
import { en, type MessageKey, type Messages } from "./locales/en";
import { es } from "./locales/es";
import { hi } from "./locales/hi";

export type { MessageKey, Messages };

export const LOCALES = ["en", "es", "hi"] as const;
export type Locale = (typeof LOCALES)[number];
export const DEFAULT_LOCALE: Locale = "en";

export const LOCALE_LABELS: Record<Locale, string> = {
  en: "English",
  es: "Español",
  hi: "हिन्दी",
};

/** Cookie that stores the signed-in user's own language preference. */
export const LOCALE_COOKIE = "kh_locale";

const CATALOGS: Record<Locale, Messages> = { en, es, hi };

export function isLocale(v: unknown): v is Locale {
  return typeof v === "string" && (LOCALES as readonly string[]).includes(v);
}

/** Coerce any BCP-47 tag ("es-MX", "hi-IN", "EN") to a supported locale, or null. */
export function toLocale(tag: string | null | undefined): Locale | null {
  if (!tag) return null;
  const base = tag.trim().toLowerCase().split(/[-_]/)[0];
  return isLocale(base) ? base : null;
}

/** Full catalog for a locale. Missing keys fall back to English. */
export function getMessages(locale: Locale): Messages {
  if (locale === "en") return en;
  return { ...en, ...CATALOGS[locale] };
}

export type TVars = Record<string, string | number>;

/** Interpolate `{name}` placeholders. Unknown placeholders are left as-is. */
export function interpolate(template: string, vars?: TVars): string {
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (m, name: string) => (name in vars ? String(vars[name]) : m));
}

/** Translate `key` using `messages`; unknown keys echo the key so gaps are visible. */
export function t(messages: Messages, key: MessageKey, vars?: TVars): string {
  const raw = messages[key] ?? en[key] ?? key;
  return interpolate(raw, vars);
}

/** Bind a catalog once: `const t = makeT(getMessages("es")); t("common.save")`. */
export function makeT(messages: Messages) {
  return (key: MessageKey, vars?: TVars) => t(messages, key, vars);
}

/** Parse an Accept-Language header into the best supported locale (q-weighted). */
export function localeFromAcceptLanguage(header: string | null | undefined): Locale | null {
  if (!header) return null;
  const ranked = header
    .split(",")
    .map((part, i) => {
      const [tag, ...params] = part.trim().split(";");
      const q = params.map((p) => p.trim()).find((p) => p.startsWith("q="));
      const weight = q ? Number(q.slice(2)) : 1;
      return { tag, weight: Number.isFinite(weight) ? weight : 0, i };
    })
    .filter((r) => r.tag && r.weight > 0)
    .sort((a, b) => b.weight - a.weight || a.i - b.i);
  for (const r of ranked) {
    const l = toLocale(r.tag);
    if (l) return l;
  }
  return null;
}

export interface ResolveLocaleInput {
  /** organizations.settings.locale */
  orgLocale?: string | null;
  /** kh_locale cookie value */
  cookieLocale?: string | null;
  /** Accept-Language header */
  acceptLanguage?: string | null;
}

/** Detection order: org setting → cookie → Accept-Language → en. */
export function resolveLocale(input: ResolveLocaleInput): Locale {
  return (
    toLocale(input.orgLocale) ??
    toLocale(input.cookieLocale) ??
    localeFromAcceptLanguage(input.acceptLanguage) ??
    DEFAULT_LOCALE
  );
}

/** Intl tag to use for formatting under a UI locale (region-aware defaults). */
export function intlTag(locale: Locale | string): string {
  switch (locale) {
    case "hi":
      return "hi-IN";
    case "es":
      return "es-ES";
    case "en":
      return "en-US";
    default:
      return locale;
  }
}
