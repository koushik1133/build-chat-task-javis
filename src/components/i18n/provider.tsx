"use client";

import { createContext, useCallback, useContext, useMemo } from "react";
import {
  DEFAULT_LOCALE,
  getMessages,
  intlTag,
  t as translate,
  type Locale,
  type MessageKey,
  type Messages,
  type TVars,
} from "@/lib/i18n";
import { formatDate, formatMoney, formatNumber, formatRelative, type DateOptions, type MoneyOptions } from "@/lib/i18n/format";

interface I18nContextValue {
  locale: Locale;
  messages: Messages;
  /** Org default currency (ISO code) for money display when a record has none. */
  currency: string;
  timezone: string | undefined;
}

const I18nContext = createContext<I18nContextValue | null>(null);

export interface I18nProviderProps {
  locale: Locale;
  /** Catalog from `getMessages(locale)` on the server. */
  messages: Messages;
  currency?: string;
  timezone?: string;
  children: React.ReactNode;
}

/**
 * Mount once in the app layout (server component) with messages resolved there:
 *
 *   <I18nProvider locale={locale} messages={getMessages(locale)} currency={settings.currency} timezone={settings.timezone}>
 */
export function I18nProvider({ locale, messages, currency = "USD", timezone, children }: I18nProviderProps) {
  const value = useMemo<I18nContextValue>(() => ({ locale, messages, currency, timezone }), [locale, messages, currency, timezone]);
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

/** Works without a provider too (English), so shared components never crash outside the app shell. */
function useI18nContext(): I18nContextValue {
  const ctx = useContext(I18nContext);
  return ctx ?? { locale: DEFAULT_LOCALE, messages: getMessages(DEFAULT_LOCALE), currency: "USD", timezone: undefined };
}

/** `const t = useT(); t("common.save")` */
export function useT() {
  const { messages } = useI18nContext();
  return useCallback((key: MessageKey, vars?: TVars) => translate(messages, key, vars), [messages]);
}

export function useLocale(): Locale {
  return useI18nContext().locale;
}

/** Locale-bound formatters for client components. */
export function useFormat() {
  const { locale, currency, timezone } = useI18nContext();
  const tag = intlTag(locale);
  return useMemo(
    () => ({
      locale,
      currency,
      timezone,
      money: (minor: number, code?: string | null, opts?: MoneyOptions) => formatMoney(minor, code ?? currency, tag, opts),
      date: (input: string | number | Date | null | undefined, opts?: DateOptions) =>
        formatDate(input, tag, { timeZone: timezone, ...opts }),
      number: (n: number, opts?: Intl.NumberFormatOptions) => formatNumber(n, tag, opts),
      relative: (input: string | number | Date | null | undefined) => formatRelative(input, tag),
    }),
    [locale, currency, timezone, tag]
  );
}
