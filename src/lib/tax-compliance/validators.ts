/**
 * Tax-id validators (pure, client-safe). Structure/checksum checks only: a
 * passing result means the id is well-formed, NOT that it is registered.
 */

export interface ValidationResult {
  valid: boolean;
  reason: string | null;
  /** Normalised form (uppercase, no spaces) when parsable. */
  normalized?: string;
}

const ok = (normalized: string): ValidationResult => ({ valid: true, reason: null, normalized });
const bad = (reason: string, normalized?: string): ValidationResult => ({ valid: false, reason, normalized });

const clean = (s: string) => s.replace(/[\s.\-]/g, "").toUpperCase();

/* ---------- India ---------- */

/** GST state / UT codes (first two digits of a GSTIN). Source: GST portal state code list. */
export const IN_STATE_CODES: Readonly<Record<string, string>> = {
  "01": "Jammu and Kashmir", "02": "Himachal Pradesh", "03": "Punjab", "04": "Chandigarh", "05": "Uttarakhand",
  "06": "Haryana", "07": "Delhi", "08": "Rajasthan", "09": "Uttar Pradesh", "10": "Bihar", "11": "Sikkim",
  "12": "Arunachal Pradesh", "13": "Nagaland", "14": "Manipur", "15": "Mizoram", "16": "Tripura", "17": "Meghalaya",
  "18": "Assam", "19": "West Bengal", "20": "Jharkhand", "21": "Odisha", "22": "Chhattisgarh", "23": "Madhya Pradesh",
  "24": "Gujarat", "26": "Dadra and Nagar Haveli and Daman and Diu", "27": "Maharashtra", "29": "Karnataka", "30": "Goa",
  "31": "Lakshadweep", "32": "Kerala", "33": "Tamil Nadu", "34": "Puducherry", "35": "Andaman and Nicobar Islands",
  "36": "Telangana", "37": "Andhra Pradesh", "38": "Ladakh", "97": "Other Territory", "99": "Centre Jurisdiction",
};

const GSTIN_CHARS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const GSTIN_RE = /^(\d{2})([A-Z]{5}\d{4}[A-Z])([1-9A-Z])Z([0-9A-Z])$/;

/** GSTIN check character: weighted base-36 sum (weights alternate 1,2), per the published algorithm. */
export function gstinCheckChar(first14: string): string {
  let sum = 0;
  for (let i = 0; i < 14; i++) {
    const v = GSTIN_CHARS.indexOf(first14[i]);
    const prod = v * (i % 2 === 0 ? 1 : 2);
    sum += Math.floor(prod / 36) + (prod % 36);
  }
  return GSTIN_CHARS[(36 - (sum % 36)) % 36];
}

export function validateGstin(input: string): ValidationResult {
  const v = clean(input);
  if (v.length !== 15) return bad("GSTIN must be 15 characters", v);
  const m = GSTIN_RE.exec(v);
  if (!m) return bad("GSTIN structure is invalid (expected 2 digits, PAN, entity, Z, check)", v);
  if (!IN_STATE_CODES[m[1]]) return bad(`Unknown GST state code ${m[1]}`, v);
  if (gstinCheckChar(v.slice(0, 14)) !== v[14]) return bad("GSTIN checksum does not match", v);
  return ok(v);
}

const PAN_RE = /^[A-Z]{3}[ABCFGHLJPT][A-Z]\d{4}[A-Z]$/;
export function validatePan(input: string): ValidationResult {
  const v = clean(input);
  return PAN_RE.test(v) ? ok(v) : bad("PAN must look like ABCDE1234F", v);
}

/** State code from a GSTIN, or null. */
export function gstinState(gstin: string | null | undefined): string | null {
  const v = clean(gstin ?? "");
  return /^\d{2}/.test(v) && IN_STATE_CODES[v.slice(0, 2)] ? v.slice(0, 2) : null;
}

/* ---------- EU VAT ---------- */

/** Format regex per member-state prefix (after the 2-letter prefix). Greece uses EL; Northern Ireland XI. */
export const EU_VAT_FORMATS: Readonly<Record<string, RegExp>> = {
  AT: /^U\d{8}$/, BE: /^[01]\d{9}$/, BG: /^\d{9,10}$/, CY: /^\d{8}[A-Z]$/, CZ: /^\d{8,10}$/,
  DE: /^\d{9}$/, DK: /^\d{8}$/, EE: /^\d{9}$/, EL: /^\d{9}$/, ES: /^[A-Z0-9]\d{7}[A-Z0-9]$/,
  FI: /^\d{8}$/, FR: /^[A-Z0-9]{2}\d{9}$/, HR: /^\d{11}$/, HU: /^\d{8}$/, IE: /^(\d{7}[A-Z]{1,2}|\d[A-Z+*]\d{5}[A-Z])$/,
  IT: /^\d{11}$/, LT: /^(\d{9}|\d{12})$/, LU: /^\d{8}$/, LV: /^\d{11}$/, MT: /^\d{8}$/,
  NL: /^\d{9}B\d{2}$/, PL: /^\d{10}$/, PT: /^\d{9}$/, RO: /^\d{2,10}$/, SE: /^\d{12}$/,
  SI: /^\d{8}$/, SK: /^\d{10}$/, XI: /^(\d{9}|\d{12}|GD\d{3}|HA\d{3})$/,
};

export const EU_MEMBER_STATES: readonly string[] = ["AT", "BE", "BG", "CY", "CZ", "DE", "DK", "EE", "EL", "ES", "FI", "FR", "HR", "HU", "IE", "IT", "LT", "LU", "LV", "MT", "NL", "PL", "PT", "RO", "SE", "SI", "SK"];

/** ISO country → VAT prefix (Greece is the only difference). */
export function vatPrefixForCountry(iso: string): string {
  const c = iso.toUpperCase();
  return c === "GR" ? "EL" : c;
}
export function countryForVatPrefix(prefix: string): string {
  const p = prefix.toUpperCase();
  return p === "EL" ? "GR" : p;
}

export function validateEuVat(input: string): ValidationResult {
  const v = clean(input);
  if (v.length < 4) return bad("VAT ID is too short", v);
  const prefix = v.slice(0, 2);
  const re = EU_VAT_FORMATS[prefix];
  if (!re) return bad(`Unsupported or unknown VAT prefix ${prefix}`, v);
  return re.test(v.slice(2)) ? ok(v) : bad(`Format invalid for ${prefix} VAT numbers`, v);
}

/* ---------- UK VAT ---------- */

/** Modulus-97 check for 9-digit GB VAT numbers (old and new "-55" variants). 12-digit branch ids check the first 9. */
export function validateUkVat(input: string): ValidationResult {
  let v = clean(input);
  if (v.startsWith("GB")) v = v.slice(2);
  else return bad("UK VAT numbers start with GB", v);
  if (/^(GD\d{3}|HA\d{3})$/.test(v)) return ok(`GB${v}`);
  if (!/^(\d{9}|\d{12})$/.test(v)) return bad("UK VAT must be GB + 9 or 12 digits", `GB${v}`);
  const d = v.slice(0, 9).split("").map(Number);
  const weights = [8, 7, 6, 5, 4, 3, 2];
  let sum = 0;
  for (let i = 0; i < 7; i++) sum += d[i] * weights[i];
  const check = d[7] * 10 + d[8];
  const total = sum + check;
  if (total % 97 === 0 || (total + 55) % 97 === 0) return ok(`GB${v}`);
  return bad("UK VAT modulus-97 check failed", `GB${v}`);
}

/* ---------- US ---------- */

export const US_STATES: Readonly<Record<string, string>> = {
  AL: "Alabama", AK: "Alaska", AZ: "Arizona", AR: "Arkansas", CA: "California", CO: "Colorado", CT: "Connecticut", DE: "Delaware",
  DC: "District of Columbia", FL: "Florida", GA: "Georgia", HI: "Hawaii", ID: "Idaho", IL: "Illinois", IN: "Indiana", IA: "Iowa",
  KS: "Kansas", KY: "Kentucky", LA: "Louisiana", ME: "Maine", MD: "Maryland", MA: "Massachusetts", MI: "Michigan", MN: "Minnesota",
  MS: "Mississippi", MO: "Missouri", MT: "Montana", NE: "Nebraska", NV: "Nevada", NH: "New Hampshire", NJ: "New Jersey", NM: "New Mexico",
  NY: "New York", NC: "North Carolina", ND: "North Dakota", OH: "Ohio", OK: "Oklahoma", OR: "Oregon", PA: "Pennsylvania", RI: "Rhode Island",
  SC: "South Carolina", SD: "South Dakota", TN: "Tennessee", TX: "Texas", UT: "Utah", VT: "Vermont", VA: "Virginia", WA: "Washington",
  WV: "West Virginia", WI: "Wisconsin", WY: "Wyoming",
};

export function validateUsState(input: string): ValidationResult {
  const v = input.trim().toUpperCase().replace(/^US-/, "");
  return US_STATES[v] ? ok(v) : bad("Unknown US state code", v);
}

/** Dispatch by regime. */
export function validateTaxId(regime: string, id: string): ValidationResult {
  switch (regime) {
    case "india_gst": return validateGstin(id);
    case "eu_vat": return validateEuVat(id);
    case "uk_vat": return validateUkVat(id);
    case "us_sales": return validateUsState(id);
    default: return id.trim() ? ok(id.trim()) : bad("Empty");
  }
}

/* ---------- VIES (optional lookup) ---------- */

export interface ViesResult {
  valid: boolean;
  checked: "simulated" | "live";
  name?: string | null;
  reason?: string | null;
}

/** Fixed, public EC REST endpoint (SSRF-safe: host is a constant, input is encoded path segments). */
const VIES_HOST = "https://ec.europa.eu/taxation_customs/vies/rest-api/ms";

/**
 * VIES lookup. Offline/simulated by default (format check only). Live call only
 * when `VIES_ENABLED=1`; any failure falls back to "unverified" (valid=false, reason).
 */
export async function lookupVies(vatId: string, env: Record<string, string | undefined> = process.env): Promise<ViesResult> {
  const fmt = validateEuVat(vatId);
  if (!fmt.valid || !fmt.normalized) return { valid: false, checked: "simulated", reason: fmt.reason };
  if (env.VIES_ENABLED !== "1") return { valid: true, checked: "simulated", reason: "Format-only check (VIES live lookup disabled)" };
  const prefix = fmt.normalized.slice(0, 2);
  const num = fmt.normalized.slice(2);
  try {
    const res = await fetch(`${VIES_HOST}/${encodeURIComponent(prefix)}/vat/${encodeURIComponent(num)}`, { signal: AbortSignal.timeout(8000), headers: { accept: "application/json" } });
    if (!res.ok) return { valid: false, checked: "live", reason: `VIES returned ${res.status}` };
    const j = (await res.json().catch(() => null)) as { isValid?: boolean; valid?: boolean; name?: string } | null;
    const valid = Boolean(j?.isValid ?? j?.valid);
    return { valid, checked: "live", name: j?.name ?? null, reason: valid ? null : "Not registered in VIES" };
  } catch {
    return { valid: false, checked: "live", reason: "VIES unavailable" };
  }
}
