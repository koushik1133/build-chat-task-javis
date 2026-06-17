import { NextResponse } from "next/server";
import { z } from "zod";
import { requireUser } from "@/lib/supabase/server";
import { completeJson } from "@/lib/llm";
import { SECURITY_REVIEW_SYS } from "@/lib/build-prompts";
import { queryOne } from "@/lib/dsql";

export const runtime = "nodejs";
export const maxDuration = 30;

const Body = z.object({ siteId: z.string().uuid() });

type Issue = {
  severity: "low" | "medium" | "high";
  title: string;
  explain: string;
  fix: string;
};

export async function POST(req: Request) {
  let user;
  try {
    ({ user } = await requireUser());
  } catch {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const parsed = Body.safeParse(await req.json());
  if (!parsed.success)
    return NextResponse.json({ error: "bad request" }, { status: 400 });

  const site = await queryOne<{ html: string }>(
    "SELECT html FROM sites WHERE id = $1 AND user_id = $2",
    [parsed.data.siteId, user.id]
  );
  if (!site)
    return NextResponse.json({ error: "site not found" }, { status: 404 });

  let result: { issues: Issue[] } | null = null;
  try {
    result = await completeJson<{ issues: Issue[] }>(
      [
        { role: "system", content: SECURITY_REVIEW_SYS },
        { role: "user", content: site.html as string },
      ],
      `{"issues":[{"severity":"low|medium|high","title":string,"explain":string,"fix":string}]}`
    );
  } catch {
    return NextResponse.json({ issues: [] });
  }
  return NextResponse.json({ issues: result?.issues ?? [] });
}
