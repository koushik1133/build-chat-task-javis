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
  const parsed = Body.safeParse(await req.json());
  if (!parsed.success) return NextResponse.json({ error: "bad request" }, { status: 400 });

  const ref = parseRepoUrl(parsed.data.repoUrl);
  if (!ref) return NextResponse.json({ error: "invalid repo url" }, { status: 400 });
  const { owner, repo } = ref;

  let meta;
  try {
    meta = await getRepoMeta(owner, repo);
  } catch (e) {
    return NextResponse.json(
      { error: `github: ${(e as Error).message}` },
      { status: 400 }
    );
  }
  const tree = await getFileTree(owner, repo, meta.defaultBranch);
  const targets = pickSourceFiles(tree, 5);

  const reviews: { path: string; review: string }[] = [];
  for (const t of targets) {
    const content = await getFile(owner, repo, t.path, meta.defaultBranch);
    const review = await complete([
      { role: "system", content: REVIEW_SYS },
      { role: "user", content: `File: ${t.path}\n\n${content}` },
    ]);
    reviews.push({ path: t.path, review });
  }

  return NextResponse.json({ repo: `${owner}/${repo}`, meta, reviews });
}
