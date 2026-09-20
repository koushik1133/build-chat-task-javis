import {
  Instagram,
  Facebook,
  Linkedin,
  Youtube,
  Music2,
  Twitter,
  AtSign,
  Image as ImageIcon,
  Globe,
  type LucideIcon,
} from "lucide-react";

/**
 * The one place a social channel is defined.
 *
 * Nav entries, the dynamic /channels/[channel] route, platform badges, the
 * connect-account picker and the publishing transport all derive from this
 * object — so adding a network is a single entry here, not a change in six
 * files that can drift out of sync.
 */

/** Icons available to a channel. Typed so a registry entry can't name a missing icon. */
const ICON_MAP = {
  instagram: Instagram,
  facebook: Facebook,
  linkedin: Linkedin,
  youtube: Youtube,
  tiktok: Music2,
  x: Twitter,
  threads: AtSign,
  pinterest: ImageIcon,
} satisfies Record<string, LucideIcon>;

export interface ChannelCapabilities {
  contentTypes: string[];
  captionLimit: number;
  supportsImage: boolean;
  supportsVideo: boolean;
  supportsHashtags: boolean;
  /** Whether the publishing transport can actually post here. */
  publishable: boolean;
}

export interface ChannelDef {
  /** Matches social_accounts.platform verbatim. */
  id: string;
  label: string;
  iconName: keyof typeof ICON_MAP;
  emoji: string;
  accent: { text: string; bg: string };
  capabilities: ChannelCapabilities;
  hasChannelPage: boolean;
  connectHref: string;
}

const CONNECT_HREF = "/social?tab=accounts";

export const CHANNEL_REGISTRY: Record<string, ChannelDef> = {
  instagram: {
    id: "instagram", label: "Instagram", iconName: "instagram", emoji: "📸",
    accent: { text: "text-pink-600 dark:text-pink-400", bg: "bg-pink-50 dark:bg-pink-950" },
    capabilities: { contentTypes: ["post", "reel", "story", "carousel"], captionLimit: 2200, supportsImage: true, supportsVideo: true, supportsHashtags: true, publishable: true },
    hasChannelPage: true, connectHref: CONNECT_HREF,
  },
  facebook: {
    id: "facebook", label: "Facebook", iconName: "facebook", emoji: "👥",
    accent: { text: "text-blue-600 dark:text-blue-400", bg: "bg-blue-50 dark:bg-blue-950" },
    capabilities: { contentTypes: ["post", "reel", "story"], captionLimit: 63206, supportsImage: true, supportsVideo: true, supportsHashtags: true, publishable: true },
    hasChannelPage: true, connectHref: CONNECT_HREF,
  },
  linkedin: {
    id: "linkedin", label: "LinkedIn", iconName: "linkedin", emoji: "💼",
    accent: { text: "text-blue-700 dark:text-blue-400", bg: "bg-blue-50 dark:bg-blue-950" },
    capabilities: { contentTypes: ["post", "article"], captionLimit: 3000, supportsImage: true, supportsVideo: true, supportsHashtags: true, publishable: true },
    hasChannelPage: true, connectHref: CONNECT_HREF,
  },
  youtube: {
    id: "youtube", label: "YouTube", iconName: "youtube", emoji: "▶️",
    accent: { text: "text-red-600 dark:text-red-400", bg: "bg-red-50 dark:bg-red-950" },
    capabilities: { contentTypes: ["video", "short"], captionLimit: 5000, supportsImage: false, supportsVideo: true, supportsHashtags: true, publishable: true },
    hasChannelPage: true, connectHref: CONNECT_HREF,
  },
  tiktok: {
    id: "tiktok", label: "TikTok", iconName: "tiktok", emoji: "🎵",
    accent: { text: "text-slate-900 dark:text-slate-100", bg: "bg-slate-100 dark:bg-slate-800" },
    capabilities: { contentTypes: ["short", "video"], captionLimit: 2200, supportsImage: false, supportsVideo: true, supportsHashtags: true, publishable: true },
    hasChannelPage: true, connectHref: CONNECT_HREF,
  },
  x: {
    id: "x", label: "X / Twitter", iconName: "x", emoji: "𝕏",
    accent: { text: "text-slate-900 dark:text-slate-100", bg: "bg-slate-100 dark:bg-slate-800" },
    capabilities: { contentTypes: ["post", "thread"], captionLimit: 280, supportsImage: true, supportsVideo: true, supportsHashtags: true, publishable: true },
    hasChannelPage: true, connectHref: CONNECT_HREF,
  },
  threads: {
    id: "threads", label: "Threads", iconName: "threads", emoji: "🔗",
    accent: { text: "text-slate-900 dark:text-slate-100", bg: "bg-slate-100 dark:bg-slate-800" },
    capabilities: { contentTypes: ["post"], captionLimit: 500, supportsImage: true, supportsVideo: true, supportsHashtags: true, publishable: true },
    hasChannelPage: true, connectHref: CONNECT_HREF,
  },
  pinterest: {
    id: "pinterest", label: "Pinterest", iconName: "pinterest", emoji: "📌",
    accent: { text: "text-red-600 dark:text-red-400", bg: "bg-red-50 dark:bg-red-950" },
    capabilities: { contentTypes: ["pin"], captionLimit: 500, supportsImage: true, supportsVideo: false, supportsHashtags: true, publishable: false },
    hasChannelPage: true, connectHref: CONNECT_HREF,
  },
};

/** Display order in the sidebar. Ids missing here sort last rather than vanish. */
const CHANNEL_ORDER = ["instagram", "facebook", "linkedin", "youtube", "tiktok", "x", "threads", "pinterest"];

/**
 * Legacy/alternate spellings already present in the database.
 * Expanded in exactly one place so nav, page loader and writes agree.
 */
const CHANNEL_ALIASES: Record<string, string> = {
  twitter: "x",
};

/** Canonical channel id for any incoming string, or null if unknown. */
export function toChannelId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const key = value.trim().toLowerCase();
  if (!key) return null;
  const canonical = CHANNEL_ALIASES[key] ?? key;
  return CHANNEL_REGISTRY[canonical] ? canonical : null;
}

/** Every platform string that should match this channel in a SQL IN (...). */
export function aliasesFor(id: string): string[] {
  const extra = Object.entries(CHANNEL_ALIASES)
    .filter(([, canonical]) => canonical === id)
    .map(([alias]) => alias);
  return [id, ...extra];
}

export function getChannel(id: string): ChannelDef | null {
  const canonical = toChannelId(id);
  return canonical ? CHANNEL_REGISTRY[canonical] : null;
}

export function iconFor(id: string): LucideIcon {
  const def = getChannel(id);
  // Globe is reserved for untrusted strings that aren't in the registry.
  return def ? ICON_MAP[def.iconName] : Globe;
}

function orderOf(id: string) {
  const i = CHANNEL_ORDER.indexOf(id);
  return i === -1 ? CHANNEL_ORDER.length : i;
}

/** All channels, in display order. */
export const ALL_CHANNELS: ChannelDef[] = Object.values(CHANNEL_REGISTRY).sort(
  (a, b) => orderOf(a.id) - orderOf(b.id)
);

/** Channels that get a /channels/<id> page. */
export const PAGE_CHANNELS: ChannelDef[] = ALL_CHANNELS.filter((c) => c.hasChannelPage);

export function sortChannelIds(ids: string[]): string[] {
  return [...ids].sort((a, b) => orderOf(a) - orderOf(b));
}

export function channelHref(id: string): string {
  const canonical = toChannelId(id);
  return canonical ? `/channels/${canonical}` : "/social?tab=accounts";
}
