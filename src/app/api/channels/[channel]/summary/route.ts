import { NextResponse } from "next/server";
import { requireScope, scopeErrorResponse } from "@/lib/auth/scope";
import { loadChannelSnapshot } from "@/lib/channels/channel-data";
import { toChannelId } from "@/lib/channels/registry";

export const runtime = "nodejs";

/** GET /api/channels/<channel>/summary — counts for one of the caller's channels. */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ channel: string }> }
) {
  let scope;
  try { scope = await requireScope({ area: "messaging", edit: false }); }
  catch (err) { return scopeErrorResponse(err) ?? NextResponse.json({ error: "unauthorized" }, { status: 401 }); }

  const { channel } = await params;
  const channelId = toChannelId(channel);
  if (!channelId) {
    return NextResponse.json({ error: "Unknown channel" }, { status: 404 });
  }

  const snapshot = await loadChannelSnapshot(scope.dataId, channelId);
  if (!snapshot) return NextResponse.json({ error: "Unknown channel" }, { status: 404 });

  return NextResponse.json({
    channel: snapshot.channel.id,
    label: snapshot.channel.label,
    connectedAccounts: snapshot.accounts.length,
    counts: snapshot.counts,
  });
}
