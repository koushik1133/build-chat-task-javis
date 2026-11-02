"use client";

import { useId, useRef } from "react";
import { X } from "lucide-react";
import { useModal } from "@/components/ui/hooks";
import { cn } from "@/lib/utils";

/*
 * Dialog: bottom sheet on phones, centred on larger screens. Drawer: side panel.
 * Both: Escape closes, focus is trapped and restored, aria-modal, labelled by the
 * heading, body scrolls internally and never exceeds the viewport.
 */

const SIZES = { sm: "sm:max-w-md", md: "sm:max-w-lg", lg: "sm:max-w-2xl", xl: "sm:max-w-4xl" } as const;

export function CloseButton({ onClick, label = "Close", className }: { onClick: () => void; label?: string; className?: string }) {
  return (
    <button
      type="button"
      data-dialog-close=""
      onClick={onClick}
      aria-label={label}
      className={cn(
        "-mr-2 -mt-1.5 inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-secondary/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:h-8 sm:w-8",
        className
      )}
    >
      <X className="h-4 w-4" aria-hidden />
    </button>
  );
}

export function Dialog({
  title,
  description,
  onClose,
  children,
  size = "md",
  className,
}: {
  title: React.ReactNode;
  description?: React.ReactNode;
  onClose: () => void;
  children: React.ReactNode;
  size?: keyof typeof SIZES;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const descId = useId();
  useModal(ref, onClose);
  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-0 sm:items-center sm:p-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descId : undefined}
        tabIndex={-1}
        className={cn("flex max-h-[92dvh] w-full flex-col rounded-t-xl border border-border bg-card shadow-xl outline-none sm:rounded-xl", SIZES[size], className)}
      >
        <header className="flex items-start justify-between gap-3 border-b border-border px-4 py-3 sm:px-5">
          <div className="min-w-0 pt-0.5">
            <h2 id={titleId} className="break-words text-base font-semibold leading-snug">
              {title}
            </h2>
            {description && (
              <p id={descId} className="mt-0.5 text-sm text-muted-foreground">
                {description}
              </p>
            )}
          </div>
          <CloseButton onClick={onClose} />
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-4 sm:px-5">{children}</div>
      </div>
    </div>
  );
}

/** Action row pinned to the bottom of a Dialog body; place it last inside the form. */
export function DialogFooter({ children, start, className }: { children: React.ReactNode; start?: React.ReactNode; className?: string }) {
  return (
    <div
      className={cn(
        "sticky bottom-0 -mx-4 -mb-4 mt-4 flex flex-wrap items-center justify-end gap-2 border-t border-border bg-card px-4 py-3 [padding-bottom:max(0.75rem,env(safe-area-inset-bottom))] sm:-mx-5 sm:px-5",
        className
      )}
    >
      {start && <div className="mr-auto min-w-0 text-sm text-muted-foreground">{start}</div>}
      {children}
    </div>
  );
}

export function Drawer({
  labelledBy,
  header,
  children,
  footer,
  onClose,
  className,
}: {
  /** id of the heading element rendered inside `header` */
  labelledBy: string;
  header: React.ReactNode;
  children: React.ReactNode;
  footer?: React.ReactNode;
  onClose: () => void;
  className?: string;
}) {
  const ref = useRef<HTMLElement>(null);
  useModal(ref, onClose, { initialFocus: "container" });
  return (
    <div
      className="fixed inset-0 z-50 flex justify-end bg-black/40"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <aside
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        tabIndex={-1}
        className={cn("flex h-full w-full flex-col border-l border-border bg-card shadow-xl outline-none sm:max-w-xl", className)}
      >
        <header className="flex items-start justify-between gap-3 border-b border-border px-4 py-3">
          {header}
          <CloseButton onClick={onClose} />
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-4">{children}</div>
        {footer && (
          <footer className="flex flex-wrap items-center justify-between gap-2 border-t border-border px-4 py-3 [padding-bottom:max(0.75rem,env(safe-area-inset-bottom))]">{footer}</footer>
        )}
      </aside>
    </div>
  );
}
