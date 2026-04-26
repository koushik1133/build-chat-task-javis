"use client";

import { useState } from "react";
import { Loader2, Github, ScanSearch, FileText } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Markdown } from "@/components/markdown";

type Mode = "review" | "readme";

export function GithubPanel() {
  const [url, setUrl] = useState("https://github.com/koushik1133/jarvis");
  const [mode, setMode] = useState<Mode>("review");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [output, setOutput] = useState<string>("");

  async function run() {
    setLoading(true);
    setError(null);
    setOutput("");
    try {
      const res = await fetch(`/api/github/${mode}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ repoUrl: url }),
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error ?? `HTTP ${res.status}`);
      if (mode === "readme") {
        setOutput(j.readme ?? "");
      } else {
        const blocks = (j.reviews as { path: string; review: string }[]).map(
          (r) => `### \`${r.path}\`\n\n${r.review}`
        );
        setOutput(blocks.join("\n\n---\n\n"));
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="space-y-5">
      <div className="card-glow rounded-xl p-5">
        <div className="mb-3 flex items-center gap-2 text-sm font-semibold">
          <Github className="h-4 w-4" /> GitHub repo
        </div>
        <Input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://github.com/owner/repo"
          className="mb-3"
        />
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant={mode === "review" ? "default" : "secondary"}
            size="sm"
            onClick={() => setMode("review")}
          >
            <ScanSearch className="h-3.5 w-3.5" /> Code review
          </Button>
          <Button
            variant={mode === "readme" ? "default" : "secondary"}
            size="sm"
            onClick={() => setMode("readme")}
          >
            <FileText className="h-3.5 w-3.5" /> Generate README
          </Button>
          <div className="flex-1" />
          <Button onClick={run} disabled={loading || !url.trim()}>
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : "Run"}
          </Button>
        </div>
        {error && <p className="mt-3 text-xs text-destructive">{error}</p>}
      </div>

      {output && (
        <div className="card-glow rounded-xl p-5">
          <Markdown>{output}</Markdown>
        </div>
      )}
    </div>
  );
}
