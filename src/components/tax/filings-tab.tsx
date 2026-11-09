"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { StatusPill } from "@/components/ui/pill";
import { TableScroller, TH, THEAD } from "@/components/ui/table-scroller";
import { api, Banner, Dialog, DialogFooter, Empty, Field } from "@/components/finance/shared";
import type { Filing } from "./types";

export function FilingsTab({ filings, onChanged }: { filings: Filing[]; onChanged: () => void }) {
  const [marking, setMarking] = useState<Filing | null>(null);
  const [ref, setRef] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function act(body: Record<string, unknown>) {
    setBusy(true);
    setError(null);
    try {
      await api("/api/tax/filings", { method: "PATCH", body: JSON.stringify(body) });
      setMarking(null);
      setRef("");
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Update failed.");
    } finally {
      setBusy(false);
    }
  }

  if (filings.length === 0) return <Empty title="No filings yet" text="Run a report and choose Prepare filing. KernelHub never files for you: record the reference after you submit." />;
  return (
    <div className="space-y-3">
      {error && <Banner tone="error" onDismiss={() => setError(null)}>{error}</Banner>}
      <TableScroller label="Tax filings">
        <table className="w-full text-sm">
          <thead className={THEAD}><tr><th scope="col" className={TH}>Regime</th><th scope="col" className={TH}>Period</th><th scope="col" className={TH}>Status</th><th scope="col" className={TH}>Reference</th><th scope="col" className={TH}>Actions</th></tr></thead>
          <tbody>
            {filings.map((f) => (
              <tr key={f.id} className="border-t border-border">
                <td className="px-3 py-2">{f.regime.replace(/_/g, " ")}</td>
                <td className="px-3 py-2">{f.period_start.slice(0, 10)} to {f.period_end.slice(0, 10)}</td>
                <td className="px-3 py-2"><StatusPill status={f.status} map={{ prepared: "info", filed: "success", void: "neutral", draft: "warning" }} /></td>
                <td className="px-3 py-2">{f.filed_ref ?? ""}</td>
                <td className="px-3 py-2">
                  <div className="flex gap-2">
                    {(f.status === "prepared" || f.status === "draft") && <Button type="button" size="sm" variant="outline" onClick={() => setMarking(f)}>Mark filed</Button>}
                    {f.status !== "filed" && f.status !== "void" && <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => void act({ id: f.id, action: "void" })}>Void</Button>}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </TableScroller>
      {marking && (
        <Dialog title="Mark as filed" onClose={() => setMarking(null)} size="sm">
          <form onSubmit={(e) => { e.preventDefault(); void act({ id: marking.id, action: "file", filed_ref: ref.trim() }); }} className="space-y-3">
            <Field label="Filing reference" hint="Acknowledgement / ARN number from the tax portal" required>
              <Input data-autofocus required maxLength={120} value={ref} onChange={(e) => setRef(e.target.value)} />
            </Field>
            <DialogFooter>
              <Button type="button" variant="outline" touch onClick={() => setMarking(null)}>Cancel</Button>
              <Button type="submit" touch disabled={busy || !ref.trim()}>Mark filed</Button>
            </DialogFooter>
          </form>
        </Dialog>
      )}
    </div>
  );
}
