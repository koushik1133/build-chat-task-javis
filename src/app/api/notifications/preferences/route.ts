import { NextResponse, type NextRequest } from "next/server";
import { requireScope, scopeErrorResponse } from "@/lib/auth/scope";
import { CATEGORY_LABELS, NOTIFICATION_CATEGORIES, PREF_CHANNELS, PreferencesPatchSchema, getPreferences, updatePreferences } from "@/lib/notifications/preferences";
import { channelStatus } from "@/lib/notifications/status";
import { parseJson, reportsError } from "@/lib/reports/http";

export const runtime = "nodejs";

/** GET /api/notifications/preferences — the current member's matrix, digest and quiet hours. */
export async function GET() {
  let scope;
  try {
    scope = await requireScope();
  } catch (err) {
    return scopeErrorResponse(err) ?? NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  try {
    const preferences = await getPreferences(scope.dataId, scope.userId);
    return NextResponse.json({ preferences, categories: NOTIFICATION_CATEGORIES.map((c) => ({ key: c, label: CATEGORY_LABELS[c] })), channels: PREF_CHANNELS, channel_status: channelStatus() });
  } catch (err) {
    return reportsError(err, "notifications.preferences.GET");
  }
}

/** PATCH /api/notifications/preferences — partial update for the current member. */
export async function PATCH(req: NextRequest) {
  let scope;
  try {
    scope = await requireScope();
  } catch (err) {
    return scopeErrorResponse(err) ?? NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const body = await parseJson(req, PreferencesPatchSchema);
  if (!body.ok) return body.res;
  try {
    const preferences = await updatePreferences(scope.dataId, scope.userId, body.data, scope.email);
    return NextResponse.json({ preferences });
  } catch (err) {
    return reportsError(err, "notifications.preferences.PATCH");
  }
}
