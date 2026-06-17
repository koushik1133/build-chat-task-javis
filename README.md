# Javis — AI Personal Project Assistant

A full-stack AI workspace for developers and teams: chat with RAG over your files, review GitHub repos, run automations on a schedule, manage production Kanban, generate landing pages, and more.

**Live:** https://javis-xtmerz2lha-uc.a.run.app

**Stack:** Next.js 15 · TypeScript · Supabase (auth + file storage) · Aurora DSQL (metadata) · DynamoDB (messages + analytics) · Pinecone (RAG) · Groq LLM · Cloud Run

---

## Quick start

```bash
cd build-chat-task-javis
npm install
cp .env.example .env.local   # fill in real values
npm run migrate              # Aurora DSQL (first time)
npm run dev                  # http://localhost:3001
```

See `LAUNCH_CHECKLIST.md` for Supabase, AWS, Pinecone, and production setup.

---

## Architecture

```
Browser (React)
    │
    ▼
Next.js App Router ── middleware (Supabase session refresh)
    │
    ├── Server Components / API Routes
    │
    ├── Supabase Auth (sessions, OAuth, magic link)
    ├── Supabase Storage (uploaded file blobs)
    │
    ├── Aurora DSQL (Postgres-compatible)
    │     chats, tasks, files meta, sites, automations,
    │     agents, strategies, production board, integrations…
    │
    ├── DynamoDB
    │     chat messages (high write volume)
    │     site page-view analytics
    │
    ├── Pinecone (vector RAG, per-user namespace)
    ├── Groq (llama-3.3-70b-versatile)
    ├── GitHub API (repo review, site publish)
    └── Resend + Slack webhooks (automations)
```

---

## Features — how they work

Each section covers **what the user sees**, **where the code lives**, **what stores data**, and **the request flow**.

### Authentication

| | |
|---|---|
| **Pages** | `/login`, `/auth/callback` |
| **API** | `GET /api/auth/session`, `POST /api/auth/signout` |
| **Code** | `src/app/login/page.tsx`, `src/app/auth/callback/route.ts`, `src/lib/supabase/*`, `middleware.ts` |
| **Storage** | Supabase Auth (JWT in HTTP-only cookies) |

**How it works**

1. Middleware (`src/lib/supabase/middleware.ts`) runs on every request. Public paths (`/`, `/login`, `/auth/*`, `/api/*`) pass through; everything else requires a session cookie or redirects to `/login?next=…`.
2. **Password sign-in** — client calls `supabase.auth.signInWithPassword`; session cookies are set in the browser; `onAuthStateChange` confirms via `/api/auth/session` then navigates to `/chat`.
3. **Google OAuth** — client calls `signInWithOAuth({ provider: "google", redirectTo: …/auth/callback })`. Google → Supabase → `/auth/callback?code=…`. The callback route (`cookies()` + `redirect()`) exchanges the code for a session and redirects to `/chat`.
4. **Magic link** — `signInWithOtp` sends an email (via Supabase). Clicking the link hits the same `/auth/callback` flow.
5. **Sign-out** — client `signOut()` + `POST /api/auth/signout` clears all `sb-*` cookies.

Production runs on Cloud Run; the callback uses `x-forwarded-host` and relative `redirect()` so sessions are never sent to `0.0.0.0:8080`.

---

### Onboarding

| | |
|---|---|
| **Page** | `/onboarding` |
| **API** | `POST /api/onboarding` |
| **Code** | `src/app/onboarding/page.tsx` |
| **Storage** | Aurora DSQL — `business_profile`, `board_configs` |

**How it works**

1. Three-step wizard collects company name, industry, stage, team size, product/market, and module preferences.
2. `POST /api/onboarding` upserts `business_profile` (modules as JSON).
3. A Kanban `board_configs` row is auto-created from industry/stage templates (software, agency, sales, default).
4. Profile data feeds **Strategy Hub** prompts and **AI Studio** site generation. Users can skip onboarding and go straight to `/chat`.

---

### Chat + RAG

| | |
|---|---|
| **Pages** | `/chat`, `/chat/[id]` |
| **API** | `POST /api/chat`, `GET /api/chats`, `GET|DELETE /api/chats/[id]` |
| **Code** | `src/app/api/chat/route.ts`, `src/lib/{llm,pinecone,prompts,dynamodb,dsql}.ts` |
| **Storage** | DSQL `chats` · DynamoDB `javis-messages` · Pinecone (user namespace) |
| **External** | Groq (streaming), Pinecone (`multilingual-e5-large`) |

**How it works**

```
User message
    → ensure chat row in DSQL
    → save user turn in DynamoDB
    → parallel: last 10 messages (DynamoDB) + top-5 RAG chunks (Pinecone)
    → build system prompt + stream Groq response to browser
    → on finish: save assistant turn in DynamoDB, bump chats.updated_at
    → background: LLM extracts action items → INSERT INTO tasks
```

Chat history lives in DynamoDB for fast writes; chat metadata (title, timestamps) in DSQL. RAG retrieves chunks uploaded via the Files feature (same Pinecone namespace).

---

### Files (RAG ingestion)

| | |
|---|---|
| **Page** | `/files` |
| **API** | `GET|POST|DELETE /api/files` |
| **Code** | `src/app/api/files/route.ts`, `src/lib/{chunk,pinecone}.ts` |
| **Storage** | Supabase Storage · DSQL `files` · Pinecone vectors |
| **External** | Pinecone (hosted embed + upsert) |

**How it works**

1. Upload (max 15 MB) → `extractText` (PDF via `pdf-parse`, else plain text).
2. `chunkText` splits into ~400-word windows.
3. Raw blob → Supabase Storage; metadata → DSQL.
4. Each chunk upserted to Pinecone under `{userId}` namespace with id `{fileId}:{index}`.
5. Delete removes Pinecone vectors, storage object, and DSQL row.

Chat automatically searches these chunks on every turn.

---

### GitHub Review

| | |
|---|---|
| **Page** | `/github` |
| **API** | `POST /api/github/review`, `POST /api/github/readme` |
| **Code** | `src/lib/github.ts`, `src/lib/prompts.ts` |
| **Storage** | None (stateless) |
| **External** | GitHub API (Octokit), Groq |

**How it works**

1. Parse repo URL → fetch metadata + recursive file tree via Octokit.
2. **Review** — pick up to 3 source files, truncate ~1500 chars each, LLM review per file.
3. **README** — pull entry points + top source files, LLM generates a full README from tree + content.

Requires `GITHUB_TOKEN` with public repo read access.

---

### Tasks

| | |
|---|---|
| **Page** | `/tasks` |
| **API** | `GET|POST|PATCH|DELETE /api/tasks` |
| **Code** | `src/app/api/tasks/route.ts` (also auto-created from chat) |
| **Storage** | Aurora DSQL — `tasks` |

**How it works**

- After each chat turn, a background Groq call extracts action items and inserts rows into `tasks`.
- The `/tasks` page supports manual create, toggle done, rename, and delete.
- Separate from the **Production** Kanban board (`production_tasks` table).

---

### AI Studio (Build / Site Generator)

| | |
|---|---|
| **Pages** | `/build`, `/build/[siteId]` |
| **API** | `/api/build/generate`, `refine`, `save`, `suggest`, `security`, `resume`, `/api/build/sites/*`, public `/api/leads/[siteId]`, `/api/analytics/[siteId]` |
| **Code** | `src/lib/{build-prompts,build-categories,builder-engine,inline-edit}.ts` |
| **Storage** | DSQL — `sites`, `site_revisions`, `site_leads` · DynamoDB page views |
| **External** | Groq (HTML generation), GitHub (publish + Pages) |

**How it works**

1. Wizard picks category, theme, and answers → `POST /api/build/generate` → Groq returns full HTML → saved to DSQL + initial revision.
2. Analytics beacon injected into HTML; public POST records page views in DynamoDB.
3. **Live Studio** — AI refine, inline edit, drag-and-drop (`builder-engine`), manual save, version history/revert.
4. **Publish** — creates a GitHub repo, pushes `index.html`, enables GitHub Pages.
5. Generated sites POST leads to `/api/leads/[siteId]` (DSQL).

Uses onboarding `business_profile` as business context in generation prompts.

---

### Automations + Scheduler

| | |
|---|---|
| **Page** | `/automations` |
| **API** | `/api/automations`, `/api/automations/[id]`, `fire`, `test`, `/api/cron/automations` |
| **Code** | `src/lib/{automation-runner,automation-executor,automation-scheduler,user-integrations}.ts`, `scripts/run-automation-cron.mjs` |
| **Storage** | Aurora DSQL — `automations` |
| **External** | Resend, Slack webhooks, Groq (Run Agent), arbitrary HTTP webhooks |

**How it works**

**Triggers**

- **Scheduled (Daily)** — `schedule_time`, `schedule_timezone`, `schedule_days`. A cron poller hits `/api/cron/automations` every second locally (`npm run dev` auto-starts it) or every minute in production (Cloud Scheduler + `CRON_SECRET`).
- **Kanban label** — fires when a production card moves to a column whose label matches the automation.

**Actions**

Send Email · Send Slack Message · Send Notification · Trigger Webhook · Create Task · Run Agent

**Execution**

- `SCHEDULE_FIRE_WINDOW_SEC = 10` — fires within the first 10 seconds of the scheduled minute.
- Claim pattern (`last_scheduled_date`) prevents double-fire.
- Fast actions (email, Slack) are awaited; slow actions (Run Agent) run in the background.
- Saved integrations (`user_integrations`) fill in default email/Slack when per-action config is empty.

---

### Agents

| | |
|---|---|
| **Page** | `/agents` |
| **API** | `/api/agents`, `/api/agents/[id]`, `templates`, `runs` |
| **Code** | `src/lib/{agent-runner,agent-templates}.ts` |
| **Storage** | DSQL — `agents`, `agent_runs` |
| **External** | Groq |

**How it works**

1. Create an agent from a template or custom system prompt.
2. Manual run or automation trigger calls Groq → output stored in `agent_runs`.
3. Delivery via in-app notification, email, or Slack (configured in automation `deliver_via`).
4. Agent `status` and `tasks_completed` updated after each run.

---

### Strategy Hub

| | |
|---|---|
| **Page** | `/strategy` |
| **API** | `/api/strategy`, `/api/strategy/[id]/*`, `export`, `export-all` |
| **Code** | `src/lib/strategy.ts` |
| **Storage** | DSQL — `strategies`, `strategy_versions`, reads `business_profile` |
| **External** | Groq |

**How it works**

1. Six strategy types: competitor analysis, TAM, growth, GTM, roadmap, fundraising — each with a typed prompt in `strategy.ts`.
2. Loads onboarding profile as business context → Groq generates a Markdown report → saved as draft.
3. Edit, regenerate, export to Markdown/PDF.
4. Version history in `strategy_versions`.
5. `POST /api/strategy/[id]/production` parses recommendations → creates Production board cards.

---

### Production Board (Kanban + HITL)

| | |
|---|---|
| **Page** | `/production` |
| **API** | `/api/production`, `/api/production/[id]/*`, `config` |
| **Code** | `src/lib/{production-board,production-server}.ts` |
| **Storage** | DSQL — `production_tasks`, `board_configs`, `production_activity` |

**How it works**

1. Columns come from `board_configs` (JSON). Some columns are marked `hitl: true` (human-in-the-loop gates).
2. Drag/move is blocked out of HITL columns without Approve/Reject.
3. **Approve** → advance to next column → may fire kanban automations matching the card's `automation` label.
4. **Reject** → log activity + delete card.
5. Activity log in `production_activity`. Board template seeded at onboarding.

---

### Analytics

| | |
|---|---|
| **Page** | `/analytics` |
| **API** | `GET /api/analytics`, `GET /api/build/sites/[id]/analytics`, public `POST /api/analytics/[siteId]` |
| **Code** | `src/lib/dynamodb.ts` |
| **Storage** | DSQL (aggregates) · DynamoDB (page views) |

**How it works**

1. Dashboard aggregates cross-module metrics from DSQL: leads, sites, agents, production cards, strategies, automations, chat tasks — plus 7-day trend arrays.
2. Per-site views: public POST writes page-view events to DynamoDB; owner reads via authenticated GET.
3. Computes heuristic "hours automated" and "dollars saved" from automation run counts.

---

### Integrations (Email + Slack)

| | |
|---|---|
| **Page** | `/settings/integrations` |
| **API** | `GET|PATCH /api/integrations`, `POST /api/integrations/email`, `POST /api/integrations/test` |
| **Code** | `src/lib/user-integrations.ts` |
| **Storage** | DSQL — `user_integrations` |
| **External** | Slack incoming webhooks, Resend |

**How it works**

1. **Slack** — paste a `hooks.slack.com/services/…` webhook URL + optional channel name.
2. **Email** — send 6-digit OTP via Resend → verify → stored as `email_default_to`.
3. Saved credentials are merged into automation actions when per-action `to` / `webhook_url` is not set.
4. Test endpoint validates connectivity before saving.

---

### Notifications

| | |
|---|---|
| **UI** | Bell icon in app shell |
| **API** | `GET|PATCH /api/notifications` |
| **Code** | `src/components/notification-bell.tsx`, `src/lib/automation-executor.ts` |
| **Storage** | DSQL — `notifications` |

**How it works**

1. Automations with action "Send Notification" or agent delivery insert rows into `notifications`.
2. Bell component polls `/api/notifications`; PATCH marks read (by id or all).
3. Custom event `javis:notifications-refresh` triggers re-fetch after automation runs.

---

## Route index

| Feature | Page | Primary API |
|---|---|---|
| Auth | `/login` | `/api/auth/*`, `/auth/callback` |
| Onboarding | `/onboarding` | `/api/onboarding` |
| Chat + RAG | `/chat`, `/chat/[id]` | `/api/chat`, `/api/chats` |
| Files | `/files` | `/api/files` |
| GitHub | `/github` | `/api/github/review`, `/readme` |
| Tasks | `/tasks` | `/api/tasks` |
| AI Studio | `/build`, `/build/[siteId]` | `/api/build/*` |
| Automations | `/automations` | `/api/automations`, `/api/cron/automations` |
| Agents | `/agents` | `/api/agents` |
| Strategy | `/strategy` | `/api/strategy` |
| Production | `/production` | `/api/production` |
| Analytics | `/analytics` | `/api/analytics` |
| Integrations | `/settings/integrations` | `/api/integrations` |
| Notifications | (bell in shell) | `/api/notifications` |

---

## Database

| Store | Used for |
|---|---|
| **Aurora DSQL** | All relational metadata — see `aws/schema.sql` |
| **DynamoDB** | Chat messages, site page-view events |
| **Supabase Auth** | User sessions |
| **Supabase Storage** | Uploaded file blobs |
| **Pinecone** | RAG vector chunks (per-user namespace) |

Apply schema: `npm run migrate` (runs `aws/migrations.sql` against DSQL).

---

## Deploy to Google Cloud Run

```bash
# One-time: enable APIs, create secrets, grant Secret Manager access
# See LAUNCH_CHECKLIST.md and deploy/deploy.sh

./deploy/deploy.sh
# → builds linux/amd64 Docker image
# → pushes to gcr.io/javis-prod/javis
# → deploys to Cloud Run on port 8080
```

Production URL: set `APP_URL` in `deploy/deploy.sh`, then update Supabase **Site URL** and **Redirect URLs** (`https://your-url/**`).

Schedule automations in production:

```bash
CRON=$(gcloud secrets versions access latest --secret=cron-secret --project=javis-prod)
gcloud scheduler jobs create http javis-automations \
  --schedule="* * * * *" \
  --uri="https://javis-xtmerz2lha-uc.a.run.app/api/cron/automations" \
  --http-method=GET \
  --headers="Authorization=Bearer ${CRON}" \
  --location=us-central1
```

Docker is only needed on your Mac to **build and push** the image. Once deployed, Cloud Run runs independently — quitting Docker does not affect the live site.

---

## Swapping Groq → Claude

1. `npm install @anthropic-ai/sdk`
2. In `src/lib/llm.ts`, branch on `provider === "anthropic"`.
3. Set `LLM_PROVIDER=anthropic` and `ANTHROPIC_API_KEY`. No callers change — every route imports from `@/lib/llm`.

---

## Troubleshooting

| Problem | Fix |
|---|---|
| **401 on API calls** | Sign in; check `NEXT_PUBLIC_SUPABASE_URL` and anon key in `.env.local` |
| **OAuth/magic link 500 on Cloud Run** | Redeploy latest; ensure Supabase Redirect URLs include `https://your-url/**` |
| **Redirect to `0.0.0.0:8080`** | Set `NEXT_PUBLIC_APP_URL` in Cloud Run env + Supabase Site URL |
| **Signup email not arriving** | Configure SMTP in Supabase → Authentication → SMTP, or disable "Confirm email" |
| **Pinecone errors on first upload** | Index auto-created in `src/lib/pinecone.ts`; check `PINECONE_API_KEY` and region |
| **Automations not firing on time** | Local: `npm run dev` auto-starts cron. Prod: Cloud Scheduler → `/api/cron/automations` |
| **Deploy fails on anon key** | Keep `NEXT_PUBLIC_SUPABASE_ANON_KEY` as a Secret Manager reference (see `deploy/deploy.sh`) |

---

## Repo layout

```
src/app/(app)/          Authed pages (chat, files, build, automations, …)
src/app/api/            API route handlers
src/lib/                Core logic (llm, pinecone, dsql, dynamodb, automations, …)
src/lib/supabase/       Auth clients (browser, server, middleware, callback)
aws/schema.sql          Full DSQL schema (new DB)
aws/migrations.sql      Incremental migrations (existing DB)
deploy/deploy.sh        One-command Cloud Run deploy
scripts/                Dev server, automation cron, DB migrations
LAUNCH_CHECKLIST.md     Production setup checklist
```
