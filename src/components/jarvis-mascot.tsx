"use client";

import { Sparkles } from "lucide-react";
import { cn } from "@/lib/utils";

export function JarvisMascot({
  message,
  size = "md",
  className,
}: {
  message: string;
  size?: "sm" | "md" | "lg";
  className?: string;
}) {
  const avatarSize =
    size === "sm" ? "h-8 w-8" : size === "lg" ? "h-14 w-14" : "h-10 w-10";
  const iconSize =
    size === "sm" ? "h-4 w-4" : size === "lg" ? "h-7 w-7" : "h-5 w-5";

  return (
    <div className={cn("flex items-start gap-3", className)}>
      <div
        className={cn(
          "flex shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-amber-400 to-orange-500 shadow-lg shadow-orange-500/30",
          avatarSize
        )}
        aria-hidden
      >
        <Sparkles className={cn("text-white", iconSize)} />
      </div>
      <div className="relative max-w-prose rounded-2xl rounded-tl-sm bg-secondary px-4 py-3 text-sm leading-relaxed">
        {message}
      </div>
    </div>
  );
}
