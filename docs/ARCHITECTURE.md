# Architecture

## Runtime shape

```
                 ┌──────────────────────────── Next.js 15 (App Router) ────────────────────────────┐
Browser ───────► │ src/middleware.ts  (Supabase session refresh; skips /api/health, static assets)  │
                 │ src/app/(app)/*    Server Components  → requireUser() + resolveDataId()          │
                 │ src/app/api/*      Route Handlers     → requireScope({ area, edit })             │
                 │ src/app/api/v1/*   Public REST API    → API keys (Bearer kh_…), OpenAPI registry │
                 │ /p/*, /book/*, /api/leads/widget/*   public, token/origin-gated, embeddable      │
                 └──────────────┬──────────────────────────────┬────────────────────────────────────┘
                                │                              │
           src/lib/dsql.ts (Postgres)              src/lib/supabase (auth, storage)
           optional: DynamoDB, Pinecone, Groq/Gemini, Twilio, Resend, Stripe/Razorpay, QBO/Xero, Gmail/Outlook
```

Everything runs in the Node.js runtime (`export const runtime = "nodejs"` on data routes). There is no separate worker: `/api/cron/agents` is the only scheduled entry point and drains every queue.

## Tenancy model (`src/lib/auth/scope.ts`)

- An **organization** row has `owner_user_id`. All module tables are keyed by `user_id TEXT NOT NULL`, and an org's data is simply the rows where `user_id = owner_user_id`. There is no `org_id` column on module tables.
- `requireScope({ area, edit })` authenticates the Supabase user, resolves the active org (cookie `kh_org`, else personal org), checks the membership role against `DEFAULT_MATRIX` in `src/lib/auth/roles.ts` (roles: owner, admin, manager, member, viewer; areas: crm, leads, messaging, production, tasks, social, ads, sites, agents, knowledge, billing, calendar, helpdesk, reports, team, settings) and returns `{ userId, dataId, orgId, role, can() }`.
- **Rule:** every data query uses `scope.dataId`; `scope.userId` is the actor (audit log, "created by"). Server components use `requireUser()` + `resolveDataId()` (`src/lib/auth/session-scope.ts`).
- **Agency mode** (`src/lib/agency`): a client workspace is an org whose owner id is synthetic (its own id); it is reachable only via memberships, so the same resolver yields its `dataId`.
- Errors are `ScopeError` (`UNAUTHORIZED`, `FORBIDDEN`, `NO_ORG`) converted with `scopeErrorResponse()`.

## Data layer (`src/lib/dsql.ts`)

`query`, `queryOne`, `transaction`, `withRetry` (retries DSQL optimistic-concurrency conflicts), `DbError`. Connection mode is chosen by `DSQL_ENDPOINT`: `localhost`/`127.0.0.1` → `pg.Pool` with `DB_USER/DB_PASSWORD/DB_NAME`; anything else → `AuroraDSQLPool` with IAM tokens. Schema rules (Aurora DSQL compatible, run unchanged on Postgres 17): TEXT primary keys, no FKs/triggers/sequences/PL-pgSQL, JSON as TEXT, `TIMESTAMPTZ`, money as minor-unit integers + ISO currency, `CREATE INDEX ASYNC IF NOT EXISTS`, one statement per migration block. `scripts/run-migrations.mjs` applies `aws/migrations.sql` statement by statement and records SHA-256 hashes in `schema_migrations`.

Soft deletes (`src/lib/soft-delete.ts`), audit trail (`src/lib/audit.ts` → `recordAudit`), optional-table probing (`src/lib/table-exists.ts`) and encrypted secrets (`src/lib/secure-store.ts`, AES with `CREDENTIAL_ENCRYPTION_KEY`) are shared primitives.

## Events, automations and delivery

- `emitEvent()` (`src/lib/events/bus.ts`, typed `EVENT_TYPES`) writes to `events`; webhook subscriptions (`src/lib/webhooks`) and automations (`src/lib/automation-*.ts`) consume them on the cron tick.
- Outbound messages go through the **notification outbox** (`src/lib/notifications/outbox.ts`) and channel adapters (`channels.ts`); channels without credentials are *simulated* and still persist the full body.
- `src/lib/agents` (registry of tools, templates, swarms, runner) executes agent jobs claimed per tick with lease/retry/dead-letter states.

## AI layer

`src/lib/llm.ts` (`complete()`), `src/lib/llm/providers.ts` (Groq, Gemini — `GROQ_API_KEY`, `GEMINI_API_KEY`), `src/lib/llm/metering.ts` (`meteredComplete` charges credits from `src/lib/credits` with `AI_CREDIT_MARKUP`), `src/lib/model-json.ts` / `llm-response.ts` for structured output, `src/lib/evals` for scored prompt suites, `src/lib/pinecone.ts` + `src/lib/chunk.ts` for RAG.

## Public surface

- **REST API v1** (`src/lib/public-api`): registry → `/api/v1/openapi.json`; `Authorization: Bearer kh_…` keys with scopes (Settings → API keys); problem-style error envelope.
- **Webhooks out**: HMAC-signed, backoff, SSRF-safe URL validation (`resolvesToPublicAddress`).
- **Public pages**: portal `/p/*` (quotes, invoices, credits via share tokens — `src/lib/share-tokens.ts`), booking `/book/*`, lead widget and web-chat embeds; CORS/`frame-ancestors` relaxed only for these (`src/lib/security-headers.ts`, `next.config.ts`).
- **SCIM 2.0** (`src/lib/scim`) and **SAML SSO** via Supabase (`src/lib/sso`).

## Operability

`src/lib/env` (catalogue + `validateEnv()`), `/api/health`, `src/lib/system/state.ts` (`system_state` KV, cron tick record), `src/lib/errors/capture.ts` (`app_errors`), `src/lib/request-limits.ts` (memory/db rate limits), `src/lib/privacy` (consent, DSR, retention, incidents). Deployment artefacts: `Dockerfile` (standalone), `docker-compose.yml`, `vercel.json`, `.github/workflows/ci.yml`, `scripts/{check-env,smoke,cron-tick}.mjs`, `scripts/backup-db.sh`.

## UI

Server-first pages under `src/app/(app)`; the shared kit in `src/components/ui` (dialog, feedback, pill, tabs, field, table-scroller, hooks) and `PageContainer`; navigation and i18n (`en`, `es`, `hi`) in `src/lib/app-nav.ts` + `src/lib/i18n`. Client components never import modules that import `@/lib/dsql`.

## Testing strategy

Hermetic unit tests (`src/**/*.test.ts`, `npm test`) and DB-backed flow tests (`src/__integration__/*.flow.test.ts`, `DB_INTEGRATION=1`) that call real route handlers with auth mocked to a synthetic scope. See `docs/TESTING.md`.
