import { cookies, headers } from "next/headers";
import { getOrgSettings } from "@/lib/org-settings";
import { LOCALE_COOKIE, getMessages, makeT, resolveLocale, type Locale } from "./index";

/**
 * Resolve the UI locale for the current request.
 * Order: org setting (when `dataId` is given) → kh_locale cookie → Accept-Language → en.
 */
export async function getRequestLocale(dataId?: string | null): Promise<Locale> {
  let orgLocale: string | null = null;
  if (dataId) {
    orgLocale = (await getOrgSettings(dataId).catch(() => null))?.locale ?? null;
  }
  let cookieLocale: string | null = null;
  let acceptLanguage: string | null = null;
  try {
    cookieLocale = (await cookies()).get(LOCALE_COOKIE)?.value ?? null;
  } catch {
    cookieLocale = null;
  }
  try {
    acceptLanguage = (await headers()).get("accept-language");
  } catch {
    acceptLanguage = null;
  }
  return resolveLocale({ orgLocale, cookieLocale, acceptLanguage });
}

/** Server-component translator bound to the request locale. */
export async function getServerT(dataId?: string | null) {
  const locale = await getRequestLocale(dataId);
  return { locale, t: makeT(getMessages(locale)), messages: getMessages(locale) };
}
