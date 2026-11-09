"use client";

import { useCallback, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { Button } from "@/components/ui/button";
import { Dialog, DialogFooter } from "@/components/ui/dialog";

/*
 * Promise-based confirmation, replacing window.confirm.
 *
 *   const confirm = useConfirm();
 *   if (!(await confirm({ title: "Delete template?", body: "This cannot be undone.", confirmLabel: "Delete", tone: "danger" }))) return;
 *
 * The dialog mounts itself in a detached React root, so no provider or JSX is
 * needed at the call site. Escape / backdrop / Cancel resolve `false`.
 */

export interface ConfirmOptions {
  title: string;
  body?: React.ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: "default" | "danger";
}

export function ConfirmDialog({ title, body, confirmLabel = "Confirm", cancelLabel = "Cancel", tone = "default", onResolve }: ConfirmOptions & { onResolve: (ok: boolean) => void }) {
  // Capture Escape before any dialog underneath sees it, so only this one closes.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== "Escape") return;
      e.stopImmediatePropagation();
      onResolve(false);
    }
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onResolve]);
  return (
    <div className="relative z-[60]">
      <Dialog title={title} size="sm" onClose={() => onResolve(false)}>
        {body ? <div className="text-sm text-muted-foreground">{body}</div> : null}
        <DialogFooter>
          <Button type="button" variant="outline" touch onClick={() => onResolve(false)}>
            {cancelLabel}
          </Button>
          <Button type="button" variant={tone === "danger" ? "destructive" : "default"} touch data-autofocus="" onClick={() => onResolve(true)}>
            {confirmLabel}
          </Button>
        </DialogFooter>
      </Dialog>
    </div>
  );
}

/** Imperatively show a ConfirmDialog; resolves true on confirm, false otherwise. Client-only. */
export function confirmDialog(opts: ConfirmOptions): Promise<boolean> {
  if (typeof document === "undefined") return Promise.resolve(false);
  return new Promise<boolean>((resolve) => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    let done = false;
    const finish = (ok: boolean) => {
      if (done) return;
      done = true;
      resolve(ok);
      // Unmount after the current event so Dialog cleanup (focus restore) runs cleanly.
      setTimeout(() => {
        root.unmount();
        host.remove();
      }, 0);
    };
    root.render(<ConfirmDialog {...opts} onResolve={finish} />);
  });
}

/** Hook form of `confirmDialog` (stable identity). */
export function useConfirm(): (opts: ConfirmOptions) => Promise<boolean> {
  return useCallback((opts: ConfirmOptions) => confirmDialog(opts), []);
}
