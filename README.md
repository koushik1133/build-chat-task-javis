# Javis — AI Personal Project Assistant

A Jarvis for developers. Chat with an LLM grounded in your uploaded files (RAG), review GitHub repos, auto-extract tasks from conversations, and keep history per user.

> Stack: **Next.js 15 + TypeScript** · **Supabase** (auth + Postgres + storage) · **Pinecone** (vector RAG, hosted embeddings) · **Grok via xAI** (swappable to Claude) · **Octokit** for GitHub · **Vercel** for deploy.

---

## What's in here

| Path | What it does |
|---|---|
| `src/app/(app)/...` | Authed pages: `chat`, `files`, `github`, `tasks` |
| `src/app/api/chat` | Streaming chat: pulls history + RAG hits, calls LLM, persists turns |
| `src/app/api/files` | Upload → extract → chunk → embed → upsert to Pinecone |
| `src/app/api/github/{review,readme}` | Repo intake + AI review / README generation |
| `src/app/api/tasks` | CRUD for auto-extracted tasks |
| `src/lib/llm.ts` | Provider abstraction (Grok now, Claude later — flip `LLM_PROVIDER`) |
| `src/lib/pinecone.ts` | Hosted embeddings via integrated inference |
| `src/lib/supabase/*` | SSR + browser + middleware Supabase clients |
| `supabase/schema.sql` | All tables, RLS policies, storage bucket |

---

## Setup (one-time)

### 1. Install
```bash
cd ~/Desktop/JAvis
npm install
```

### 2. Create accounts (free tiers)
- **Supabase** → https://supabase.com → new project. Copy the URL + the **publishable** key + the **service_role** key from Project Settings → API.
- **Pinecone** → https://app.pinecone.io → grab your API key. (Index is auto-created on first upload.)
- **xAI** → https://console.x.ai → API key.
- **GitHub** → https://github.com/settings/tokens?type=beta → fine-grained PAT, **Public repos: read** scope is enough.

### 3. Configure env
```bash
cp .env.example .env.local
# then fill in the real values — never commit .env.local
```

### 4. Apply Supabase schema
Open Supabase → SQL Editor → paste `supabase/schema.sql` → Run.

### 5. Enable an auth provider
Supabase → Authentication → Providers:
- **Email** is on by default (magic link works immediately).
- **Google** (optional): set client id/secret per Supabase docs.

Authentication → URL Configuration → add `http://localhost:3000/auth/callback` to redirect URLs.

### 6. Run
```bash
npm run dev
# open http://localhost:3000
```

---

## How a chat turn flows

```
user types ────────────────────► /api/chat (POST)
                                      │
                                      ▼
                           Supabase: ensure chat row,
                           insert user message
                                      │
                       ┌──────────────┴──────────────┐
                       ▼                             ▼
              Postgres: last 10 msgs        Pinecone: top-K chunks
                       │                             │
                       └──────────────┬──────────────┘
                                      ▼
                          build prompt + call Grok (stream)
                                      │
                  ┌───────────────────┼────────────────────┐
                  ▼                   ▼                    ▼
        stream tokens to       on completion:        background:
            browser            insert assistant       extract tasks
                               message + bump          → tasks table
                               chats.updated_at
```

---

## Deploy to Vercel

```bash
# After pushing to https://github.com/koushik1133/jarvis :
# 1. Vercel → Add New Project → import the repo
# 2. Add the same env vars from .env.local in Vercel project settings
# 3. Update Supabase redirect URL to https://<your-vercel-url>/auth/callback
# 4. Deploy
```

---

## Swapping Grok → Claude later

When you have an Anthropic key:
1. `npm install @anthropic-ai/sdk`
2. In `src/lib/llm.ts`, branch on `provider === "anthropic"` and return an Anthropic client wrapper that exposes the same `streamChat / complete / completeJson` shape.
3. Set `LLM_PROVIDER=anthropic` and `ANTHROPIC_API_KEY=...`. No callers change.

The seam is intentional: every API route imports `streamChat / complete` from `@/lib/llm` and never sees the underlying SDK.

---

## Resume bullet → reality map

| Resume claim | Where it lives |
|---|---|
| Full-stack: Lovable + Stitch frontend, Node backend on Railway, Vercel deploy | Next.js (TS + Tailwind, designed in Stitch/Dribbble style) on Vercel — Node API routes are the backend |
| RAG with Pinecone, semantic search over PDFs/code/notes | `src/lib/pinecone.ts`, `src/lib/chunk.ts`, `src/app/api/files/route.ts` |
| Supabase auth + Postgres for chat history, files, tasks | `supabase/schema.sql`, `src/lib/supabase/*` |
| GitHub integration for code review + README generation | `src/lib/github.ts`, `src/app/api/github/{review,readme}` |
| Document ingestion → embedding → retrieval → AI response | upload route → chunk → upsertRecords (hosted embed) → searchRecords on each chat |

---

## Troubleshooting

- **"unauthorized" on every API call** → cookies aren't reaching the server. Make sure `NEXT_PUBLIC_SUPABASE_URL/ANON_KEY` are set in `.env.local` and you're signed in.
- **Pinecone errors on first upload** → the index is auto-created with `multilingual-e5-large` in `us-east-1`. If you want a different region/model, edit `src/lib/pinecone.ts` (`ensureIndex`).
- **PDFs fail to parse** → some PDFs are scanned images. Convert with `pdftotext` first or upload a `.txt`.
- **GitHub 404 on private repos** → your PAT needs `repo` scope; for fine-grained PATs you must explicitly grant the repo.
