"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { ClipboardList, Loader2, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/input";
import { Pill } from "@/components/ui/pill";
import { SkeletonList } from "@/components/ui/feedback";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { cn } from "@/lib/utils";
import { fmtDate } from "@/lib/money/format";
import { api, Banner, Dialog, DialogFooter, Empty, Field } from "@/components/finance/shared";
import { COUNT_TONE, type CountItem, type CountLine, type LocationItem } from "./types";

export function CountsTab({ locations, onChanged, onNotice }: { locations: LocationItem[]; onChanged: () => void; onNotice: (msg: string) => void }) {
  const [counts, setCounts] = useState<CountItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [opening, setOpening] = useState(false);
  const [active, setActive] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await api<{ counts: CountItem[] }>("/api/stock-counts");
      setCounts(r.counts);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load counts.");
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div>
      <div className="mb-4 flex justify-end">
        <Button touch onClick={() => setOpening(true)} disabled={locations.length === 0}>
          <Plus className="h-4 w-4" aria-hidden /> Start a count
        </Button>
      </div>
      {error && (
        <Banner tone="error" onDismiss={() => setError(null)}>
          {error}
        </Banner>
      )}
      {loading && counts.length === 0 ? (
        <SkeletonList count={3} label="Loading counts…" />
      ) : counts.length === 0 ? (
        <Empty icon={<ClipboardList className="h-5 w-5" />} title="No stock counts yet" text="Start a count for a location, enter what you find on the shelves, and apply the differences." />
      ) : (
        <ul className="space-y-2">
          {counts.map((c) => (
            <li key={c.id} className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-border bg-card p-4">
              <div className="min-w-0">
                <p className="font-medium">{c.location_name ?? "Location"}</p>
                <p className="text-xs text-muted-foreground">
                  {fmtDate(c.created_at)} · {c.summary.counted}/{c.summary.lines} counted
                </p>
              </div>
              <div className="flex items-center gap-2">
                <Pill tone={COUNT_TONE[c.status]} className="capitalize">
                  {c.status}
                </Pill>
                <Button variant="outline" size="sm" touch onClick={() => setActive(c.id)} aria-label={`${c.status === "applied" ? "View" : "Enter"} count for ${c.location_name ?? "location"}`}>
                  {c.status === "applied" ? "View" : "Enter counts"}
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
      {opening && (
        <OpenDialog
          locations={locations}
          onClose={() => setOpening(false)}
          onOpened={(id) => {
            setOpening(false);
            setActive(id);
            void load();
          }}
        />
      )}
      {active && (
        <CountDialog
          id={active}
          onClose={() => {
            setActive(null);
            void load();
          }}
          onApplied={(msg) => {
            onNotice(msg);
            onChanged();
          }}
        />
      )}
    </div>
  );
}

function OpenDialog({ locations, onClose, onOpened }: { locations: LocationItem[]; onClose: () => void; onOpened: (id: string) => void }) {
  const [loc, setLoc] = useState(locations[0]?.id ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    try {
      const r = await api<{ count: CountItem }>("/api/stock-counts", { method: "POST", body: JSON.stringify({ location_id: loc }) });
      onOpened(r.count.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not start the count.");
      setSaving(false);
    }
  }
  return (
    <Dialog title="Start a stock count" description="Expected quantities are frozen when you start." onClose={onClose} size="sm">
      <form onSubmit={submit} className="space-y-4">
        <Field label="Location">
          <Select data-autofocus value={loc} onChange={(e) => setLoc(e.target.value)}>
            {locations.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </Select>
        </Field>
        {error && <Banner tone="error" onDismiss={() => setError(null)} className="mb-0">{error}</Banner>}
        <DialogFooter>
          <Button type="button" variant="outline" touch onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button type="submit" touch disabled={saving || !loc}>
            {saving && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />} Start
          </Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}

function CountDialog({ id, onClose, onApplied }: { id: string; onClose: () => void; onApplied: (msg: string) => void }) {
  const [count, setCount] = useState<CountItem | null>(null);
  const [entry, setEntry] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const confirm = useConfirm();

  const hydrate = useCallback((c: CountItem) => {
    setCount(c);
    setEntry(Object.fromEntries((c.lines ?? []).map((l) => [l.product_id, l.counted_qty === null ? "" : String(l.counted_qty)])));
  }, []);
  useEffect(() => {
    let live = true;
    api<{ count: CountItem }>(`/api/stock-counts/${id}`)
      .then((r) => live && hydrate(r.count))
      .catch((e) => live && setError(e instanceof Error ? e.message : "Could not load the count."));
    return () => {
      live = false;
    };
  }, [id, hydrate]);

  const lines: CountLine[] = useMemo(() => count?.lines ?? [], [count]);
  const locked = count?.status === "applied";
  const varianceOf = (l: CountLine): number | null => {
    const raw = entry[l.product_id];
    return raw === undefined || raw === "" ? null : Math.trunc(Number(raw)) - l.expected_qty;
  };
  const changed = useMemo(() => lines.filter((l) => (entry[l.product_id] ?? "") !== (l.counted_qty === null ? "" : String(l.counted_qty))), [lines, entry]);

  async function save(): Promise<CountItem | null> {
    setSaving(true);
    setError(null);
    try {
      const payload = lines
        .filter((l) => (entry[l.product_id] ?? "") !== "")
        .map((l) => ({ product_id: l.product_id, counted_qty: Math.max(0, Math.trunc(Number(entry[l.product_id]))) }));
      if (payload.length === 0) throw new Error("Enter at least one counted quantity.");
      const r = await api<{ count: CountItem }>(`/api/stock-counts/${id}/lines`, { method: "POST", body: JSON.stringify({ lines: payload }) });
      hydrate(r.count);
      return r.count;
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save counts.");
      return null;
    } finally {
      setSaving(false);
    }
  }

  async function apply() {
    const saved = changed.length > 0 || count?.status === "open" ? await save() : count;
    if (!saved) return;
    const withVar = (saved.lines ?? []).filter((l) => l.variance !== null && l.variance !== 0).length;
    if (!(await confirm({ title: "Apply this count?", body: `${withVar} product${withVar === 1 ? "" : "s"} will be adjusted to the counted quantities. This writes stock movements.`, confirmLabel: "Apply" }))) return;
    setSaving(true);
    try {
      await api(`/api/stock-counts/${id}/apply`, { method: "POST", body: "{}" });
      onApplied(`Count applied: ${withVar} adjustment${withVar === 1 ? "" : "s"}.`);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not apply the count.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog title={`Count · ${count?.location_name ?? "…"}`} description={count ? `Started ${fmtDate(count.created_at)}` : undefined} onClose={onClose} size="lg">
      {!count && !error ? (
        <SkeletonList count={4} itemClassName="h-10" label="Loading count…" />
      ) : (
        <div className="space-y-3">
          {error && <Banner tone="error" onDismiss={() => setError(null)} className="mb-0">{error}</Banner>}
          {lines.length === 0 ? (
            <p className="text-sm text-muted-foreground">No tracked products have stock records at this location.</p>
          ) : (
            <ul className="max-h-[50dvh] divide-y divide-border overflow-y-auto rounded-lg border border-border">
              {lines.map((l) => {
                const v = varianceOf(l);
                return (
                  <li key={l.id} className="flex flex-col gap-2 px-3 py-3 sm:flex-row sm:items-center sm:justify-between sm:gap-3 sm:py-2">
                    <span className="min-w-0 break-words text-sm">
                      {l.product_name ?? l.product_id} <span className="text-xs text-muted-foreground">expected {l.expected_qty}</span>
                    </span>
                    <span className="flex shrink-0 items-center justify-between gap-2 sm:justify-end">
                      {v !== null && v !== 0 && (
                        <span className={cn("text-xs font-semibold tabular-nums", v < 0 ? "text-red-700 dark:text-red-300" : "text-emerald-700 dark:text-emerald-300")}>
                          {v > 0 ? `+${v}` : v}
                        </span>
                      )}
                      <Input
                        aria-label={`Counted quantity for ${l.product_name ?? l.product_id}`}
                        type="number"
                        inputMode="numeric"
                        min={0}
                        step={1}
                        value={entry[l.product_id] ?? ""}
                        disabled={locked}
                        onChange={(e) => setEntry((prev) => ({ ...prev, [l.product_id]: e.target.value }))}
                        className={cn("h-11 w-28 text-base", v !== null && v !== 0 && "border-amber-500")}
                      />
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" touch onClick={onClose} disabled={saving}>
              Close
            </Button>
            {!locked && (
              <>
                <Button type="button" variant="outline" touch onClick={() => void save()} disabled={saving || lines.length === 0}>
                  Save counts
                </Button>
                <Button type="button" touch onClick={() => void apply()} disabled={saving || lines.length === 0}>
                  {saving && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />} Apply
                </Button>
              </>
            )}
          </DialogFooter>
        </div>
      )}
    </Dialog>
  );
}
