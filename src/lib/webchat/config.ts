/**
 * Pure, client-safe widget configuration helpers (no DB imports).
 *
 * `sites.widget_config` stores a JSON `WidgetConfig`; `GET /api/widget/config/[siteId]`
 * merges it with branding + org data into a `PublicWidgetConfig` the embed script consumes.
 */

export const WIDGET_MODES = ["chat", "lead", "booking", "help"] as const;
export type WidgetMode = (typeof WIDGET_MODES)[number];
export const WIDGET_POSITIONS = ["bottom-right", "bottom-left"] as const;
export type WidgetPosition = (typeof WIDGET_POSITIONS)[number];
export const CONSENT_MODES = ["required", "optional", "off"] as const;
export type ConsentMode = (typeof CONSENT_MODES)[number];

export interface WidgetConfig {
  enabled: boolean;
  modes: Record<WidgetMode, boolean>;
  defaultMode: WidgetMode;
  greeting: string;
  /** Hex colour or null → branding primary. */
  color: string | null;
  position: WidgetPosition;
  consentMode: ConsentMode;
}

export const DEFAULT_WIDGET_CONFIG: WidgetConfig = {
  enabled: true,
  modes: { chat: true, lead: true, booking: false, help: false },
  defaultMode: "chat",
  greeting: "Hi there! How can we help today?",
  color: null,
  position: "bottom-right",
  consentMode: "optional",
};

export const DEFAULT_CONSENT_TEXT = "I agree to be contacted about my enquiry and to receive occasional updates.";
export const MAX_GREETING = 200;
export const MAX_CONSENT_TEXT = 500;
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const MAX_VISITOR_MESSAGE = 2000;

const HEX = /^#[0-9a-fA-F]{6}$/;
export function isHex(v: unknown): v is string {
  return typeof v === "string" && HEX.test(v);
}

function isMode(v: unknown): v is WidgetMode {
  return typeof v === "string" && (WIDGET_MODES as readonly string[]).includes(v);
}

/** Parse the stored JSON (or an API body) into a full config, tolerating junk. */
export function parseWidgetConfig(raw: unknown): WidgetConfig {
  let obj: Record<string, unknown> | null = null;
  if (typeof raw === "string") {
    try {
      const v: unknown = JSON.parse(raw);
      obj = v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
    } catch {
      obj = null;
    }
  } else if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    obj = raw as Record<string, unknown>;
  }
  if (!obj) return { ...DEFAULT_WIDGET_CONFIG, modes: { ...DEFAULT_WIDGET_CONFIG.modes } };

  const modesIn = obj.modes && typeof obj.modes === "object" ? (obj.modes as Record<string, unknown>) : {};
  const modes = { ...DEFAULT_WIDGET_CONFIG.modes };
  for (const m of WIDGET_MODES) if (typeof modesIn[m] === "boolean") modes[m] = modesIn[m] as boolean;

  const greeting = typeof obj.greeting === "string" && obj.greeting.trim() ? obj.greeting.trim().slice(0, MAX_GREETING) : DEFAULT_WIDGET_CONFIG.greeting;
  const position = (WIDGET_POSITIONS as readonly string[]).includes(obj.position as string) ? (obj.position as WidgetPosition) : DEFAULT_WIDGET_CONFIG.position;
  const consentMode = (CONSENT_MODES as readonly string[]).includes(obj.consentMode as string) ? (obj.consentMode as ConsentMode) : DEFAULT_WIDGET_CONFIG.consentMode;
  let defaultMode: WidgetMode = isMode(obj.defaultMode) ? obj.defaultMode : DEFAULT_WIDGET_CONFIG.defaultMode;
  if (!modes[defaultMode]) defaultMode = WIDGET_MODES.find((m) => modes[m]) ?? "chat";

  return {
    enabled: typeof obj.enabled === "boolean" ? obj.enabled : true,
    modes,
    defaultMode,
    greeting,
    color: isHex(obj.color) ? obj.color.toLowerCase() : null,
    position,
    consentMode,
  };
}

export interface PublicBookingType {
  slug: string;
  name: string;
  description: string | null;
  durationMinutes: number;
  priceMinor: number | null;
  currency: string | null;
}

/** What the embed script receives. Never includes allowed origins or internal ids. */
export interface PublicWidgetConfig {
  siteId: string;
  siteTitle: string;
  orgSlug: string | null;
  brandName: string;
  enabled: boolean;
  modes: WidgetMode[];
  defaultMode: WidgetMode;
  greeting: string;
  color: string;
  colorForeground: string;
  position: WidgetPosition;
  consentMode: ConsentMode;
  consentText: string;
  bookingTypes: PublicBookingType[];
  helpEnabled: boolean;
  /** CSS custom properties derived from branding (brandingToCssVars). */
  cssVars: Record<string, string>;
}

export interface MergeInput {
  siteId: string;
  siteTitle: string;
  orgSlug: string | null;
  brandName: string;
  stored: WidgetConfig;
  consentText: string | null;
  brandPrimary: string;
  brandForeground: string;
  cssVars: Record<string, string>;
  bookingTypes: PublicBookingType[];
  helpAvailable: boolean;
}

/** Merge stored config with branding/org data into the public payload. */
export function mergePublicConfig(i: MergeInput): PublicWidgetConfig {
  const modes = WIDGET_MODES.filter((m) => i.stored.modes[m]);
  const booking = i.bookingTypes.length > 0;
  const finalModes = modes.filter((m) => (m === "booking" ? booking : true));
  const defaultMode = finalModes.includes(i.stored.defaultMode) ? i.stored.defaultMode : (finalModes[0] ?? "chat");
  return {
    siteId: i.siteId,
    siteTitle: i.siteTitle,
    orgSlug: i.orgSlug,
    brandName: i.brandName,
    enabled: i.stored.enabled && finalModes.length > 0,
    modes: finalModes,
    defaultMode,
    greeting: i.stored.greeting,
    color: i.stored.color ?? i.brandPrimary,
    colorForeground: i.stored.color ? readableOn(i.stored.color) : i.brandForeground,
    position: i.stored.position,
    consentMode: i.stored.consentMode,
    consentText: (i.consentText?.trim() || DEFAULT_CONSENT_TEXT).slice(0, MAX_CONSENT_TEXT),
    bookingTypes: i.bookingTypes,
    helpEnabled: i.stored.modes.help && i.helpAvailable,
    cssVars: i.cssVars,
  };
}

/** WCAG-ish luminance check without importing the branding module (keeps this file client-safe). */
export function readableOn(hex: string): string {
  if (!isHex(hex)) return "#ffffff";
  const n = parseInt(hex.slice(1), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  });
  const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return lum > 0.45 ? "#111111" : "#ffffff";
}

/** Script-tag `data-*` attributes → overrides applied on top of the server config. */
export interface ScriptOverrides {
  mode: WidgetMode | null;
  color: string | null;
  position: WidgetPosition | null;
  greeting: string | null;
  consent: ConsentMode | null;
}

export function parseScriptDataset(ds: Record<string, string | undefined>): ScriptOverrides {
  return {
    mode: isMode(ds.mode) ? ds.mode : null,
    color: isHex(ds.color) ? ds.color.toLowerCase() : null,
    position: (WIDGET_POSITIONS as readonly string[]).includes(ds.position ?? "") ? (ds.position as WidgetPosition) : null,
    greeting: typeof ds.greeting === "string" && ds.greeting.trim() ? ds.greeting.trim().slice(0, MAX_GREETING) : null,
    consent: (CONSENT_MODES as readonly string[]).includes(ds.consent ?? "") ? (ds.consent as ConsentMode) : null,
  };
}

/** One SSE frame. `data` is JSON-encoded on one line so framing never breaks. */
export function sseFrame(event: string, data: unknown, id?: string): string {
  const lines = [`event: ${event}`];
  if (id) lines.push(`id: ${id}`);
  lines.push(`data: ${JSON.stringify(data)}`);
  return lines.join("\n") + "\n\n";
}

export function sseComment(text: string): string {
  return `: ${text.replace(/\n/g, " ")}\n\n`;
}

/** Visitor-facing message shape (pending/hidden turns already filtered). */
export interface VisitorMessage {
  role: "user" | "assistant";
  content: string;
  ts: string;
}

/** Embed snippet shown in settings. */
export function embedSnippet(appUrl: string, siteId: string, cfg: Pick<WidgetConfig, "defaultMode" | "position" | "consentMode"> & { color?: string | null }): string {
  const attrs = [`src="${appUrl.replace(/\/$/, "")}/api/widget.js"`, `data-site="${siteId}"`, `data-mode="${cfg.defaultMode}"`, `data-position="${cfg.position}"`, `data-consent="${cfg.consentMode}"`];
  if (cfg.color) attrs.push(`data-color="${cfg.color}"`);
  return `<script async ${attrs.join(" ")}></script>`;
}

/** Staff-side DTO for one site's widget settings (returned by /api/widget/settings). */
export interface WidgetSiteDTO {
  id: string;
  title: string;
  consentText: string | null;
  allowedOrigins: string[];
  config: WidgetConfig;
  installed: boolean;
  updatedAt: string;
}
