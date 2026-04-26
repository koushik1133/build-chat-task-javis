import { Octokit } from "@octokit/rest";

let _gh: Octokit | null = null;
function gh() {
  if (!_gh) _gh = new Octokit({ auth: process.env.GITHUB_TOKEN });
  return _gh;
}

export function parseRepoUrl(input: string): { owner: string; repo: string } | null {
  const trimmed = input.trim().replace(/\.git$/, "");
  const m = trimmed.match(
    /^(?:https?:\/\/github\.com\/|git@github\.com:)?([^/\s]+)\/([^/\s]+?)\/?$/
  );
  if (!m) return null;
  return { owner: m[1], repo: m[2] };
}

export async function getRepoMeta(owner: string, repo: string) {
  const { data } = await gh().repos.get({ owner, repo });
  return {
    name: data.name,
    description: data.description,
    defaultBranch: data.default_branch,
    language: data.language,
    stars: data.stargazers_count,
  };
}

export async function getFileTree(owner: string, repo: string, branch: string) {
  const { data: ref } = await gh().git.getRef({
    owner,
    repo,
    ref: `heads/${branch}`,
  });
  const { data: tree } = await gh().git.getTree({
    owner,
    repo,
    tree_sha: ref.object.sha,
    recursive: "1",
  });
  return tree.tree
    .filter((n) => n.type === "blob" && n.path)
    .map((n) => ({ path: n.path!, size: n.size ?? 0 }));
}

export async function getFile(owner: string, repo: string, path: string, ref?: string) {
  const { data } = await gh().repos.getContent({ owner, repo, path, ref });
  if (Array.isArray(data) || data.type !== "file" || !("content" in data)) {
    throw new Error(`Not a file: ${path}`);
  }
  return Buffer.from(data.content, "base64").toString("utf-8");
}

const SOURCE_EXT = /\.(ts|tsx|js|jsx|py|go|rs|java|kt|rb|php|c|cc|cpp|h|hpp|cs|swift|scala|sh|sql)$/i;

export function pickSourceFiles(
  files: { path: string; size: number }[],
  cap = 8
): { path: string; size: number }[] {
  return files
    .filter((f) => SOURCE_EXT.test(f.path) && f.size > 0 && f.size < 60_000)
    .sort((a, b) => b.size - a.size)
    .slice(0, cap);
}
