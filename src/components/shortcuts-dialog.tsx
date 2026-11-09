"use client";

import { Dialog } from "@/components/ui/dialog";
import { SHORTCUT_ROWS } from "@/lib/shortcuts/chord";
import { useT } from "@/components/i18n/provider";

export function ShortcutsDialog({ onClose, enabled, onToggle }: { onClose: () => void; enabled: boolean; onToggle: (on: boolean) => void }) {
  const t = useT();
  return (
    <Dialog title={t("shortcuts.title")} onClose={onClose} size="md">
      <ul className="divide-y divide-border text-sm">
        {SHORTCUT_ROWS.map((r) => (
          <li key={r.label} className="flex items-center justify-between gap-3 py-2">
            <span>{r.label}</span>
            <span className="flex shrink-0 items-center gap-1">
              {r.keys.map((k, i) => (
                <span key={i} className="flex items-center gap-1">
                  {i > 0 && <span className="text-[11px] text-muted-foreground">then</span>}
                  <kbd className="rounded border border-border bg-secondary px-1.5 py-0.5 font-mono text-xs">{k}</kbd>
                </span>
              ))}
            </span>
          </li>
        ))}
      </ul>
      <label className="mt-4 flex min-h-11 items-center gap-2 text-sm">
        <input type="checkbox" className="h-4 w-4 accent-primary" checked={enabled} onChange={(e) => onToggle(e.target.checked)} />
        {t("shortcuts.enable")}
      </label>
    </Dialog>
  );
}
