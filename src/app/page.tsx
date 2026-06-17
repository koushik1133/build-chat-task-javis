import Link from "next/link";
import {
  Sparkles,
  FileText,
  Github,
  Database,
  MessageSquare,
  Wand2,
  ListTodo,
  ArrowRight,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { createClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";
import { KERNELHUB_TAGLINE } from "@/lib/brand";

export default async function Landing() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (user) redirect("/chat");

  return (
    <main className="relative min-h-screen overflow-hidden">
      {/* background glow */}
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(60%_60%_at_50%_0%,hsl(263_70%_60%_/_0.18),transparent_70%)]" />

      {/* header */}
      <header className="relative z-10 flex items-center justify-between px-8 py-5">
        <div className="flex items-center gap-2">
          <div className="flex h-8 w-8 items-center justify-center rounded-md bg-primary/15">
            <Sparkles className="h-4 w-4 text-primary" />
          </div>
          <span className="text-sm font-semibold tracking-tight">
            Kernel<span className="text-primary">Hub</span>
          </span>
        </div>
        <div className="flex items-center gap-3">
          <Button asChild size="sm" variant="ghost">
            <Link href="https://github.com/koushik1133/jarvis" target="_blank">
              GitHub
            </Link>
          </Button>
          <Button asChild size="sm">
            <Link href="/login">Sign in</Link>
          </Button>
        </div>
      </header>

      {/* hero */}
      <section className="relative z-10 mx-auto max-w-4xl px-6 pt-20 text-center">
        <div className="mb-4 inline-flex items-center gap-2 rounded-full border border-border bg-card/40 px-3 py-1 text-xs text-muted-foreground">
          <span className="h-1.5 w-1.5 rounded-full bg-primary animate-pulse" />
          {KERNELHUB_TAGLINE}
        </div>
        <h1 className="text-5xl font-semibold tracking-tight sm:text-6xl">
          <span className="gradient-text">KernelHub</span>
        </h1>
        <p className="mx-auto mt-5 max-w-2xl text-base text-muted-foreground">
          Chat, production boards, AI agents, and automations in one place — from strategy
          to execution, built for teams that run on modern cloud infrastructure.
        </p>
        <div className="mt-8 flex flex-col items-center gap-3 sm:flex-row sm:justify-center">
          <Button asChild size="lg">
            <Link href="/login">
              Get started free <ArrowRight className="ml-1 h-4 w-4" />
            </Link>
          </Button>
          <Button asChild size="lg" variant="outline">
            <Link href="https://github.com/koushik1133/jarvis" target="_blank">
              View on GitHub
            </Link>
          </Button>
        </div>
      </section>

      {/* stack badge strip */}
      <section className="relative z-10 mt-16 flex justify-center">
        <div className="flex flex-wrap items-center justify-center gap-3 rounded-2xl border border-border bg-card/50 px-6 py-4 backdrop-blur-sm">
          <StackBadge label="AWS DynamoDB" color="text-orange-400" dot />
          <Divider />
          <StackBadge label="Vercel" color="text-foreground" dot />
          <Divider />
          <StackBadge label="Next.js 15" color="text-foreground" dot />
          <Divider />
          <StackBadge label="Supabase Auth" color="text-emerald-400" dot />
          <Divider />
          <StackBadge label="Pinecone RAG" color="text-violet-400" dot />
          <Divider />
          <StackBadge label="Groq LLM" color="text-sky-400" dot />
        </div>
      </section>

      {/* features grid */}
      <section className="relative z-10 mx-auto mt-16 grid max-w-5xl grid-cols-1 gap-4 px-6 sm:grid-cols-2 lg:grid-cols-3">
        <Feature
          icon={MessageSquare}
          title="Streaming RAG chat"
          body="Token-by-token answers grounded in your uploaded files. Context pulled from Pinecone vector search."
        />
        <Feature
          icon={FileText}
          title="File knowledge base"
          body="Drop PDFs, code, docs — chunked, embedded, retrieved per query. Your codebase becomes the context."
        />
        <Feature
          icon={Github}
          title="GitHub code review"
          body="Paste a repo URL and get an AI code review with a generated README in seconds."
        />
        <Feature
          icon={ListTodo}
          title="Auto task extraction"
          body="Every chat is scanned for actionable items. Tasks surface in a dedicated board automatically."
        />
        <Feature
          icon={Wand2}
          title="AI site builder"
          body="Generate a full production website from a prompt. Refine, version, publish to GitHub Pages or Vercel."
        />
        <Feature
          icon={Database}
          title="AWS DynamoDB backend"
          body="Chat messages and site analytics stored in DynamoDB — partition key per chat or site for sub-millisecond reads at any scale."
        />
      </section>

      {/* architecture callout */}
      <section className="relative z-10 mx-auto mt-16 max-w-5xl px-6">
        <div className="rounded-2xl border border-border bg-card/60 p-8 backdrop-blur-sm">
          <h2 className="mb-1 text-lg font-semibold">Production-ready architecture</h2>
          <p className="mb-6 text-sm text-muted-foreground">
            Each data layer is chosen for its workload — not convenience.
          </p>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <ArchBlock
              label="AWS DynamoDB"
              color="border-orange-400/40 bg-orange-400/5"
              dot="bg-orange-400"
              items={["Chat messages (append-only, PK=chatId)", "Site page-view events (PK=siteId)", "Sub-ms reads at any throughput"]}
            />
            <ArchBlock
              label="Supabase Postgres"
              color="border-emerald-400/40 bg-emerald-400/5"
              dot="bg-emerald-400"
              items={["User accounts + RLS auth", "Chat / task / site metadata", "ACID relational consistency"]}
            />
            <ArchBlock
              label="Pinecone"
              color="border-violet-400/40 bg-violet-400/5"
              dot="bg-violet-400"
              items={["768-dim text embeddings", "Per-user namespaced index", "Semantic RAG retrieval"]}
            />
          </div>
        </div>
      </section>

      {/* metrics row */}
      <section className="relative z-10 mx-auto mt-12 grid max-w-5xl grid-cols-2 gap-4 px-6 pb-24 sm:grid-cols-4">
        <Metric value="< 200 ms" label="DynamoDB p99 read" />
        <Metric value="∞" label="Chat message scale" />
        <Metric value="5" label="RAG context chunks" />
        <Metric value="Vercel" label="Deployed on" />
      </section>
    </main>
  );
}

function StackBadge({ label, color, dot }: { label: string; color: string; dot?: boolean }) {
  return (
    <span className={`flex items-center gap-1.5 text-xs font-medium ${color}`}>
      {dot && <span className={`h-1.5 w-1.5 rounded-full ${color.replace("text-", "bg-")}`} />}
      {label}
    </span>
  );
}

function Divider() {
  return <span className="h-4 w-px bg-border" />;
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

function ArchBlock({
  label,
  color,
  dot,
  items,
}: {
  label: string;
  color: string;
  dot: string;
  items: string[];
}) {
  return (
    <div className={`rounded-xl border p-4 ${color}`}>
      <div className="mb-3 flex items-center gap-2">
        <span className={`h-2 w-2 rounded-full ${dot}`} />
        <span className="text-sm font-semibold">{label}</span>
      </div>
      <ul className="space-y-1.5">
        {items.map((item) => (
          <li key={item} className="text-xs text-muted-foreground">
            · {item}
          </li>
        ))}
      </ul>
    </div>
  );
}

function Metric({ value, label }: { value: string; label: string }) {
  return (
    <div className="card-glow rounded-xl p-5 text-center">
      <div className="text-2xl font-bold">{value}</div>
      <div className="mt-1 text-xs text-muted-foreground">{label}</div>
    </div>
  );
}

