import { GithubPanel } from "@/components/github-panel";

export default function GithubPage() {
  return (
    <div className="h-full overflow-y-auto px-8 py-8">
      <div className="mx-auto max-w-3xl">
        <h1 className="text-2xl font-semibold tracking-tight">GitHub</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Paste any public repo URL. Javis can review the largest source files or generate a README.
        </p>
        <div className="mt-8">
          <GithubPanel />
        </div>
      </div>
    </div>
  );
}
