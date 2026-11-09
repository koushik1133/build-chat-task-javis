"use client";

import { useCallback, useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Banner, ErrorState, Loading } from "@/components/ui/feedback";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Pill } from "@/components/ui/pill";
import { api } from "@/components/finance/shared";

type Notice = { tone: "success" | "error"; text: string };
interface Addr { name?: string; line1: string; city: string; region?: string; postal_code?: string; country: string }
interface Pkg { weight_grams: number; length_cm?: number; width_cm?: number; height_cm?: number }
interface Conn { provider: "simulated" | "easypost" | "shippo"; label: string; status: string; available: boolean; reason: string | null; key_hint: string | null; uses_platform_key: boolean; ship_from: Addr | null; default_package: Pkg | null }

export function CarriersTab({ notify }: { notify: (n: Notice) => void }) {
  const [conns, setConns] = useState<Conn[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [keys, setKeys] = useState<Record<string, string>>({});
  const [from, setFrom] = useState<Addr>({ line1: "", city: "", country: "" });
  const [pkg, setPkg] = useState({ weight: "500", l: "", w: "", h: "" });
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await api<{ connections: Conn[] }>("/api/shipping/connections");
      setConns(r.connections);
      const first = r.connections[0];
      if (first?.ship_from) setFrom(first.ship_from);
      if (first?.default_package) setPkg({ weight: String(first.default_package.weight_grams), l: String(first.default_package.length_cm ?? ""), w: String(first.default_package.width_cm ?? ""), h: String(first.default_package.height_cm ?? "") });
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load carriers");
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  async function save(provider: string, extra: Record<string, unknown>, label: string) {
    setBusy(provider + label);
    try {
      const r = await api<{ connections: Conn[] }>("/api/shipping/connections", { method: "PUT", body: JSON.stringify({ provider, ...extra }) });
      setConns(r.connections);
      setKeys((k) => ({ ...k, [provider]: "" }));
      notify({ tone: "success", text: `${label} saved.` });
    } catch (e) {
      notify({ tone: "error", text: e instanceof Error ? e.message : "Could not save" });
    } finally {
      setBusy(null);
    }
  }
  const fromOk = from.line1.trim() && from.city.trim() && from.country.trim();
  const pkgBody = () => ({ weight_grams: Math.max(1, Math.round(Number(pkg.weight) || 500)), ...(Number(pkg.l) > 0 ? { length_cm: Number(pkg.l) } : {}), ...(Number(pkg.w) > 0 ? { width_cm: Number(pkg.w) } : {}), ...(Number(pkg.h) > 0 ? { height_cm: Number(pkg.h) } : {}) });

  if (error) return <ErrorState message={error} onRetry={() => void load()} />;
  if (!conns) return <Loading label="Loading carriers…" />;
  return (
    <div className="space-y-6">
      <section className="rounded-lg border border-border p-4" aria-label="Ship-from and default package">
        <h2 className="mb-3 text-sm font-semibold">Ship-from address and default package</h2>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Sender name"><Input value={from.name ?? ""} onChange={(e) => setFrom({ ...from, name: e.target.value })} /></Field>
          <Field label="Address line 1" required><Input value={from.line1} onChange={(e) => setFrom({ ...from, line1: e.target.value })} /></Field>
          <Field label="City" required><Input value={from.city} onChange={(e) => setFrom({ ...from, city: e.target.value })} /></Field>
          <Field label="State or region"><Input value={from.region ?? ""} onChange={(e) => setFrom({ ...from, region: e.target.value })} /></Field>
          <Field label="Postal code"><Input value={from.postal_code ?? ""} onChange={(e) => setFrom({ ...from, postal_code: e.target.value })} /></Field>
          <Field label="Country" required><Input value={from.country} onChange={(e) => setFrom({ ...from, country: e.target.value })} /></Field>
          <Field label="Default weight (g)"><Input inputMode="numeric" value={pkg.weight} onChange={(e) => setPkg({ ...pkg, weight: e.target.value })} /></Field>
          <div className="grid grid-cols-3 gap-2">
            <Field label="L (cm)"><Input inputMode="decimal" value={pkg.l} onChange={(e) => setPkg({ ...pkg, l: e.target.value })} /></Field>
            <Field label="W (cm)"><Input inputMode="decimal" value={pkg.w} onChange={(e) => setPkg({ ...pkg, w: e.target.value })} /></Field>
            <Field label="H (cm)"><Input inputMode="decimal" value={pkg.h} onChange={(e) => setPkg({ ...pkg, h: e.target.value })} /></Field>
          </div>
        </div>
        <Button type="button" className="mt-3" touch disabled={!fromOk || busy !== null} onClick={() => void save("simulated", { ship_from: from, default_package: pkgBody() }, "Ship-from")}>{busy === "simulatedShip-from" ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden /> : null}Save</Button>
      </section>
      {conns.map((c) => (
        <section key={c.provider} className="rounded-lg border border-border p-4" aria-label={c.label}>
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-sm font-semibold">{c.label}</h2>
            <Pill tone={c.available ? "success" : "neutral"}>{c.available ? (c.uses_platform_key ? "platform key (dev)" : "available") : "not connected"}</Pill>
            {c.key_hint && <span className="text-xs text-muted-foreground">key {c.key_hint}</span>}
          </div>
          {c.provider === "simulated" ? (
            <p className="mt-2 text-sm text-muted-foreground">Deterministic rates, fake tracking numbers and scripted tracking events. Labels are marked not valid for postage.</p>
          ) : (
            <>
              {!c.available && c.reason && <Banner tone="info" className="mt-2">{c.reason}</Banner>}
              <div className="mt-3 flex flex-wrap items-end gap-2">
                <Field label={c.provider === "easypost" ? "EasyPost API key" : "Shippo API token"} className="min-w-0 flex-1 basis-64"><Input type="password" autoComplete="off" value={keys[c.provider] ?? ""} onChange={(e) => setKeys({ ...keys, [c.provider]: e.target.value })} placeholder={c.key_hint ?? ""} /></Field>
                <Button type="button" touch disabled={(keys[c.provider] ?? "").length < 8 || busy !== null} onClick={() => void save(c.provider, { api_key: keys[c.provider] }, c.label)}>{c.key_hint ? "Replace key" : "Connect"}</Button>
              </div>
              <p className="mt-2 text-xs text-muted-foreground">Keys are encrypted at rest and never shown again. Live integration is untested against the real {c.label} API.</p>
            </>
          )}
        </section>
      ))}
    </div>
  );
}
