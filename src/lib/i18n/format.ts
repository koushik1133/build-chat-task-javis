/**
 * Locale-aware formatting via Intl. Client-safe.
 *
 * Money is always handled in integer minor units (paise, cents, fils…).
 * `CURRENCIES` carries the minor-digit count so JPY (0) and KWD (3) divide
 * correctly instead of assuming 100.
 */

export interface CurrencyInfo {
  code: string;
  symbol: string;
  name: string;
  /** Number of minor-unit digits (ISO 4217 exponent). */
  minorDigits: number;
}

export const CURRENCIES: readonly CurrencyInfo[] = [
  { code: "USD", symbol: "$", name: "US Dollar", minorDigits: 2 },
  { code: "EUR", symbol: "€", name: "Euro", minorDigits: 2 },
  { code: "GBP", symbol: "£", name: "British Pound", minorDigits: 2 },
  { code: "INR", symbol: "₹", name: "Indian Rupee", minorDigits: 2 },
  { code: "JPY", symbol: "¥", name: "Japanese Yen", minorDigits: 0 },
  { code: "CNY", symbol: "¥", name: "Chinese Yuan", minorDigits: 2 },
  { code: "AUD", symbol: "A$", name: "Australian Dollar", minorDigits: 2 },
  { code: "CAD", symbol: "C$", name: "Canadian Dollar", minorDigits: 2 },
  { code: "SGD", symbol: "S$", name: "Singapore Dollar", minorDigits: 2 },
  { code: "AED", symbol: "د.إ", name: "UAE Dirham", minorDigits: 2 },
  { code: "SAR", symbol: "﷼", name: "Saudi Riyal", minorDigits: 2 },
  { code: "KWD", symbol: "د.ك", name: "Kuwaiti Dinar", minorDigits: 3 },
  { code: "BHD", symbol: ".د.ب", name: "Bahraini Dinar", minorDigits: 3 },
  { code: "CHF", symbol: "CHF", name: "Swiss Franc", minorDigits: 2 },
  { code: "SEK", symbol: "kr", name: "Swedish Krona", minorDigits: 2 },
  { code: "NOK", symbol: "kr", name: "Norwegian Krone", minorDigits: 2 },
  { code: "DKK", symbol: "kr", name: "Danish Krone", minorDigits: 2 },
  { code: "PLN", symbol: "zł", name: "Polish Złoty", minorDigits: 2 },
  { code: "BRL", symbol: "R$", name: "Brazilian Real", minorDigits: 2 },
  { code: "MXN", symbol: "MX$", name: "Mexican Peso", minorDigits: 2 },
  { code: "ZAR", symbol: "R", name: "South African Rand", minorDigits: 2 },
  { code: "NGN", symbol: "₦", name: "Nigerian Naira", minorDigits: 2 },
  { code: "KES", symbol: "KSh", name: "Kenyan Shilling", minorDigits: 2 },
  { code: "KRW", symbol: "₩", name: "South Korean Won", minorDigits: 0 },
  { code: "VND", symbol: "₫", name: "Vietnamese Dong", minorDigits: 0 },
  { code: "IDR", symbol: "Rp", name: "Indonesian Rupiah", minorDigits: 2 },
  { code: "PHP", symbol: "₱", name: "Philippine Peso", minorDigits: 2 },
  { code: "THB", symbol: "฿", name: "Thai Baht", minorDigits: 2 },
  { code: "MYR", symbol: "RM", name: "Malaysian Ringgit", minorDigits: 2 },
  { code: "PKR", symbol: "₨", name: "Pakistani Rupee", minorDigits: 2 },
  { code: "BDT", symbol: "৳", name: "Bangladeshi Taka", minorDigits: 2 },
  { code: "LKR", symbol: "Rs", name: "Sri Lankan Rupee", minorDigits: 2 },
  { code: "NZD", symbol: "NZ$", name: "New Zealand Dollar", minorDigits: 2 },
  { code: "TRY", symbol: "₺", name: "Turkish Lira", minorDigits: 2 },
  { code: "ILS", symbol: "₪", name: "Israeli Shekel", minorDigits: 2 },
  { code: "EGP", symbol: "E£", name: "Egyptian Pound", minorDigits: 2 },
  { code: "HKD", symbol: "HK$", name: "Hong Kong Dollar", minorDigits: 2 },
  { code: "CZK", symbol: "Kč", name: "Czech Koruna", minorDigits: 2 },
  { code: "HUF", symbol: "Ft", name: "Hungarian Forint", minorDigits: 2 },
  { code: "CLP", symbol: "CLP$", name: "Chilean Peso", minorDigits: 0 },
  { code: "COP", symbol: "COL$", name: "Colombian Peso", minorDigits: 2 },
  { code: "ARS", symbol: "AR$", name: "Argentine Peso", minorDigits: 2 },
  { code: "OMR", symbol: "﷼", name: "Omani Rial", minorDigits: 3 },
  { code: "JOD", symbol: "د.ا", name: "Jordanian Dinar", minorDigits: 3 },
  { code: "QAR", symbol: "﷼", name: "Qatari Riyal", minorDigits: 2 },
];

const BY_CODE = new Map(CURRENCIES.map((c) => [c.code, c]));

export const DEFAULT_CURRENCY = "USD";

export function getCurrency(code: string | null | undefined): CurrencyInfo | null {
  return code ? (BY_CODE.get(code.toUpperCase()) ?? null) : null;
}

export function isCurrencyCode(v: unknown): v is string {
  return typeof v === "string" && BY_CODE.has(v.toUpperCase());
}

/** Minor-unit digits for a code; unknown codes ask Intl, then default to 2. */
export function minorDigitsFor(currency: string): number {
  const known = getCurrency(currency);
  if (known) return known.minorDigits;
  try {
    const d = new Intl.NumberFormat("en", { style: "currency", currency }).resolvedOptions().maximumFractionDigits;
    return typeof d === "number" ? d : 2;
  } catch {
    return 2;
  }
}

/** Convert integer minor units to a major-unit number (12345 INR → 123.45). */
export function minorToMajor(minor: number, currency: string): number {
  return (Number(minor) || 0) / 10 ** minorDigitsFor(currency);
}

/** Convert a major-unit number to integer minor units, rounding half-up. */
export function majorToMinor(major: number, currency: string): number {
  return Math.round((Number(major) || 0) * 10 ** minorDigitsFor(currency));
}

export interface MoneyOptions {
  /** "symbol" (default), "code" or "name" — mirrors Intl currencyDisplay. */
  display?: "symbol" | "narrowSymbol" | "code" | "name";
  /** Drop ".00" when the amount is whole (default false). */
  compactWhole?: boolean;
}

/**
 * Format integer minor units as a currency string for a locale.
 *
 *   formatMoney(10_000_000, "INR", "en-IN") → "₹1,00,000.00"
 *   formatMoney(1_000, "JPY", "ja-JP")      → "￥1,000"
 *   formatMoney(1_234, "KWD", "en")         → "KWD 1.234"
 */
export function formatMoney(minor: number, currency: string, locale = "en-US", opts: MoneyOptions = {}): string {
  const code = (currency || DEFAULT_CURRENCY).toUpperCase();
  const digits = minorDigitsFor(code);
  const major = (Number(minor) || 0) / 10 ** digits;
  const whole = opts.compactWhole && Number.isInteger(major);
  try {
    return new Intl.NumberFormat(locale, {
      style: "currency",
      currency: code,
      currencyDisplay: opts.display ?? "symbol",
      minimumFractionDigits: whole ? 0 : digits,
      maximumFractionDigits: digits,
    }).format(major);
  } catch {
    return `${major.toFixed(digits)} ${code}`;
  }
}

export type DateStyle = "short" | "medium" | "long" | "full";

export interface DateOptions {
  dateStyle?: DateStyle;
  /** Include a time component (default: none). */
  timeStyle?: DateStyle;
  timeZone?: string;
}

function toDate(input: string | number | Date | null | undefined): Date | null {
  if (input == null || input === "") return null;
  const d = input instanceof Date ? input : new Date(input);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Locale + timezone aware date (and optional time). Returns "—" for invalid input. */
export function formatDate(
  input: string | number | Date | null | undefined,
  locale = "en-US",
  opts: DateOptions = {}
): string {
  const d = toDate(input);
  if (!d) return "—";
  try {
    return new Intl.DateTimeFormat(locale, {
      dateStyle: opts.dateStyle ?? "medium",
      ...(opts.timeStyle ? { timeStyle: opts.timeStyle } : {}),
      ...(opts.timeZone ? { timeZone: opts.timeZone } : {}),
    }).format(d);
  } catch {
    return d.toISOString().slice(0, 10);
  }
}

/** Plain number with locale grouping (en-IN gives lakh/crore grouping). */
export function formatNumber(value: number, locale = "en-US", opts: Intl.NumberFormatOptions = {}): string {
  const n = Number(value);
  if (!Number.isFinite(n)) return "—";
  try {
    return new Intl.NumberFormat(locale, opts).format(n);
  } catch {
    return String(n);
  }
}

const RELATIVE_UNITS: Array<[Intl.RelativeTimeFormatUnit, number]> = [
  ["year", 365 * 24 * 3600],
  ["month", 30 * 24 * 3600],
  ["week", 7 * 24 * 3600],
  ["day", 24 * 3600],
  ["hour", 3600],
  ["minute", 60],
  ["second", 1],
];

/** "3 days ago" / "in 2 hours" in the given locale. */
export function formatRelative(
  input: string | number | Date | null | undefined,
  locale = "en-US",
  now: Date = new Date()
): string {
  const d = toDate(input);
  if (!d) return "—";
  const diffSec = Math.round((d.getTime() - now.getTime()) / 1000);
  if (Math.abs(diffSec) < 45) {
    try {
      return new Intl.RelativeTimeFormat(locale, { numeric: "auto" }).format(0, "second");
    } catch {
      return "now";
    }
  }
  for (const [unit, size] of RELATIVE_UNITS) {
    if (Math.abs(diffSec) >= size || unit === "second") {
      const value = Math.round(diffSec / size);
      try {
        return new Intl.RelativeTimeFormat(locale, { numeric: "auto" }).format(value, unit);
      } catch {
        return `${value} ${unit}`;
      }
    }
  }
  return "—";
}

/** True when the string is an IANA timezone Intl can format with. */
export function isValidTimeZone(tz: unknown): tz is string {
  if (typeof tz !== "string" || !tz) return false;
  try {
    new Intl.DateTimeFormat("en", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}
