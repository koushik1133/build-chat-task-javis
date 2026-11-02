import { NextResponse } from "next/server";
import { z } from "zod";
import { requireScope, scopeErrorResponse } from "@/lib/auth/scope";
import { dbUnavailableResponse } from "@/lib/api-db";
import { getOrgSettings, updateOrgSettings } from "@/lib/org-settings";
import { LOCALES, LOCALE_LABELS } from "@/lib/i18n";
import { CURRENCIES, isCurrencyCode, isValidTimeZone } from "@/lib/i18n/format";

export const dynamic = "force-dynamic";

const Patch = z
  .object({
    locale: z.enum(LOCALES).optional(),
    currency: z
      .string()
      .trim()
      .length(3)
      .transform((s) => s.toUpperCase())
      .refine(isCurrencyCode, "unsupported currency")
      .optional(),
    timezone: z.string().trim().min(1).max(64).refine(isValidTimeZone, "unknown timezone").optional(),
  })
  .strict();

function options() {
  return {
    locales: LOCALES.map((code) => ({ code, label: LOCALE_LABELS[code] })),
    currencies: CURRENCIES.map((c) => ({ code: c.code, symbol: c.symbol, name: c.name, minorDigits: c.minorDigits })),
  };
}

/** GET /api/orgs/settings — org locale / currency / timezone plus the pick-lists. */
export async function GET() {
  let scope;
  try {
    scope = await requireScope({ area: "settings" });
  } catch (err) {
    return scopeErrorResponse(err) ?? NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  try {
    const settings = await getOrgSettings(scope.dataId);
    return NextResponse.json({ settings, ...options(), canEdit: scope.can("settings", true) });
  } catch (err) {
    return dbUnavailableResponse(err, "orgs/settings");
  }
}

/** PATCH /api/orgs/settings — owner/admin only (settings area, edit). */
export async function PATCH(req: Request) {
  let scope;
  try {
    scope = await requireScope({ area: "settings", edit: true });
  } catch (err) {
    return scopeErrorResponse(err) ?? NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const parsed = Patch.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "bad request", issues: parsed.error.issues }, { status: 400 });
  }
  try {
    const settings = await updateOrgSettings(scope.dataId, parsed.data);
    return NextResponse.json({ settings });
  } catch (err) {
    return dbUnavailableResponse(err, "orgs/settings");
  }
}
