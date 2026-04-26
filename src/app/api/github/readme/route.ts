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
import { README_SYS } from "@/lib/prompts";

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
  const top = pickSourceFiles(tree, 6);

  // Pull a few entry-point files inline for grounding.
  const entryPaths = ["package.json", "README.md", "pyproject.toml", "go.mod"]
    .filter((p) => tree.some((t) => t.path === p))
    .slice(0, 2);
  const entries: string[] = [];
  for (const p of entryPaths) {
    try {
      const text = await getFile(owner, repo, p, meta.defaultBranch);
      entries.push(`### ${p}\n${text.slice(0, 4000)}`);
    } catch {}
  }
  for (const t of top.slice(0, 3)) {
    try {
      const text = await getFile(owner, repo, t.path, meta.defaultBranch);
      entries.push(`### ${t.path}\n${text.slice(0, 4000)}`);
    } catch {}
  }

  const treePreview = tree
    .slice(0, 80)
    .map((t) => t.path)
    .join("\n");

  const readme = await complete([
    { role: "system", content: README_SYS },
    {
      role: "user",
      content: `Repo: ${owner}/${repo}
Description: ${meta.description ?? "(none)"}
Primary language: ${meta.language ?? "(unknown)"}

## File tree (truncated)
${treePreview}

## Key files
${entries.join("\n\n")}`,
    },
  ]);

  return NextResponse.json({ repo: `${owner}/${repo}`, readme });
}
