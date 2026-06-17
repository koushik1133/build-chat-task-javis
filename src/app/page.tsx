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
  Bot,
  Zap,
  Kanban,
  Briefcase,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { createClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";
import { KERNELHUB_NAME, KERNELHUB_TAGLINE } from "@/lib/brand";

const GITHUB_REPO = "https://github.com/koushik1133/build-chat-task-javis";

export default async function Landing() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (user) redirect("/chat");

  return (
    <main className="relative min-h-screen overflow-hidden">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(60%_60%_at_50%_0%,hsl(25_95%_53%_/_0.12),transparent_70%)]" />

      <header className="relative z-10 flex items-center justify-between px-4 py-5 sm:px-8">
        <div className="flex items-center gap-2">
          <div className="flex h-8 w-8 items-center justify-center rounded-md bg-primary/15">
            <Sparkles className="h-4 w-4 text-primary" />
          </div>
          <span className="text-sm font-semibold">{KERNELHUB_NAME}</span>
        </div>
        <div className="flex items-center gap-3">
          <Button asChild size="sm" variant="ghost">
            <Link href={GITHUB_REPO} target="_blank">
              GitHub
            </Link>
          </Button>
          <Button asChild size="sm">
            <Link href="/login">Sign in</Link>
          </Button>
        </div>
      </header>

      <section className="relative z-10 mx-auto max-w-4xl px-4 pt-16 text-center sm:px-6 sm:pt-20">
        <div className="mb-4 inline-flex items-center gap-2 rounded-full border border-border bg-card/40 px-3 py-1 text-xs text-muted-foreground">
          <span className="h-1.5 w-1.5 rounded-full bg-primary animate-pulse" />
          End-to-end AI workspace · Cloud Run + Aurora DSQL
        </div>
        <h1 className="text-4xl font-semibold tracking-tight sm:text-5xl lg:text-6xl">
          <span className="gradient-text">{KERNELHUB_NAME}</span>
        </h1>
        <p className="mx-auto mt-5 max-w-2xl text-base text-muted-foreground sm:text-lg">
          {KERNELHUB_TAGLINE} Chat with your data, run production boards, deploy AI agents,
          automate workflows, build strategy docs, and launch sites — all in one place.
        </p>
        <div className="mt-8 flex flex-col items-center gap-3 sm:flex-row sm:justify-center">
          <Button asChild size="lg">
            <Link href="/login">
              Get started free <ArrowRight className="ml-1 h-4 w-4" />
            </Link>
          </Button>
          <Button asChild size="lg" variant="outline">
            <Link href={GITHUB_REPO} target="_blank">
              View on GitHub
            </Link>
          </Button>
        </div>
      </section>

      <section className="relative z-10 mt-16 flex justify-center px-4">
        <div className="flex flex-wrap items-center justify-center gap-3 rounded-2xl border border-border bg-card/50 px-4 py-4 backdrop-blur-sm sm:px-6">
          <StackBadge label="Aurora DSQL" color="text-orange-400" dot />
          <Divider />
          <StackBadge label="Cloud Run" color="text-foreground" dot />
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

      <section className="relative z-10 mx-auto mt-16 grid max-w-5xl grid-cols-1 gap-4 px-4 sm:grid-cols-2 sm:px-6 lg:grid-cols-3">
        <Feature
          icon={MessageSquare}
          title="AI Chat & RAG"
          body="Streaming answers grounded in your uploaded files. Semantic search pulls the right context every time."
        />
        <Feature
          icon={Kanban}
          title="Production board"
          body="Customizable Kanban with human-in-the-loop approvals, priorities, and pipeline metrics."
        />
        <Feature
          icon={Bot}
          title="AI Agents"
          body="Deploy pre-built or custom agents with role-specific prompts and run history."
        />
        <Feature
          icon={Zap}
          title="Automations"
          body="Scheduled and event-driven workflows — Slack, email, notifications, and task creation."
        />
        <Feature
          icon={Briefcase}
          title="Strategy Hub"
          body="AI-generated business strategy documents tailored to your company profile."
        />
        <Feature
          icon={Wand2}
          title="AI Studio"
          body="Generate full production websites from a prompt. Refine, version, and publish."
        />
        <Feature
          icon={FileText}
          title="File knowledge base"
          body="Drop PDFs, code, and docs — chunked, embedded, and retrieved per query."
        />
        <Feature
          icon={Github}
          title="GitHub review"
          body="Paste a repo URL and get an AI code review with a generated README in seconds."
        />
        <Feature
          icon={ListTodo}
          title="Tasks & analytics"
          body="Auto-extracted tasks from chats plus live metrics across sites, agents, and production."
        />
      </section>

      <section className="relative z-10 mx-auto mt-16 max-w-5xl px-4 sm:px-6">
        <div className="rounded-2xl border border-border bg-card/60 p-6 backdrop-blur-sm sm:p-8">
          <h2 className="mb-1 text-lg font-semibold">Production-ready architecture</h2>
          <p className="mb-6 text-sm text-muted-foreground">
            Each data layer is chosen for its workload — not convenience.
          </p>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <ArchBlock
              label="Aurora DSQL"
              color="border-orange-400/40 bg-orange-400/5"
              dot="bg-orange-400"
              items={["Users, chats, tasks, boards", "Agents & automations metadata", "ACID relational consistency"]}
            />
            <ArchBlock
              label="Supabase Auth"
              color="border-emerald-400/40 bg-emerald-400/5"
              dot="bg-emerald-400"
              items={["Password & OAuth sign-in", "Magic link support", "Secure session cookies"]}
            />
            <ArchBlock
              label="Pinecone"
              color="border-violet-400/40 bg-violet-400/5"
              dot="bg-violet-400"
              items={["Text embeddings per user", "Namespaced vector index", "Semantic RAG retrieval"]}
            />
          </div>
        </div>
      </section>

      <section className="relative z-10 mx-auto mt-12 grid max-w-5xl grid-cols-2 gap-4 px-4 pb-24 sm:grid-cols-4 sm:px-6">
        <Metric value="10+" label="Integrated modules" />
        <Metric value="RAG" label="File-grounded chat" />
        <Metric value="HITL" label="Approval workflows" />
        <Metric value="Cloud Run" label="Deployed on" />
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
  return <span className="hidden h-4 w-px bg-border sm:block" />;
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
