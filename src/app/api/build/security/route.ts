import { NextResponse } from "next/server";
import { z } from "zod";
import { requireScope, scopeErrorResponse } from "@/lib/auth/scope";
import { completeJson } from "@/lib/llm";
import { llmNotConfiguredResponse } from "@/lib/llm-response";
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
  let scope;
  try {
    scope = await requireScope({ area: "sites", edit: true });
  } catch (err) {
    return scopeErrorResponse(err) ?? NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success)
    return NextResponse.json({ error: "bad request" }, { status: 400 });

  const site = await queryOne<{ html: string }>(
    "SELECT html FROM sites WHERE id = $1 AND user_id = $2",
    [parsed.data.siteId, scope.dataId]
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
  } catch (err) {
    const notConfigured = llmNotConfiguredResponse(err);
    if (notConfigured) return notConfigured;
    return NextResponse.json({ issues: [] });
  }
  return NextResponse.json({ issues: result?.issues ?? [] });
}
