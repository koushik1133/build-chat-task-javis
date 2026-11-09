import { trackingOrigin } from "@/lib/marketing/tracking";
import { getStorefront } from "@/lib/storefront/settings";
import { getAccount, getProgram, listLedger } from "./loyalty";
import { pointsValueMinor } from "./pure";
import { getOrCreateReferralCode } from "./referrals";

/** Customer-facing rewards summary for the portal (additive `loyalty` section of getPortalData). */
export interface PortalLoyalty {
  balance: number;
  lifetime_points: number;
  tier: string | null;
  tier_perks: string | null;
  next_tier: { name: string; points_to_go: number } | null;
  value_minor_per_point: number;
  balance_value_minor: number;
  min_redeem_points: number;
  shop_slug: string | null;
  referral: { code: string; url: string | null } | null;
  history: Array<{ id: string; kind: string; points: number; note: string | null; created_at: string }>;
}

export async function portalLoyalty(dataId: string, contactId: string): Promise<PortalLoyalty | null> {
  const program = await getProgram(dataId);
  if (!program.enabled) return null;
  const account = await getAccount(dataId, contactId);
  const balance = account?.balance ?? 0;
  const lifetime = account?.lifetime_points ?? 0;
  const tiers = [...program.tiers].sort((a, b) => a.min_points - b.min_points);
  const current = tiers.filter((t) => lifetime >= t.min_points).pop() ?? null;
  const next = tiers.find((t) => t.min_points > lifetime) ?? null;
  const sf = await getStorefront(dataId).catch(() => null);
  const shopSlug = sf?.enabled ? sf.slug : null;
  const code = await getOrCreateReferralCode(dataId, contactId).catch(() => null);
  const history = account ? (await listLedger(dataId, account.id, 15)).map((e) => ({ id: e.id, kind: e.kind, points: e.points, note: e.note, created_at: e.created_at })) : [];
  return {
    balance,
    lifetime_points: lifetime,
    tier: current?.name ?? null,
    tier_perks: current?.perks ?? null,
    next_tier: next ? { name: next.name, points_to_go: next.min_points - lifetime } : null,
    value_minor_per_point: program.redeem_value_minor_per_point,
    balance_value_minor: pointsValueMinor(program, balance),
    min_redeem_points: program.min_redeem_points,
    shop_slug: shopSlug,
    referral: code ? { code, url: shopSlug ? `${trackingOrigin()}/shop/${encodeURIComponent(shopSlug)}?ref=${code}` : null } : null,
    history,
  };
}
