# KernelHub

KernelHub is an AI-native operating system for small and mid-sized businesses: CRM, leads, omnichannel messaging, helpdesk, calendar and bookings, quotes/invoices/payments, production boards, knowledge base and RAG chat, agents and automations, social and ads, reports — in one multi-tenant Next.js app with a public REST API and webhooks.

**Stack:** Next.js 15 (App Router, React 18, TypeScript strict) · Tailwind 3 · Supabase Auth · Postgres (Aurora DSQL or plain Postgres 17) · optional DynamoDB / Pinecone · Groq or Gemini LLMs · Vitest.

Docs: [`docs/DEPLOY.md`](docs/DEPLOY.md) · [`docs/OPERATIONS.md`](docs/OPERATIONS.md) · [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) · [`docs/SECURITY.md`](docs/SECURITY.md) · [`docs/TESTING.md`](docs/TESTING.md) · [`docs/API.md`](docs/API.md) · [`docs/PRIVACY.md`](docs/PRIVACY.md) · [`docs/ACCOUNTING.md`](docs/ACCOUNTING.md)

---

## Feature map

| Module | Pages | Key libs |
|---|---|---|
| Home, onboarding, demo data | `/home`, `/onboarding` | `src/lib/home`, `src/lib/onboarding`, `src/lib/demo` |
| Chat, files, knowledge (RAG) | `/chat`, `/files`, `/knowledge` | `src/lib/llm`, `src/lib/kb`, `src/lib/pinecone.ts`, `src/lib/chunk.ts` |
| CRM, leads, records | `/crm`, `/leads`, `/r` | `src/lib/crm`, `src/lib/records`, `src/lib/lead-enrichment.ts` |
| Messaging (SMS, WhatsApp, web chat, mail inbox) | `/messaging`, `/settings/mail` | `src/lib/channels`, `src/lib/webchat`, `src/lib/mail`, `src/lib/twilio-webhook.ts` |
| Helpdesk + SLA | `/helpdesk` | `src/lib/helpdesk` |
| Calendar + bookings | `/calendar`, `/book/*` (public) | `src/lib/calendar` |
| Billing: quotes, invoices, payments, credits | `/billing`, `/finance`, `/p/*` (public) | `src/lib/finance`, `src/lib/payments`, `src/lib/credits`, `src/lib/pdf`, `src/lib/money` |
| Inventory, production, tasks, approvals | `/inventory`, `/production`, `/tasks`, `/approvals` | `src/lib/inventory`, `src/lib/production-*.ts`, `src/lib/tasks`, `src/lib/approvals` |
| Agents, swarms, automations, marketplace, evals | `/agents`, `/automations`, `/marketplace` | `src/lib/agents`, `src/lib/agent-runner.ts`, `src/lib/automation-*.ts`, `src/lib/marketplace`, `src/lib/evals` |
| Social, ads, sites (AI Studio), voice | `/social`, `/ads`, `/build`, `/voice` | `src/lib/social`, `src/lib/ads`, `src/lib/builder-engine.ts`, `src/lib/voice` |
| Reports, insights, analytics, strategy | `/reports`, `/insights`, `/analytics`, `/strategy` | `src/lib/export`, `src/lib/strategy.ts`, `src/lib/dynamodb.ts` |
| Agency mode (client workspaces) | `/agency` | `src/lib/agency` |
| Settings: team/roles, SSO + SCIM, API keys, webhooks, branding, import, privacy, accounting, system health | `/settings/*` | `src/lib/team.ts`, `src/lib/sso`, `src/lib/scim`, `src/lib/api-keys.ts`, `src/lib/webhooks`, `src/lib/branding.ts`, `src/lib/import`, `src/lib/privacy`, `src/lib/accounting`, `src/lib/system` |
| Public API v1 + OpenAPI | `/api/v1/*`, `/api/v1/openapi.json` | `src/lib/public-api` |

---

## Quick start (local)

Prereqs: Node 22, Postgres 17 (or an Aurora DSQL cluster), a Supabase project (auth only).

```bash
npm install
cp .env.example .env.local        # fill in Supabase keys, CRON_SECRET, an LLM key
# plain Postgres: DSQL_ENDPOINT=127.0.0.1 DB_USER=… DB_PASSWORD=… DB_NAME=postgres
node scripts/check-env.mjs        # audits .env.local (missing vars, provider matrix, key sanity)
npm run migrate                   # applies aws/migrations.sql (idempotent, hash-tracked)
npm run dev                       # http://localhost:3001 (scripts/dev.mjs also ticks cron locally)
npm run smoke                     # hits /api/health, /login, manifest, OpenAPI, two 401 routes
```

`/api/health` is public; `/api/health?verbose=1` (owner/admin session or `Authorization: Bearer $CRON_SECRET`) returns the same environment report as `check-env`.

## Docker

```bash
docker build -t kernelhub \
  --build-arg NEXT_PUBLIC_SUPABASE_URL=… --build-arg NEXT_PUBLIC_SUPABASE_ANON_KEY=… \
  --build-arg NEXT_PUBLIC_APP_URL=https://app.example.com .
docker run --rm -p 3001:3001 --env-file .env.production kernelhub
```

`docker-compose.yml` runs app + Postgres 17 + a one-shot `migrate` service + a `cron` sidecar (`scripts/cron-tick.mjs`). `output: "standalone"` in `next.config.ts` is enabled only when `NEXT_OUTPUT=standalone` — the Dockerfile sets it; Vercel and `npm run dev` never should. Details: [`docs/DEPLOY.md`](docs/DEPLOY.md).

## Vercel

Import the repo; `vercel.json` declares the every-minute cron for `/api/cron/agents` (Pro plan — Hobby crons run once a day) and `maxDuration` for import/PDF/export routes. Set the env vars from `.env.example` in the project settings; Vercel sends `Authorization: Bearer $CRON_SECRET` to cron routes automatically.

## Environment

Every variable is catalogued in `src/lib/env/vars.json` with its group, format and companion rules; `src/lib/env` (zod) and `scripts/check-env.mjs` (dependency-free) enforce the same rules, and a unit test fails when `vars.json` and `.env.example` drift.

Required: `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` (JWT role must be `service_role`, or an `sb_secret_…` key), `DSQL_ENDPOINT`, `CRON_SECRET`, `NEXT_PUBLIC_APP_URL`. Everything else degrades to a simulated provider (email → Settings → Outbox, payments → simulated, SMS → logged).

## Testing

```bash
npm test                   # hermetic unit tests (vitest)
npm run test:integration   # real route handlers against local Postgres (DB_INTEGRATION=1)
scripts/integration-db.sh  # same, starting Homebrew Postgres if needed
npm run typecheck && npm run lint
```

See [`docs/TESTING.md`](docs/TESTING.md). CI (`.github/workflows/ci.yml`) runs lint+typecheck, unit, integration (Postgres 17 service), standalone build, env drift check and a non-blocking `npm audit`.

---

## Architecture overview

```
Browser ── Next.js App Router (src/app) ── middleware: Supabase session refresh
             │  Server Components + Route Handlers
             ├─ src/lib/auth/scope.ts   requireScope() → { userId, dataId, role, can() }
             ├─ src/lib/dsql.ts         Postgres (Aurora DSQL IAM, or localhost password auth)
             ├─ src/lib/events/bus.ts   emitEvent() → events table → webhooks + automations
             ├─ src/lib/notifications   outbox → email / SMS / WhatsApp / push / in-app
             ├─ src/lib/llm             Groq / Gemini router + credit metering
             └─ /api/cron/agents        single scheduled tick drives every background job
```

**Tenancy.** Each organization has an `owner_user_id`; all module tables are keyed by `user_id` = that owner id (`scope.dataId`). `requireScope({ area, edit })` resolves the caller's membership and role (owner, admin, manager, member, viewer — `src/lib/auth/roles.ts`) and every data query filters on `scope.dataId`. Agency client workspaces are orgs with a synthetic owner id reachable only through membership. See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

**Database constraints.** Aurora DSQL compatibility shapes the schema: no foreign keys, triggers or sequences; TEXT ids and JSON-as-TEXT; `CREATE INDEX ASYNC`; one statement per migration block. Plain Postgres runs the same SQL (the migration runner strips `ASYNC`).

**Security posture.** Org-scoped authorization on every route, rate limits (memory or shared `rate_limits` table), CSP (report-only by default), signed webhooks, encrypted integration credentials (`CREDENTIAL_ENCRYPTION_KEY`, AES-256-GCM), SSRF-safe webhook URLs. Full write-up: [`docs/SECURITY.md`](docs/SECURITY.md).

## Repo layout

```
src/app/(app)/        authenticated pages           src/lib/              domain libraries
src/app/api/          route handlers (incl. /api/v1) src/lib/env/          env catalogue + validation
src/components/ui/    shared UI kit                  src/__integration__/  DB-backed flow tests
aws/migrations.sql    schema (hash-tracked)          scripts/              migrate, check-env, smoke, cron-tick, backup
docs/                 operator + developer docs      Dockerfile, docker-compose.yml, vercel.json
```
