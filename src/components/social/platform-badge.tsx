import { cn } from "@/lib/utils";
import { ALL_CHANNELS, getChannel } from "@/lib/channels/registry";

/**
 * Platform presentation, derived from the channel registry so a network never
 * shows up in one list (the connect picker) but not another (the badge).
 * Public signatures are unchanged for existing callers.
 */
type PlatformConfig = { label: string; color: string; bg: string; emoji: string };

const FALLBACK: PlatformConfig = {
  label: "Unknown",
  color: "text-muted-foreground",
  bg: "bg-secondary",
  emoji: "🌐",
};

export function getPlatformConfig(platform: string): PlatformConfig {
  const def = getChannel(platform);
  if (!def) return { ...FALLBACK, label: platform };
  return {
    label: def.label,
    color: def.accent.text,
    bg: def.accent.bg,
    emoji: def.emoji,
  };
}

type PlatformBadgeProps = {
  platform: string;
  size?: "sm" | "md";
  className?: string;
};

export function PlatformBadge({ platform, size = "sm", className }: PlatformBadgeProps) {
  const cfg = getPlatformConfig(platform);

  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full font-medium",
        cfg.color,
        cfg.bg,
        size === "sm" ? "px-2 py-0.5 text-[10px]" : "px-2.5 py-1 text-xs",
        className
      )}
    >
      <span>{cfg.emoji}</span>
      {cfg.label}
    </span>
  );
}

/** Options for the connect-account picker — one entry per registered channel. */
export const ALL_PLATFORMS = ALL_CHANNELS.map((c) => ({
  value: c.id,
  label: c.label,
  emoji: c.emoji,
}));
