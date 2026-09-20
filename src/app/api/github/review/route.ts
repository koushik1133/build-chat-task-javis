import { NextResponse } from "next/server";
import { z } from "zod";
import { requireUser } from "@/lib/supabase/server";
import {
  getRepoMeta,
  getFileTree,
  getFile,
  parseRepoUrl,
  pickSourceFiles,
} from "@/lib/github";
import { complete } from "@/lib/llm";
import { llmNotConfiguredResponse } from "@/lib/llm-response";
import { REVIEW_SYS } from "@/lib/prompts";

export const runtime = "nodejs";
export const maxDuration = 120;

const Body = z.object({ repoUrl: z.string().min(5) });

export async function POST(req: Request) {
  try {
    await requireUser();
  } catch {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "bad request" }, { status: 400 });

  const ref = parseRepoUrl(parsed.data.repoUrl);
  if (!ref) return NextResponse.json({ error: "invalid repo url" }, { status: 400 });
  const { owner, repo } = ref;

  let meta;
  try {
    meta = await getRepoMeta(owner, repo);
  } catch (e) {
    console.error("[github/review] repo lookup failed:", e);
    return NextResponse.json({ error: "Could not access that GitHub repository" }, { status: 400 });
  }
  const tree = await getFileTree(owner, repo, meta.defaultBranch);
  // Limit to 3 files max; truncate each to ~1 500 chars to stay within TPM limits.
  const targets = pickSourceFiles(tree, 3);

  const reviews: { path: string; review: string }[] = [];
  for (const t of targets) {
    const raw = await getFile(owner, repo, t.path, meta.defaultBranch);
    const content = raw.slice(0, 1500);
    let review: string;
    try {
      review = await complete([
        { role: "system", content: REVIEW_SYS },
        { role: "user", content: `File: ${t.path}\n\n${content}` },
      ]);
    } catch (err) {
      const notConfigured = llmNotConfiguredResponse(err);
      if (notConfigured) return notConfigured;
      console.error("[github/review] LLM call failed:", err);
      return NextResponse.json({ error: "AI review failed. Please try again." }, { status: 502 });
    }
    reviews.push({ path: t.path, review });
  }

  return NextResponse.json({ repo: `${owner}/${repo}`, meta, reviews });
}
