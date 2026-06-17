import { NextResponse } from "next/server";
import { requireUser } from "@/lib/supabase/server";
import { getRecentAgentRuns } from "@/lib/agent-runner";

export async function GET() {
  let user;
  try { ({ user } = await requireUser()); }
  catch { return NextResponse.json({ error: "unauthorized" }, { status: 401 }); }

  const runs = await getRecentAgentRuns(user.id, 30);
  return NextResponse.json({ runs });
}
