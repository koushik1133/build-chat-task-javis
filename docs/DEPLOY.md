# Deploying KernelHub

Three supported shapes: **Docker / Compose** (self-hosted, plain Postgres), **Vercel** (serverless, Aurora DSQL or any reachable Postgres), and **any container host** (Cloud Run, ECS, Fly) using the same image. All of them need a Supabase project for authentication.

## 0. Before anything: environment

```bash
cp .env.example .env.production   # or set the same keys in your host's secret store
node scripts/check-env.mjs --file .env.production --strict
```

`--strict` turns misconfigurations into failures: a `SUPABASE_SERVICE_ROLE_KEY` whose JWT role is not `service_role`, dev-only switches (`WEBHOOKS_ALLOW_INSECURE`, `TWILIO_SKIP_SIGNATURE_VERIFICATION`) left on, a `CRON_SECRET` under 16 characters, a provider selected by a flag (`PAYMENTS_PROVIDER=stripe`) without its keys. After deploy, `GET /api/health?verbose=1` with `Authorization: Bearer $CRON_SECRET` returns the same report from inside the running process.

### Supabase setup

1. Create a project. **Settings → API**: copy the project URL, the anon/publishable key and the **service_role secret** (legacy JWT with `"role":"service_role"`, or the new `sb_secret_…` key). The anon key in `SUPABASE_SERVICE_ROLE_KEY` is the most common misconfiguration — invites, SCIM provisioning and DSR exports fail with 401/403.
2. **Authentication → URL configuration**: Site URL = `NEXT_PUBLIC_APP_URL`; Redirect URLs = `https://your-domain/**` (covers `/auth/callback`).
3. **Authentication → Providers → Email**: keep *Confirm email* on in production; add custom SMTP (Authentication → SMTP) so confirmation and magic-link mail is reliable — Supabase's built-in sender is rate limited to a few messages per hour.
4. Optional OAuth (Google etc.): configure in Supabase; the redirect URI is `https://<project-ref>.supabase.co/auth/v1/callback`.
5. **SAML SSO** (Settings → SSO in the app): enable SAML in Supabase (Pro plan), add your IdP, then set `SSO_ENABLED=1` and `SSO_PROVIDER_NAME`. Verified domains (`src/lib/sso/domains.ts`) map email domains to the provider; `/api/auth/sso` starts the Supabase SAML flow. SCIM tokens are issued under Settings → SSO.

### Database: Aurora DSQL vs plain Postgres

| | Aurora DSQL | Plain Postgres 17 |
|---|---|---|
| `DSQL_ENDPOINT` | `<cluster>.dsql.<region>.on.aws` | `localhost` or `127.0.0.1` (anything else is treated as DSQL) |
| Auth | IAM (instance role or `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY`, `AWS_REGION`) via `@aws/aurora-dsql-node-postgres-connector` | `DB_USER`, `DB_PASSWORD`, `DB_NAME`, port 5432 |
| Migrations | `node scripts/run-migrations.mjs` (admin token) | same script; it strips `CREATE INDEX ASYNC` |
| Backups | DSQL snapshots / AWS Backup | `scripts/backup-db.sh` (pg_dump custom format) |

The schema is DSQL-constrained (no FKs/triggers/sequences), so it runs unchanged on both. Because `src/lib/dsql.ts` only recognises `localhost`/`127.0.0.1` as the password-auth path, a Postgres on another host must be reached through a local proxy/sidecar or shared network namespace (this is what `docker-compose.yml` does). Set `RATE_LIMIT_STORE=db` whenever more than one app instance runs.

## 1. Docker

```bash
docker build -t kernelhub \
  --build-arg NEXT_PUBLIC_SUPABASE_URL=https://xyz.supabase.co \
  --build-arg NEXT_PUBLIC_SUPABASE_ANON_KEY=sb_publishable_… \
  --build-arg NEXT_PUBLIC_APP_URL=https://app.example.com .
docker run -d --name kernelhub -p 3001:3001 --env-file .env.production kernelhub
curl -fsS localhost:3001/api/health
```

- Multi-stage `node:22-alpine`; the build stage sets `NEXT_OUTPUT=standalone` (this is the only place `output: "standalone"` is meant to be on — `next.config.ts` reads the flag). Runtime runs as the non-root `nextjs` user with a `HEALTHCHECK` on `/api/health`, `PORT=3001`.
- `NEXT_PUBLIC_*` values are inlined at build time → pass them as build args. Everything else is runtime env.
- The image also carries `scripts/`, `aws/` and `src/lib/env/vars.json`, so the same image runs migrations, the cron sidecar and `check-env`:
  `docker run --rm --env-file .env.production kernelhub node scripts/run-migrations.mjs`.

### Docker Compose (app + Postgres 17 + migrate + cron)

```bash
cp .env.example .env.docker          # Supabase keys, CRON_SECRET, LLM key; DB_* optional
docker compose --env-file .env.docker up --build -d
docker compose logs -f app cron
```

Services: `postgres` (volume `pgdata`, host port 5433 for psql/backups), `migrate` (one-shot `run-migrations.mjs`, app waits for it), `app`, `cron` (`scripts/cron-tick.mjs` POSTs `/api/cron/agents` every `CRON_INTERVAL_MS`, default 60 s). `app`, `migrate` and `cron` share the `postgres` network namespace so `DSQL_ENDPOINT=127.0.0.1` selects password auth; to publish the app on the host add `"3001:3001"` to the `postgres` service's `ports`, or put a reverse proxy in front.

## 2. Vercel

1. Import the repository (framework auto-detected; `vercel.json` only adds crons and function durations). Do **not** set `NEXT_OUTPUT` — standalone output is for Docker only.
2. Add every variable from `.env.example` you use (Settings → Environment Variables). `NEXT_PUBLIC_APP_URL` must be the production domain.
3. Database: Aurora DSQL with `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY` (serverless functions have no instance role), or a managed Postgres fronted so that it is reachable — see the table above. Set `RATE_LIMIT_STORE=db` (functions do not share memory).
4. Cron: `vercel.json` schedules `/api/cron/agents` `* * * * *`. Vercel sends `Authorization: Bearer $CRON_SECRET` automatically when `CRON_SECRET` is set in the project. **Hobby plan runs crons at most once per day and caps functions at 60 s**; per-minute schedules need Pro. The cron route exports `maxDuration = 60`; import/PDF/export routes get 60 s via `vercel.json`.
5. Migrations are not run by Vercel: run `node scripts/run-migrations.mjs` from CI or a laptop with the production `DSQL_ENDPOINT` before promoting a build that needs new tables.

## 3. Other container hosts (Cloud Run, ECS, Fly)

Use the Docker image; set `PORT` if the platform requires a different one (Cloud Run injects `PORT=8080` — the standalone server honours it). Schedule the cron externally, e.g. Cloud Scheduler → `POST https://host/api/cron/agents` with `Authorization: Bearer $CRON_SECRET` every minute (`deploy/cloud-scheduler.yaml` has the gcloud commands). `deploy/deploy.sh` is the legacy Cloud Run script and still works with the new Dockerfile.

## Cron options summary

| Host | Mechanism |
|---|---|
| Local dev | `npm run dev` (`scripts/dev.mjs`) ticks automatically; or `node scripts/cron-tick.mjs` |
| Compose | `cron` sidecar service |
| Vercel | `vercel.json` crons (Pro for per-minute) |
| Cloud Run / anything | external scheduler hitting `/api/cron/agents` with the bearer secret |

One tick drains: automations, agent jobs, notification outbox, webhook fan-out, mail sync, helpdesk SLA, quote expiry, accounting push/pull, voice calls; once an hour it also runs privacy reminders, retention and rate-limit pruning. Ticks are idempotent and safe to overlap (per-row claims), but the sidecar never overlaps on purpose.

## Backups and restore

- Plain Postgres: `npm run backup:db` → `backups/kernelhub-YYYYMMDD-HHMMSS.dump` (pg_dump custom format, prunes files older than `KEEP_DAYS`, default 30). Restore: `pg_restore -h HOST -U USER -d DB --clean --if-exists file.dump`. In Compose point it at the published port: `DSQL_ENDPOINT=127.0.0.1 PGPORT=5433 DB_USER=kernelhub …`.
- Aurora DSQL: use cluster snapshots / AWS Backup; the script refuses non-local hosts on purpose.
- Supabase holds only auth users (export from the dashboard). Uploaded files live in Supabase Storage; Pinecone vectors can be rebuilt from the `files` table by re-ingesting.

## Release checklist

1. `node scripts/check-env.mjs --file .env.production --strict`
2. `npm run migrate` against the target database
3. Deploy; `node scripts/smoke.mjs https://your-domain`
4. Confirm `GET /api/health?verbose=1` (bearer) has `env.ok: true` and the providers you expect are `configured`
5. Settings → System health shows a recent cron tick within two minutes
