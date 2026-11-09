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

## Observability

### Readiness and metrics

- `GET /api/health` — public liveness (DB round trip). `GET /api/ready` — readiness for orchestrators: DB ping plus presence of critical tables (`organizations`, `memberships`, `notification_outbox`, `agent_jobs`, `audit_log`, `system_state`, `alert_rules`); 503 with the missing table names when migrations were not applied.
- `GET /api/metrics` — Prometheus text format. Set `METRICS_TOKEN` (min 16 chars) and scrape with `Authorization: Bearer <token>`. Unset => 404 (the endpoint does not exist); wrong token => 401. DB-derived gauges are cached for 15 s.
- Every response from a wrapped route and from middleware carries `x-request-id` (a caller-supplied id is kept when 8–64 chars of `[A-Za-z0-9._-]`, otherwise one is minted). Quote it when reporting a problem; it is the `req_id` field in logs.

### Log fields

Production logs are one JSON object per line (`LOG_LEVEL`: debug|info|warn|error|silent; `LOG_FORMAT=json` forces JSON outside production).

| Field | Meaning |
|---|---|
| `ts` | ISO timestamp |
| `level` | debug / info / warn / error |
| `msg` | Message (redacted: emails, phones, cards, keys, bearer tokens) |
| `req_id` | Request id from `x-request-id` |
| `org` | Short SHA-256 of the workspace id (never the raw id) |
| `route` | Route path or `/api/v1/<registry path>` |
| `ms` | Duration in milliseconds |
| `err` | `Name: message` of the error (no stack; stacks live in `app_errors`) |

Keys such as `password`, `token`, `secret`, `authorization`, `cookie`, `api_key` are always replaced with `[redacted]`.

### Metrics

| Metric | Type | Notes |
|---|---|---|
| `kh_http_requests_total{group,status}` | counter | groups: api_v1, cron, webhook, shop, widget, portal, api; status class 2xx..5xx |
| `kh_http_request_duration_ms{group}` | histogram | buckets 5 ms – 10 s |
| `kh_cron_ticks_total`, `kh_cron_tick_duration_ms`, `kh_cron_items_total{kind}` | counter/histogram | recorded by `recordCronMetrics` |
| `kh_errors_captured_total` | counter | every `captureError` call |
| `kh_rate_limit_blocks_total{limiter}` | counter | rejected requests |
| `kh_cron_last_tick_age_minutes` | gauge | minutes since `system_state` `cron:agents:last_tick` |
| `kh_outbox_rows{status}`, `kh_agent_jobs{status}`, `kh_webhook_deliveries{status}` | gauge | queue depth; `dead`/`failed` are the ones to alert on |
| `kh_llm_spend_today_micros` | gauge | all workspaces |

Counters are per instance (reset on restart): use `rate()`/`increase()` in Prometheus, never the raw value.

### Alerts

Tenant alert rules live in Settings → System health → Alerts (`alert_rules` / `alert_events`). They are evaluated by the cron tick (`processAlerts(50)`), notify chat integrations and/or an email address with a per-rule cooldown, and auto-resolve when the condition clears. Org rules only ever read that workspace's data. Defaults per workspace (seeded on first visit, or by the tick once the workspace has failed notifications): **on** — notification failures > 20 in 60 min, dead webhook deliveries > 5 in 24 h, AI budget >= 90%; **off** — open SLA breaches, accounting sync errors, agent failure rate, mail/calendar sync errors, past-due invoices.

Platform rules (`user_id` NULL: `cron_stale` > 10 min, `jobs_queued` > 500) only run when `OPERATOR_ORG_ID` is set, and notify via the operator workspace's chat integrations.

## Incident playbook

| Symptom | Detect | Fix |
|---|---|---|
| **Cron not ticking** | `kh_cron_last_tick_age_minutes` > 10, `cron_stale` alert, System health "Cron last tick" red | Check the scheduler hits `/api/cron/agents` with `Authorization: Bearer $CRON_SECRET` (401 = secret drift, 503 = secret unset). Run the call by hand and read the JSON counts. A tick longer than 60 s means a sweep is stuck: look for the slow `route` in logs by `req_id`. |
| **Agent queue stuck** | `kh_agent_jobs{status="queued"}` rising while `running` is flat | Jobs claimed by a dead worker stay `running` until `locked_at` expires; confirm cron is ticking, then check `last_error` of `failed`/`dead` rows. Re-queue by setting `status='queued', run_after=NOW()` for the affected ids. |
| **Outbox failing** | `kh_outbox_rows{status="failed"}`, "Notification failures" alert | `notification_outbox.error` names the provider error. Typical: expired `RESEND_API_KEY`/Twilio creds, bounced recipients. Fix the provider, then `UPDATE notification_outbox SET status='queued', attempts=0 WHERE status='failed' AND created_at > NOW() - INTERVAL '1 day'`. |
| **Webhook dead letters** | `kh_webhook_deliveries{status="dead"}`, "Dead webhook deliveries" alert | Settings → Webhooks → delivery log shows the response status. Receiver down: wait or fix then replay from the UI. Receiver gone: disable the subscription. |
| **5xx spike** | `kh_http_requests_total{status="5xx"}`, System health error list | Top fingerprints on the Diagnostics tab; find the log line via `req_id`/`route`. Roll back code if it started with a deploy (schema is additive). |
| **DB unreachable** | `/api/ready` 503, health 503 | Check Aurora DSQL/Postgres status and connection limits; app instances recover on their own when the DB returns. |
| **AI spend** | "AI budget nearly used" alert, `kh_llm_spend_today_micros` | Raise the cap in Settings → AI budgets or let the hard stop apply. |

### On-call checklist

1. Open System health (Overview, Diagnostics) and `/api/ready`.
2. Is cron fresh (< 5 min)? If not, start with the cron row above.
3. Are queues draining (agent jobs, outbox, webhooks)?
4. Any firing alerts? Read the event message; it names the rule and current value.
5. Grab a failing `x-request-id` and search logs for it.
6. Mitigate (flip provider to simulated, roll back), then note the incident (Settings → Privacy → incidents if personal data was involved).
7. Backups: restore references are in `docs/DEPLOY.md` (*Backups and restore*); audit retention floor is 365 days (`audit_log` cannot be configured lower).

### Audit trail

Settings → Audit log can be filtered by category (access & security, data & privacy, integrations, billing, content, operations) and date range, and exported as CSV (`GET /api/audit?format=csv&category=&from=&to=`, spreadsheet-formula safe, up to 5,000 rows). Sensitive actions that write audit rows include API key create/revoke, webhook create, SSO domain changes, role changes and member removal, retention policy changes, refunds, marketplace install/publish, snapshots, DSR requests, SCIM tokens, chat/accounting/calendar connections and alert rule changes.
