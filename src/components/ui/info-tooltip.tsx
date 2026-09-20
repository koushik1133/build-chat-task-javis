import { HelpCircle } from "lucide-react";
import { ReactNode } from "react";

export function InfoTooltip({ text, children }: { text: string; children?: ReactNode }) {
  return (
    <div className="group relative inline-flex items-center gap-1.5">
      {children}
      <HelpCircle className="h-4 w-4 text-muted-foreground transition-colors hover:text-foreground cursor-help" />
      <div className="pointer-events-none absolute bottom-full left-1/2 z-50 mb-2 -translate-x-1/2 w-64 opacity-0 transition-opacity group-hover:opacity-100">
        <div className="rounded-lg border border-border bg-popover px-3 py-2 text-sm text-popover-foreground shadow-lg">
          {text}
        </div>
        {/* Triangle arrow */}
        <div className="absolute -bottom-1 left-1/2 h-2 w-2 -translate-x-1/2 rotate-45 border-b border-r border-border bg-popover" />
      </div>
    </div>
  );
}
