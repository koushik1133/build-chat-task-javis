import { NextResponse } from "next/server";
import { requireUser } from "@/lib/supabase/server";
import { loadChannelSnapshot } from "@/lib/channels/channel-data";
import { toChannelId } from "@/lib/channels/registry";

export const runtime = "nodejs";

/** GET /api/channels/<channel>/summary — counts for one of the caller's channels. */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ channel: string }> }
) {
  let user;
  try { ({ user } = await requireUser()); }
  catch { return NextResponse.json({ error: "unauthorized" }, { status: 401 }); }

  const { channel } = await params;
  const channelId = toChannelId(channel);
  if (!channelId) {
    return NextResponse.json({ error: "Unknown channel" }, { status: 404 });
  }

  const snapshot = await loadChannelSnapshot(user.id, channelId);
  if (!snapshot) return NextResponse.json({ error: "Unknown channel" }, { status: 404 });

  return NextResponse.json({
    channel: snapshot.channel.id,
    label: snapshot.channel.label,
    connectedAccounts: snapshot.accounts.length,
    counts: snapshot.counts,
  });
}
