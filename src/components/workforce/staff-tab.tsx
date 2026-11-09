"use client";

import { useState } from "react";
import { Check, Copy, Link2, Loader2, Plus, UserRound } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogFooter } from "@/components/ui/dialog";
import { Banner, Empty, SkeletonList } from "@/components/ui/feedback";
import { Field } from "@/components/ui/field";
import { Checkbox, Input, Select } from "@/components/ui/input";
import { Pill } from "@/components/ui/pill";
import { TableScroller, TH, THEAD } from "@/components/ui/table-scroller";
import { EMPLOYMENT_TYPES, type StaffDTO } from "@/lib/workforce/pure";
import type { Notice } from "@/app/(app)/workforce/page";
import { jsonFetch, money } from "./shared";

const EMPLOYMENT_LABEL: Record<StaffDTO["employment_type"], string> = { full_time: "Full-time", part_time: "Part-time", contractor: "Contractor" };

interface Member {
  id: string;
  userId: string | null;
  email: string | null;
  role: string;
}

export function StaffTab({ staff, reload, notify }: { staff: StaffDTO[] | null; reload: () => Promise<void>; notify: (tone: Notice["tone"], text: string) => void }) {
  const [editing, setEditing] = useState<StaffDTO | null | "new">(null);
  const [crewLink, setCrewLink] = useState<{ staff: StaffDTO; url: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [showInactive, setShowInactive] = useState(false);

  async function makeCrewLink(s: StaffDTO) {
    setBusy(s.id);
    try {
      const r = await jsonFetch<{ url: string }>("/api/team/crew-links", { method: "POST", body: JSON.stringify({ label: s.display_name, staff_id: s.id, expiresDays: 90 }), fallback: "Could not create crew link" });
      setCrewLink({ staff: s, url: r.url });
    } catch (err) {
      notify("error", err instanceof Error ? err.message : "Could not create crew link");
    } finally {
      setBusy(null);
    }
  }

  if (staff === null) return <SkeletonList count={5} itemClassName="h-12" label="Loading staff…" />;
  const list = staff.filter((s) => showInactive || s.active);

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <Checkbox checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} label="Show inactive" />
        <Button size="sm" touch onClick={() => setEditing("new")}>
          <Plus className="h-4 w-4" aria-hidden /> Add staff
        </Button>
      </div>
      {list.length === 0 ? (
        <Empty icon={<UserRound className="h-6 w-6" aria-hidden />} title="No staff profiles" text="Add the people you schedule. They don't need a login — give them a crew link for their phone." action={<Button touch onClick={() => setEditing("new")}>Add staff</Button>} />
      ) : (
        <TableScroller label="Staff">
          <table className="w-full min-w-[44rem] text-sm">
            <thead className={THEAD}>
              <tr>
                <th scope="col" className={TH}>Name</th>
                <th scope="col" className={TH}>Role</th>
                <th scope="col" className={TH}>Type</th>
                <th scope="col" className={`${TH} text-right`}>Rate</th>
                <th scope="col" className={`${TH} text-right`}>Hours/wk</th>
                <th scope="col" className={TH}>Contact</th>
                <th scope="col" className={TH}>
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {list.map((s) => (
                <tr key={s.id} className="border-t border-border">
                  <td className="px-3 py-2">
                    <button type="button" onClick={() => setEditing(s)} className="rounded text-start font-medium underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" aria-label={`Edit ${s.display_name}`}>
                      {s.display_name}
                    </button>
                    <div className="flex flex-wrap gap-1 pt-0.5">
                      {!s.active && <Pill tone="neutral">Inactive</Pill>}
                      {s.membership_id && <Pill tone="info">Has login</Pill>}
                      {s.skills.slice(0, 3).map((k) => (
                        <Pill key={k}>{k}</Pill>
                      ))}
                    </div>
                  </td>
                  <td className="px-3 py-2 text-muted-foreground">{s.role_title ?? "—"}</td>
                  <td className="px-3 py-2 text-muted-foreground">{EMPLOYMENT_LABEL[s.employment_type]}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{s.hourly_rate_minor ? `${money(s.hourly_rate_minor, s.currency)}/h` : "—"}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{s.weekly_hours}</td>
                  <td className="px-3 py-2 text-muted-foreground">
                    <div className="truncate">{s.email ?? s.phone ?? "—"}</div>
                  </td>
                  <td className="px-3 py-2 text-right">
                    <Button variant="outline" size="sm" touch disabled={busy === s.id || !s.active} onClick={() => void makeCrewLink(s)} title="Create a crew link for this person's phone" aria-label={`Create crew link for ${s.display_name}`}>
                      {busy === s.id ? <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden /> : <Link2 className="h-4 w-4" aria-hidden />} Crew link
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableScroller>
      )}

      {editing && (
        <StaffDialog
          staff={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={async (msg) => {
            setEditing(null);
            notify("success", msg);
            await reload();
          }}
        />
      )}
      {crewLink && <CrewLinkDialog staff={crewLink.staff} url={crewLink.url} onClose={() => setCrewLink(null)} />}
    </div>
  );
}

function StaffDialog({ staff, onClose, onSaved }: { staff: StaffDTO | null; onClose: () => void; onSaved: (msg: string) => Promise<void> }) {
  const [form, setForm] = useState({
    display_name: staff?.display_name ?? "",
    email: staff?.email ?? "",
    phone: staff?.phone ?? "",
    role_title: staff?.role_title ?? "",
    employment_type: staff?.employment_type ?? ("full_time" as StaffDTO["employment_type"]),
    rate: staff ? (staff.hourly_rate_minor / 100).toFixed(2) : "",
    currency: staff?.currency ?? "USD",
    weekly_hours: staff?.weekly_hours ?? 40,
    skills: staff?.skills.join(", ") ?? "",
    location: staff?.location ?? "",
    start_date: staff?.start_date ?? "",
    end_date: staff?.end_date ?? "",
    membership_id: staff?.membership_id ?? "",
    active: staff?.active ?? true,
  });
  const [members, setMembers] = useState<Member[] | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = <K extends keyof typeof form>(k: K, v: (typeof form)[K]) => setForm((f) => ({ ...f, [k]: v }));

  async function loadMembers() {
    if (members) return;
    try {
      const d = await jsonFetch<{ members: Member[] }>("/api/team", { fallback: "Could not load team" });
      setMembers(d.members);
    } catch {
      setMembers([]);
    }
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const body = {
        display_name: form.display_name.trim(),
        email: form.email.trim() || null,
        phone: form.phone.trim() || null,
        role_title: form.role_title.trim() || null,
        employment_type: form.employment_type,
        hourly_rate_minor: Math.round((Number(form.rate) || 0) * 100),
        currency: form.currency.trim().toUpperCase() || "USD",
        weekly_hours: Number(form.weekly_hours) || 0,
        skills: form.skills.split(",").map((s) => s.trim()).filter(Boolean),
        location: form.location.trim() || null,
        start_date: form.start_date || null,
        end_date: form.end_date || null,
        membership_id: form.membership_id || null,
        active: form.active,
      };
      await jsonFetch(staff ? `/api/workforce/staff/${staff.id}` : "/api/workforce/staff", { method: staff ? "PATCH" : "POST", body: JSON.stringify(body), fallback: "Could not save" });
      await onSaved(staff ? "Profile updated." : "Staff member added.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save");
      setSaving(false);
    }
  }

  return (
    <Dialog title={staff ? "Edit staff profile" : "Add staff"} onClose={onClose} size="lg">
      <form onSubmit={(e) => void save(e)} className="space-y-3">
        {error && <Banner tone="error">{error}</Banner>}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="Name" required className="sm:col-span-2">
            <Input value={form.display_name} onChange={(e) => set("display_name", e.target.value)} required maxLength={120} />
          </Field>
          <Field label="Role">
            <Input value={form.role_title} onChange={(e) => set("role_title", e.target.value)} placeholder="Technician, Barista…" maxLength={80} />
          </Field>
          <Field label="Employment">
            <Select value={form.employment_type} onChange={(e) => set("employment_type", e.target.value as StaffDTO["employment_type"])}>
              {EMPLOYMENT_TYPES.map((t) => (
                <option key={t} value={t}>
                  {EMPLOYMENT_LABEL[t]}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Email" hint="Used for shift and leave notifications">
            <Input type="email" value={form.email} onChange={(e) => set("email", e.target.value)} maxLength={320} />
          </Field>
          <Field label="Phone">
            <Input type="tel" value={form.phone} onChange={(e) => set("phone", e.target.value)} maxLength={40} />
          </Field>
          <Field label="Hourly rate">
            <Input type="number" inputMode="decimal" min={0} step="0.01" value={form.rate} onChange={(e) => set("rate", e.target.value)} />
          </Field>
          <Field label="Currency" hint="3-letter code">
            <Input value={form.currency} onChange={(e) => set("currency", e.target.value.toUpperCase())} maxLength={3} autoCapitalize="characters" />
          </Field>
          <Field label="Contracted hours / week" hint="Overtime is paid above this">
            <Input type="number" inputMode="numeric" min={0} max={168} value={form.weekly_hours} onChange={(e) => set("weekly_hours", Number(e.target.value))} />
          </Field>
          <Field label="Location">
            <Input value={form.location} onChange={(e) => set("location", e.target.value)} maxLength={120} />
          </Field>
          <Field label="Skills" hint="Comma separated" className="sm:col-span-2">
            <Input value={form.skills} onChange={(e) => set("skills", e.target.value)} placeholder="forklift, first aid" />
          </Field>
          <Field label="Start date">
            <Input type="date" value={form.start_date} onChange={(e) => set("start_date", e.target.value)} />
          </Field>
          <Field label="End date">
            <Input type="date" value={form.end_date} onChange={(e) => set("end_date", e.target.value)} />
          </Field>
          <Field label="Linked login" hint="Optional: tie this profile to a team seat" className="sm:col-span-2">
            <Select value={form.membership_id} onFocus={() => void loadMembers()} onChange={(e) => set("membership_id", e.target.value)}>
              <option value="">No login (crew link only)</option>
              {form.membership_id && !members?.some((m) => m.id === form.membership_id) && <option value={form.membership_id}>Current link</option>}
              {(members ?? []).map((m) => (
                <option key={m.id} value={m.id}>
                  {m.email ?? m.userId ?? m.id} · {m.role}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <Checkbox checked={form.active} onChange={(e) => set("active", e.target.checked)} label="Active (appears on the rota)" />
        <DialogFooter>
          <Button type="button" variant="outline" touch onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" touch disabled={saving || !form.display_name.trim()}>
            {saving && <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden />} {staff ? "Save" : "Add"}
          </Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}

function CrewLinkDialog({ staff, url, onClose }: { staff: StaffDTO; url: string; onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  return (
    <Dialog title={`Crew link for ${staff.display_name}`} description="Shown once. Send it to their phone — it opens their shifts, clock in/out and leave requests without a login." onClose={onClose} size="sm">
      <div className="space-y-3">
        <Input readOnly value={url} onFocus={(e) => e.currentTarget.select()} aria-label="Crew link URL" className="font-mono text-xs" />
        <p className="sr-only" role="status" aria-live="polite">{copied ? "Link copied to the clipboard." : ""}</p>
        <DialogFooter>
          <Button type="button" variant="outline" touch onClick={onClose}>
            Done
          </Button>
          <Button
            type="button"
            touch
            onClick={() => {
              void navigator.clipboard?.writeText(url).then(() => setCopied(true)).catch(() => undefined);
            }}
          >
            {copied ? <Check className="h-4 w-4" aria-hidden /> : <Copy className="h-4 w-4" aria-hidden />} {copied ? "Copied" : "Copy link"}
          </Button>
        </DialogFooter>
      </div>
    </Dialog>
  );
}
