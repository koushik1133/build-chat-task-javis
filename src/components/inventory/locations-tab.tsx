"use client";

import { useState } from "react";
import { Archive, Loader2, MapPin, Pencil, Plus, Star } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/input";
import { Pill } from "@/components/ui/pill";
import { SkeletonList } from "@/components/ui/feedback";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { api, Banner, Dialog, DialogFooter, Empty, Field } from "@/components/finance/shared";
import { KIND_LABEL, type LocationItem } from "./types";

function addressLine(a: LocationItem["address"]): string {
  if (!a) return "";
  return [a.line1, a.city, a.region, a.country].filter(Boolean).join(", ");
}

export function LocationsTab({ locations, loading, onChanged, onNotice }: { locations: LocationItem[]; loading: boolean; onChanged: () => void; onNotice: (msg: string) => void }) {
  const [editing, setEditing] = useState<LocationItem | "new" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const confirm = useConfirm();

  async function archive(l: LocationItem) {
    if (!(await confirm({ title: `Archive “${l.name}”?`, body: "It must hold no stock. You can restore it later from the API.", confirmLabel: "Archive", tone: "danger" }))) return;
    setBusy(l.id);
    setError(null);
    try {
      await api(`/api/locations/${l.id}`, { method: "PATCH", body: JSON.stringify({ active: false }) });
      onNotice(`${l.name} archived.`);
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not archive that location.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div>
      <div className="mb-4 flex justify-end">
        <Button touch onClick={() => setEditing("new")}>
          <Plus className="h-4 w-4" aria-hidden /> New location
        </Button>
      </div>
      {error && (
        <Banner tone="error" onDismiss={() => setError(null)}>
          {error}
        </Banner>
      )}
      {loading && locations.length === 0 ? (
        <SkeletonList count={3} label="Loading locations…" />
      ) : locations.length === 0 ? (
        <Empty
          icon={<MapPin className="h-5 w-5" />}
          title="No locations yet"
          text="Add a warehouse, store or van to track stock separately. Your current stock moves into the first location you create."
          action={
            <Button onClick={() => setEditing("new")}>
              <Plus className="h-4 w-4" aria-hidden /> Add a location
            </Button>
          }
        />
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {locations.map((l) => (
            <li key={l.id} className="rounded-xl border border-border bg-card p-4">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="truncate font-medium">{l.name}</p>
                  <p className="truncate text-xs text-muted-foreground">{[l.code, addressLine(l.address)].filter(Boolean).join(" · ") || "No address"}</p>
                </div>
                <div className="flex shrink-0 flex-wrap justify-end gap-1">
                  <Pill tone="neutral">{KIND_LABEL[l.kind]}</Pill>
                  {l.is_default && (
                    <Pill tone="accent">
                      <Star className="h-3 w-3" aria-hidden /> Default
                    </Pill>
                  )}
                </div>
              </div>
              <div className="mt-3 flex gap-2">
                <Button variant="outline" size="sm" touch onClick={() => setEditing(l)} aria-label={`Edit ${l.name}`}>
                  <Pencil className="h-3.5 w-3.5" aria-hidden /> Edit
                </Button>
                {!l.is_default && (
                  <Button variant="outline" size="sm" touch disabled={busy === l.id} onClick={() => void archive(l)} aria-label={`Archive ${l.name}`}>
                    {busy === l.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : <Archive className="h-3.5 w-3.5" aria-hidden />} Archive
                  </Button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
      {editing && (
        <LocationDialog
          location={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={(msg) => {
            setEditing(null);
            onNotice(msg);
            onChanged();
          }}
        />
      )}
    </div>
  );
}

function LocationDialog({ location, onClose, onSaved }: { location: LocationItem | null; onClose: () => void; onSaved: (msg: string) => void }) {
  const [name, setName] = useState(location?.name ?? "");
  const [code, setCode] = useState(location?.code ?? "");
  const [kind, setKind] = useState<LocationItem["kind"]>(location?.kind ?? "warehouse");
  const [line1, setLine1] = useState(location?.address?.line1 ?? "");
  const [city, setCity] = useState(location?.address?.city ?? "");
  const [region, setRegion] = useState(location?.address?.region ?? "");
  const [postal, setPostal] = useState(location?.address?.postal_code ?? "");
  const [country, setCountry] = useState(location?.address?.country ?? "");
  const [isDefault, setIsDefault] = useState(location?.is_default ?? false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const nz = (v: string) => v.trim() || null;
      const address = { line1: nz(line1), city: nz(city), region: nz(region), postal_code: nz(postal), country: nz(country)?.toUpperCase().slice(0, 2) ?? null };
      const body = JSON.stringify({ name: name.trim(), code: nz(code), kind, address, ...(isDefault ? { is_default: true } : {}) });
      if (location) await api(`/api/locations/${location.id}`, { method: "PATCH", body });
      else await api("/api/locations", { method: "POST", body });
      onSaved(location ? `${name.trim()} updated.` : `${name.trim()} added.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save the location.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog title={location ? "Edit location" : "New location"} onClose={onClose}>
      <form onSubmit={submit} className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Name" required>
            <Input data-autofocus value={name} maxLength={120} onChange={(e) => setName(e.target.value)} required />
          </Field>
          <Field label="Code">
            <Input value={code} maxLength={20} onChange={(e) => setCode(e.target.value)} placeholder="WH-1" />
          </Field>
          <Field label="Type">
            <Select value={kind} onChange={(e) => setKind(e.target.value as LocationItem["kind"])}>
              {Object.entries(KIND_LABEL).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Street address">
            <Input value={line1} maxLength={200} onChange={(e) => setLine1(e.target.value)} autoComplete="street-address" />
          </Field>
          <Field label="City">
            <Input value={city} maxLength={100} onChange={(e) => setCity(e.target.value)} />
          </Field>
          <Field label="State / region">
            <Input value={region} maxLength={100} onChange={(e) => setRegion(e.target.value)} />
          </Field>
          <Field label="Postal code">
            <Input value={postal} maxLength={20} onChange={(e) => setPostal(e.target.value)} />
          </Field>
          <Field label="Country (2-letter)">
            <Input value={country} maxLength={2} onChange={(e) => setCountry(e.target.value)} placeholder="US" />
          </Field>
        </div>
        {!location?.is_default && (
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={isDefault} onChange={(e) => setIsDefault(e.target.checked)} className="h-4 w-4 rounded border-border" />
            Make this the default location (receives stock and fills orders first)
          </label>
        )}
        {error && (
          <Banner tone="error" onDismiss={() => setError(null)} className="mb-0">
            {error}
          </Banner>
        )}
        <DialogFooter>
          <Button type="button" variant="outline" touch onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button type="submit" touch disabled={saving || !name.trim()}>
            {saving && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />} Save
          </Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}
