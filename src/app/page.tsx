import Link from "next/link";
import { Sparkles, FileText, Github, Database, Zap } from "lucide-react";
import { Button } from "@/components/ui/button";
import { createClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";

export default async function Landing() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (user) redirect("/chat");

  return (
    <main className="relative min-h-screen overflow-hidden">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(60%_60%_at_50%_0%,hsl(263_70%_60%_/_0.18),transparent_70%)]" />

      <header className="relative z-10 flex items-center justify-between px-8 py-5">
        <div className="flex items-center gap-2">
          <div className="flex h-8 w-8 items-center justify-center rounded-md bg-primary/15">
            <Sparkles className="h-4 w-4 text-primary" />
          </div>
          <span className="text-sm font-semibold">Javis</span>
        </div>
        <Button asChild size="sm">
          <Link href="/login">Sign in</Link>
        </Button>
      </header>

      <section className="relative z-10 mx-auto max-w-4xl px-6 pt-20 text-center">
        <div className="mb-4 inline-flex items-center gap-2 rounded-full border border-border bg-card/40 px-3 py-1 text-xs text-muted-foreground">
          <span className="h-1.5 w-1.5 rounded-full bg-primary animate-pulse" />
          AI dev co-pilot, grounded in your code
        </div>
        <h1 className="text-5xl font-semibold tracking-tight sm:text-6xl">
          A <span className="gradient-text">Jarvis</span> for developers.
        </h1>
        <p className="mx-auto mt-5 max-w-xl text-base text-muted-foreground">
          Chat with an AI that actually knows your files. Upload code, PDFs, and notes —
          Javis retrieves what matters and writes alongside you.
        </p>
        <div className="mt-8 flex justify-center gap-3">
          <Button asChild size="lg">
            <Link href="/login">Get started</Link>
          </Button>
          <Button asChild size="lg" variant="outline">
            <Link href="https://github.com/koushik1133/jarvis" target="_blank">
              View on GitHub
            </Link>
          </Button>
        </div>
      </section>

      <section className="relative z-10 mx-auto mt-24 grid max-w-5xl grid-cols-1 gap-4 px-6 pb-24 sm:grid-cols-2 lg:grid-cols-4">
        <Feature icon={Zap} title="Streaming chat" body="Token-by-token responses with full markdown + code highlighting." />
        <Feature icon={FileText} title="RAG over files" body="Drop in PDFs, code, notes — chunked, embedded, retrieved per query." />
        <Feature icon={Github} title="GitHub review" body="Paste a repo URL → AI code review and auto-generated README." />
        <Feature icon={Database} title="Persistent memory" body="Supabase Postgres + RLS keeps every chat, file, and task isolated to you." />
      </section>
    </main>
  );
}

function Feature({
  icon: Icon,
  title,
  body,
}: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  body: string;
}) {
  return (
    <div className="card-glow rounded-xl p-5">
      <Icon className="mb-2 h-5 w-5 text-primary" />
      <h3 className="text-sm font-semibold">{title}</h3>
      <p className="mt-1 text-xs text-muted-foreground">{body}</p>
    </div>
  );
}
