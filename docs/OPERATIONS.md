# Operating KernelHub

## Health endpoints

| Endpoint | Auth | Returns |
|---|---|---|
| `GET /api/health` | none (excluded from middleware) | `{ ok, database: "connected"\|"error", llm, time }`; 503 when the 3 s DB probe fails. Use for load-balancer / Docker health checks. |
| `GET /api/health?verbose=1` | owner/admin session **or** `Authorization: Bearer $CRON_SECRET` | adds `latencyMs`, `node`, `env: { ok, database, missing, invalid, warnings, providers[] }` — the `validateEnv()` report (`src/lib/env`). Names only, never values. |
| `GET /api/system/status` | owner/admin session | what the System health page renders: DB latency, provider matrix (payments, email, SMS, push, mail, voice, accounting, LLM), queue counts, last cron tick, recent errors. |

`npm run smoke [url]` (`scripts/smoke.mjs`) checks health, `/login`, the PWA manifest, the OpenAPI document and two routes that must answer 401. Exit code is non-zero on any failure — wire it after every deploy.

## Settings → System health (`/settings/system`)

Owner/admin page backed by `/api/system/status`. Sections: database latency, providers (configured / simulated), background jobs (last `/api/cron/agents` tick from `system_state` key `cron:agents:last_tick`, with per-job counts), queue depth (outbox, webhooks, agent jobs by status) and recent application errors. If the last tick is older than a few minutes the scheduler is down — see *Cron* below.

## Environment drift

- `node scripts/check-env.mjs` — audits `.env.local` + process env; `--file X --drift` compares a file against `src/lib/env/vars.json`; `--strict` for CI; `--json` for tooling.
- Unit test `src/lib/env/__tests__/env.test.ts` fails when `vars.json` and `.env.example` disagree, or when `src/` reads a `process.env.X` not in the catalogue. Add new variables to **both** files.
- The verbose health report runs the same rules in production, so the first thing to check after a deploy with odd behaviour is `env.missing`, `env.invalid` and `env.warnings`.

## Cron (`/api/cron/agents`)

Single scheduled entry point (GET or POST, `Authorization: Bearer $CRON_SECRET`, 503 if the secret is unset, 401 on mismatch, `maxDuration = 60`). Each tick records counts in `system_state`. If jobs stall:

1. Confirm the scheduler is firing: Compose `docker compose logs cron`; Vercel → Cron Jobs tab; Cloud Scheduler job history.
2. Run a tick manually: `CRON_ONCE=1 CRON_TARGET=https://host CRON_SECRET=… node scripts/cron-tick.mjs` (exit 0 on 200).
3. Read the tick payload: queue counts of `failed`/`dead` agent jobs, `outbox`, `webhooks`.

## Logs and error capture

- Route handlers log to stdout/stderr with a `[area]` prefix (`[cron/agents]`, `[health]`, …) — collect with your platform's log driver (`docker compose logs`, Vercel Logs, Cloud Logging).
- `captureError()` (`src/lib/errors/capture.ts`) deduplicates unexpected errors into the `app_errors` table by fingerprint (route + message), storing a capped stack (`STACK_MAX_CHARS`), count, first/last seen and status. Recent rows appear on System health; use them to spot regressions without a third-party tracker.

## Rate limiting

`src/lib/request-limits.ts`: `rateLimit()` (in-process) and `rateLimitAsync()`/`rateLimitDb()` (shared `rate_limits` table) chosen by `RATE_LIMIT_STORE` (`memory` default, `db` for multi-instance). The cron tick prunes rows older than 24 h (`pruneRateLimits`). Limited requests get 429. Signup/login/reset limits are described in `docs/SECURITY.md`.

Client IP for rate-limit keys is the `TRUSTED_PROXY_HOPS`-th entry from the right of `X-Forwarded-For` (default 1 on Vercel/production, 0 in dev). Set it to the number of proxies in front of the app; a wrong value either keys everyone to the proxy address (too high) or trusts spoofable entries (too low). Rotating `MARKETING_TRACKING_SECRET`: put the old value in `MARKETING_TRACKING_SECRET_PREVIOUS`, deploy, and drop it once old emails are no longer expected to be clicked.

## Notification outbox

Every outbound message (email, SMS, WhatsApp, push, in-app, webhook) is a row written by `enqueueNotification()` (`src/lib/notifications/outbox.ts`) and delivered by `drainOutbox(50)` on each cron tick. Status: `queued → sent | simulated | failed` (`read` for in-app). When a channel has no live provider (`channelStatus()` in `src/lib/notifications/status.ts`) the row is marked `simulated` with the full body, so OTPs and invite links are readable at **Settings → Outbox** (`/settings/outbox`). A growing `queued` count means the cron is not running; a growing `failed` count means provider credentials or sender identities are wrong.

## Webhooks (outbound)

`src/lib/webhooks`: subscriptions per org, HMAC signatures (`sign.ts`), exponential backoff (`backoff.ts`), SSRF checks on target URLs (`url.ts`, `WEBHOOKS_ALLOW_INSECURE=1` only in development). Delivery runs from the cron tick (`webhooks`, `webhooks_fanout` counts). Manage under Settings → Webhooks.

## Retention and privacy jobs

`src/lib/privacy/retention.ts` applies per-org policies hourly (first tick of each hour claims the slot) for: closed tickets, mail bodies, resolved leads, voice recordings, outbox rows, audit log — each with a statutory floor (`RETENTION_META` in `constants.ts`); invoices, payments and quotes are never purged. DSR deadlines get reminders in the same hourly slot. Policies live under Settings → Privacy (`docs/PRIVACY.md`).

## Backups

See `docs/DEPLOY.md` → *Backups and restore*. Daily `npm run backup:db` via host cron for plain Postgres; DSQL snapshots otherwise. Test a restore into a scratch database quarterly.

## Incident response

1. **Detect** — health 503, smoke failure, System health showing stale cron or error spike.
2. **Triage** — `GET /api/health?verbose=1` for env/provider state; `app_errors` for the failing route; provider dashboards (Supabase, Twilio, Stripe) for upstream outages.
3. **Contain** — flip the affected provider flag back to its simulated default (`PAYMENTS_PROVIDER=simulated`, unset `RESEND_API_KEY`, `SSO_ENABLED=0`) rather than taking the app down; messages queue in the outbox and are delivered once the provider returns.
4. **Recover** — redeploy previous image/commit; migrations are additive and hash-tracked, so rolling back code never requires rolling back the schema.
5. **Review** — record the incident under Settings → Privacy → breach log if personal data was affected (`src/lib/privacy/incidents.ts`), and add a regression test under `src/__integration__`.

## Routine checklist

| Cadence | Action |
|---|---|
| Daily | smoke test, backup, glance at System health errors |
| Weekly | `npm audit --audit-level=high`, outbox `failed` rows, webhook dead letters |
| Monthly | rotate `CRON_SECRET`/API keys that leaked into logs, review Settings → Audit |
| Quarterly | restore drill, review retention policies, re-run `check-env --strict` against production values |
