import { randomUUID } from "crypto";
import { z } from "zod";
import { query, queryOne } from "@/lib/dsql";
import { decryptSecret, encryptSecret, isEncryptionConfigured, maskSecret } from "@/lib/secure-store";
import { tableExists } from "@/lib/table-exists";
import { easypostProvider } from "./providers/easypost";
import { envKey } from "./providers/http";
import { shippoProvider } from "./providers/shippo";
import { simulatedProvider } from "./providers/simulated";
import { AddressSchema, PackageSchema, parseJson, ShippingError, type Address, type Parcel, type ProviderCreds, type ShippingProvider } from "./types";

/** Provider registry + per-org connections (credentials encrypted with secure-store). */

export const PROVIDERS: Record<ShippingProvider["id"], ShippingProvider> = { simulated: simulatedProvider, easypost: easypostProvider, shippo: shippoProvider };
export const PROVIDER_IDS = ["simulated", "easypost", "shippo"] as const;
export const LIVE_PROVIDER_IDS = ["easypost", "shippo"] as const;

export function getProvider(id: string | null | undefined): ShippingProvider | null {
  return id && id in PROVIDERS ? PROVIDERS[id as ShippingProvider["id"]] : null;
}

/** Simulated carrier is for development and demos; production needs an explicit opt-in. */
export function simulatedShippingAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.NODE_ENV !== "production" || env.SHIPPING_ALLOW_SIMULATED === "true";
}

export interface ConnectionRow {
  id: string;
  user_id: string;
  provider: string;
  auth: string | null;
  ship_from: string | null;
  default_package: string | null;
  status: string;
  created_at: string;
}

export interface ConnectionView {
  id: string | null;
  provider: ShippingProvider["id"];
  label: string;
  status: "active" | "disabled" | "not_connected";
  available: boolean;
  reason: string | null;
  key_hint: string | null;
  uses_platform_key: boolean;
  ship_from: Address | null;
  default_package: Parcel | null;
}

const COLS = "id, user_id, provider, auth, ship_from, default_package, status, created_at";

async function rows(dataId: string): Promise<ConnectionRow[]> {
  if (!(await tableExists("shipping_connections"))) return [];
  return query<ConnectionRow>(`SELECT ${COLS} FROM shipping_connections WHERE user_id = $1 ORDER BY created_at ASC`, [dataId]);
}

function credsOf(row: ConnectionRow | undefined): ProviderCreds | null {
  const raw = decryptSecret(row?.auth);
  if (!raw) return null;
  const j = parseJson<{ api_key?: string }>(raw, {});
  return j.api_key ? { api_key: j.api_key } : null;
}

export interface ShippingSetup {
  provider: ShippingProvider;
  creds: ProviderCreds | null;
  ship_from: Address | null;
  default_package: Parcel | null;
}

/** Org-level settings that apply to every provider (first row carrying a ship-from address wins). */
function pickSetup(list: ConnectionRow[]): { ship_from: Address | null; default_package: Parcel | null } {
  const withFrom = list.find((r) => r.ship_from) ?? null;
  const withPkg = list.find((r) => r.default_package) ?? null;
  const from = AddressSchema.safeParse(parseJson(withFrom?.ship_from, null));
  const pkg = PackageSchema.safeParse(parseJson(withPkg?.default_package, null));
  return { ship_from: from.success ? from.data : null, default_package: pkg.success ? pkg.data : null };
}

/** Provider an org uses: explicit request, else its connected live carrier, else a dev-only key, else simulated (when allowed). */
export async function resolveShipping(dataId: string, wanted?: string | null): Promise<ShippingSetup> {
  const list = await rows(dataId);
  const setup = pickSetup(list);
  const active = list.filter((r) => r.status === "active" && r.provider !== "simulated");
  const live = (id: string) => {
    const row = active.find((r) => r.provider === id);
    const creds = credsOf(row);
    return creds ? { provider: PROVIDERS[id as ShippingProvider["id"]], creds } : null;
  };
  let chosen: { provider: ShippingProvider; creds: ProviderCreds | null } | null = null;
  if (wanted && wanted !== "simulated") {
    const p = getProvider(wanted);
    if (!p) throw new ShippingError("invalid", "Unknown carrier provider");
    chosen = live(wanted) ?? (p.configured(null) ? { provider: p, creds: null } : null);
    if (!chosen) throw new ShippingError("unavailable", p.unavailableReason());
  } else if (wanted === "simulated") {
    if (!simulatedShippingAllowed()) throw new ShippingError("unavailable", "The simulated carrier is disabled in production.");
    chosen = { provider: simulatedProvider, creds: null };
  } else {
    chosen = live("easypost") ?? live("shippo");
    if (!chosen && envKey("EASYPOST_API_KEY")) chosen = { provider: easypostProvider, creds: null };
    if (!chosen && envKey("SHIPPO_API_KEY")) chosen = { provider: shippoProvider, creds: null };
    if (!chosen && simulatedShippingAllowed()) chosen = { provider: simulatedProvider, creds: null };
    if (!chosen) throw new ShippingError("unavailable", "No carrier is connected. Connect EasyPost or Shippo under Shipping → Carriers.");
  }
  return { ...chosen, ...setup };
}

export async function listConnectionViews(dataId: string): Promise<ConnectionView[]> {
  const list = await rows(dataId);
  const setup = pickSetup(list);
  return PROVIDER_IDS.map((id): ConnectionView => {
    const p = PROVIDERS[id];
    const row = list.find((r) => r.provider === id);
    const creds = credsOf(row);
    const platform = id !== "simulated" && !creds && Boolean(envKey(id === "easypost" ? "EASYPOST_API_KEY" : "SHIPPO_API_KEY"));
    const available = id === "simulated" ? simulatedShippingAllowed() : Boolean(creds && row?.status === "active") || platform;
    return {
      id: row?.id ?? null,
      provider: id,
      label: p.label,
      status: id === "simulated" ? (available ? "active" : "disabled") : row ? (row.status === "active" ? "active" : "disabled") : "not_connected",
      available,
      reason: available ? null : id === "simulated" ? "Disabled in production (set SHIPPING_ALLOW_SIMULATED=true to allow)." : p.unavailableReason(),
      key_hint: creds?.api_key ? maskSecret(creds.api_key) : null,
      uses_platform_key: platform,
      ...setup,
    };
  });
}

export const ConnectionInputSchema = z
  .object({
    provider: z.enum(PROVIDER_IDS),
    api_key: z.string().trim().min(8).max(400).optional(),
    ship_from: AddressSchema.nullable().optional(),
    default_package: PackageSchema.nullable().optional(),
    status: z.enum(["active", "disabled"]).optional(),
  })
  .strict();
export type ConnectionInput = z.infer<typeof ConnectionInputSchema>;

/** Create or update a connection. A new api_key is encrypted; it is never returned. */
export async function saveConnection(dataId: string, input: ConnectionInput): Promise<ConnectionView[]> {
  if (input.api_key && input.provider === "simulated") throw new ShippingError("invalid", "The simulated carrier takes no credentials");
  if (input.api_key && !isEncryptionConfigured()) throw new ShippingError("unavailable", "Set CREDENTIAL_ENCRYPTION_KEY so carrier credentials can be stored encrypted.", 503);
  const existing = (await rows(dataId)).find((r) => r.provider === input.provider);
  if (!existing && input.provider !== "simulated" && !input.api_key) throw new ShippingError("invalid", "An API key is required to connect this carrier");
  const auth = input.api_key ? encryptSecret(JSON.stringify({ api_key: input.api_key })) : (existing?.auth ?? null);
  const from = input.ship_from === undefined ? (existing?.ship_from ?? null) : input.ship_from ? JSON.stringify(input.ship_from) : null;
  const pkg = input.default_package === undefined ? (existing?.default_package ?? null) : input.default_package ? JSON.stringify(input.default_package) : null;
  const status = input.status ?? existing?.status ?? "active";
  if (existing) {
    await query(`UPDATE shipping_connections SET auth = $3, ship_from = $4, default_package = $5, status = $6 WHERE id = $1 AND user_id = $2`, [existing.id, dataId, auth, from, pkg, status]);
  } else {
    await query(`INSERT INTO shipping_connections (id, user_id, provider, auth, ship_from, default_package, status) VALUES ($1, $2, $3, $4, $5, $6, $7)`, [randomUUID(), dataId, input.provider, auth, from, pkg, status]);
  }
  return listConnectionViews(dataId);
}

export async function removeConnection(dataId: string, provider: string): Promise<void> {
  await query(`DELETE FROM shipping_connections WHERE user_id = $1 AND provider = $2`, [dataId, provider]);
}

/** Credentials for a provider id when syncing/voiding an existing shipment. */
export async function credsFor(dataId: string, providerId: string): Promise<ProviderCreds | null> {
  const row = await queryOne<ConnectionRow>(`SELECT ${COLS} FROM shipping_connections WHERE user_id = $1 AND provider = $2 AND status = 'active'`, [dataId, providerId]).catch(() => null);
  return credsOf(row ?? undefined);
}

export * from "./types";
