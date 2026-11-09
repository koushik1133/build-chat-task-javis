"use client";

import { confirmDialog } from "@/components/ui/confirm-dialog";
import { useCallback, useEffect, useState } from "react";
import { Loader2, Pencil, Plus, Trash2, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogFooter } from "@/components/ui/dialog";
import { Empty, ErrorState, SkeletonList } from "@/components/ui/feedback";
import { Field } from "@/components/ui/field";
import { Input, Select } from "@/components/ui/input";
import { Pill } from "@/components/ui/pill";
import { timeAgo } from "@/lib/utils";
import type { AudienceRow } from "@/lib/marketing/audiences";
import { describeAudience, parseAudienceDefinition, type AudienceDefinition, type MarketingSendChannel } from "@/lib/marketing/types";
import { AudienceBuilder, EligibilitySummary, jsonFetch, useAudiencePreview, type Notice } from "./shared";

export function AudiencesTab({ notify }: { notify: (tone: Notice["tone"], text: string) => void }) {
  const [rows, setRows] = useState<AudienceRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<AudienceRow | "new" | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setRows((await jsonFetch<{ audiences: AudienceRow[] }>("/api/marketing/audiences", undefined, "Could not load audiences")).audiences);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load audiences");
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  async function remove(a: AudienceRow) {
    if (!(await confirmDialog({ title: `Delete audience "${a.name}"?`, body: "Campaigns that used it keep their recipients.", confirmLabel: "Delete", tone: "danger" }))) return;
    try {
      await jsonFetch(`/api/marketing/audiences/${a.id}`, { method: "DELETE" }, "Could not delete");
      notify("success", "Audience deleted.");
      void load();
    } catch (e) {
      notify("error", e instanceof Error ? e.message : "Could not delete");
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-sm text-muted-foreground">Saved filters over your CRM contacts. Counts are live; consent is always re-checked when a campaign launches.</p>
        <Button type="button" touch className="self-start sm:self-auto" onClick={() => setEditing("new")}>
          <Plus className="h-4 w-4" aria-hidden /> New audience
        </Button>
      </div>
      {loading ? (
        <SkeletonList count={3} label="Loading audiences…" />
      ) : error ? (
        <ErrorState message={error} onRetry={load} />
      ) : rows.length === 0 ? (
        <Empty icon={<Users className="h-5 w-5" />} title="No audiences yet" text="Build one from lifecycle, tags, activity and consent filters." action={<Button type="button" touch onClick={() => setEditing("new")}>Create an audience</Button>} />
      ) : (
        <ul className="grid gap-2 sm:grid-cols-2" aria-label="Audiences">
          {rows.map((a) => (
            <li key={a.id} className="rounded-lg border border-border bg-card p-3 sm:p-4">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="truncate font-medium">{a.name}</p>
                  <p className="mt-0.5 text-xs text-muted-foreground [overflow-wrap:anywhere]">{describeAudience(parseAudienceDefinition(a.definition))}</p>
                </div>
                <Pill tone="neutral" title="Cached size (refreshed on save and launch)">
                  {a.size_cache ?? "—"}
                </Pill>
              </div>
              <div className="mt-3 flex items-center justify-between gap-2 text-xs text-muted-foreground">
                <span>Updated {timeAgo(a.updated_at)}</span>
                <span className="flex gap-1">
                  <Button type="button" variant="ghost" size="icon-sm" touch aria-label={`Edit ${a.name}`} onClick={() => setEditing(a)}>
                    <Pencil className="h-3.5 w-3.5" aria-hidden />
                  </Button>
                  <Button type="button" variant="ghost" size="icon-sm" touch aria-label={`Delete ${a.name}`} onClick={() => remove(a)} className="text-destructive hover:text-destructive">
                    <Trash2 className="h-3.5 w-3.5" aria-hidden />
                  </Button>
                </span>
              </div>
            </li>
          ))}
        </ul>
      )}
      {editing && (
        <AudienceDialog
          audience={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={(msg) => {
            setEditing(null);
            notify("success", msg);
            void load();
          }}
        />
      )}
    </div>
  );
}

function AudienceDialog({ audience, onClose, onSaved }: { audience: AudienceRow | null; onClose: () => void; onSaved: (msg: string) => void }) {
  const [name, setName] = useState(audience?.name ?? "");
  const [def, setDef] = useState<AudienceDefinition>(audience ? parseAudienceDefinition(audience.definition) : {});
  const [channel, setChannel] = useState<MarketingSendChannel>("email");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const preview = useAudiencePreview(def, channel);

  async function save() {
    if (!name.trim()) return setErr("Name the audience.");
    setBusy(true);
    setErr(null);
    try {
      if (audience) await jsonFetch(`/api/marketing/audiences/${audience.id}`, { method: "PATCH", body: JSON.stringify({ name: name.trim(), definition: def }) }, "Could not save");
      else await jsonFetch("/api/marketing/audiences", { method: "POST", body: JSON.stringify({ name: name.trim(), definition: def }) }, "Could not save");
      onSaved(audience ? "Audience updated." : "Audience created.");
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not save");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog title={audience ? "Edit audience" : "New audience"} description="Every filter is combined with AND." onClose={onClose} size="lg">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
        className="space-y-4"
      >
        <div className="grid gap-3 sm:grid-cols-[1fr_auto]">
          <Field label="Name" required>
            <Input value={name} onChange={(e) => setName(e.target.value.slice(0, 120))} autoFocus placeholder="Active customers" />
          </Field>
          <Field label="Count eligibility for">
            <Select value={channel} onChange={(e) => setChannel(e.target.value as MarketingSendChannel)}>
              <option value="email">Email</option>
              <option value="sms">SMS</option>
            </Select>
          </Field>
        </div>
        <AudienceBuilder value={def} onChange={setDef} channel={channel} />
        <div className="rounded-lg border border-border p-3">
          <EligibilitySummary preview={preview.data} loading={preview.loading} channel={channel} />
          {preview.error && <p className="mt-1 text-xs text-destructive">{preview.error}</p>}
          {preview.data && preview.data.sample.length > 0 && (
            <ul className="mt-2 flex flex-wrap gap-1.5" aria-label="Sample contacts">
              {preview.data.sample.map((c) => (
                <li key={c.id}>
                  <Pill tone="neutral" title={c.email ?? c.phone ?? ""}>
                    {c.full_name}
                  </Pill>
                </li>
              ))}
            </ul>
          )}
        </div>
        {err && (
          <p role="alert" className="text-sm text-destructive">
            {err}
          </p>
        )}
        <DialogFooter>
          <Button type="button" variant="ghost" touch onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button type="submit" touch disabled={busy}>
            {busy && <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden />} Save audience
          </Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}
