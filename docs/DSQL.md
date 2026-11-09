# Aurora DSQL compatibility

Production runs on Aurora DSQL (PostgreSQL-compatible, with documented restrictions). Every local and CI test
runs on Postgres 17, so DSQL differences are enforced by a static lint plus a handful of runtime helpers.
Items marked **verify** are our best knowledge of the DSQL docs and must be re-checked against the current
documentation or a live cluster before go-live (see the checklist at the end).

## Constraints and how the repo copes

| Constraint | Status | How we cope |
|---|---|---|
| No foreign keys | verified-by-docs | No `REFERENCES`; integrity enforced in code. Lint `DSQL001`. |
| No triggers, PL/pgSQL, sequences/SERIAL, extensions | verified-by-docs (sequences/functions: **verify**, support is evolving) | ids are TEXT (`randomUUID`), human numbers via counter rows (`src/lib/docs/numbering.ts`). Lint `DSQL002-005`. |
| No TRUNCATE, no temp tables | verified-by-docs | Batched deletes. Lint `DSQL006/007`, `DSQLS01/05`. |
| Indexes must be `CREATE INDEX ASYNC`, one per statement | verified-by-docs | All migrations use `ASYNC`; the runner strips it locally and polls `sys.jobs` on DSQL. Lint `DSQL008`. |
| Partial indexes (`... WHERE`) | **verify** (treated as unsupported) | `uq_invoice_payments_provider_ref` replaced by a total unique index on `ref_key` (see below). Lint `DSQL009`. |
| Expression indexes | **verify** | Lint warning `DSQL010`; none in use. |
| `ADD COLUMN` takes only name + type | **verify** (older clusters reject DEFAULT/NOT NULL) | Every new `ADD COLUMN IF NOT EXISTS x TYPE`; defaults set in code. Five legacy statements (pre-Phase 3) carry a DEFAULT and are allow-listed. Lint `DSQL011`. |
| Only ADD COLUMN / RENAME in `ALTER TABLE` | **verify** | Lint `DSQL012`. |
| json/jsonb/array/xml/money as column types | **verify** | JSON stored as TEXT. Lint `DSQL014`. |
| One DDL per transaction; DDL cannot mix with DML | verified-by-docs | The runner executes one statement per query; lint `DSQL013` rejects chained statements. |
| <= 3,000 rows and ~10 MiB per transaction; 5 min | verified-by-docs | Bulk writes go through `src/lib/db/batch.ts` (<= 1000 rows/statement). |
| Optimistic concurrency (`40001`, `OC000` data conflict, `OC001` schema change) | verified-by-docs | `withRetry` (4 attempts, jittered exponential backoff capped at 1 s) around every `transaction()` (enforced by `src/lib/db/occ-audit.test.ts`). `isConcurrencyConflict` recognises all three. |
| `SELECT ... FOR UPDATE` | **verify** (a conflict hint, not a lock; no `SKIP LOCKED`) | Not used. Claims are atomic conditional `UPDATE ... RETURNING` (e.g. receiving). Lint `DSQLS02`. |
| No LISTEN/NOTIFY, no advisory locks | verified-by-docs | Not used. Lint `DSQLS03/04`. |
| `information_schema` may be partial | **verify** | `src/lib/db/catalog.ts`: information_schema, then `to_regclass`, then `pg_catalog`. Used by `tableExists` and the tenant export. |
| `percentile_cont` ordered-set aggregate | **verify** | `summariseVitals` falls back to computing p75 in JS from <= 20,000 raw rows. |
| `jsonb` casts | json/jsonb are runtime-only types (verified-by-docs); operator coverage **verify** | Report compiler uses `data::json ->> key`. |
| `= ANY($1::text[])`, `ILIKE`, `to_char`, `date_trunc`, `AT TIME ZONE`, `generate_series`, `RETURNING`, `ON CONFLICT` | core Postgres surface; believed supported, **verify** on a live cluster | Used widely; covered by the live smoke list below. |
| `WITH ... AS (UPDATE ... RETURNING)` CTE writes (`procurement/receiving.ts`) | **verify** | Single statement, atomic; if rejected, rewrite as conditional UPDATE + follow-up INSERT inside `withRetry`. |
| `COMMENT ON`, materialized views | **verify** (unsupported) | Not used. Lint `DSQL015/017`. |

## Phase 10 corrections (`aws/phase10/a.sql`)

Applied migration statements are hash-tracked and never edited, so fixes are new statements:

1. `invoice_payments.ref_key TEXT` (no default). `recordPayment` / `createPayLink` write `ref_key = COALESCE(provider_ref, id)` through `insertPaymentRow`,
   which falls back to the old column list until the column exists.
2. `DROP INDEX IF EXISTS uq_invoice_payments_provider_ref` (the partial index) and
   `CREATE UNIQUE INDEX ASYNC ... uq_invoice_payments_ref_key ON invoice_payments (invoice_id, provider, ref_key)`.
   Legacy rows keep `ref_key` NULL (NULLs are distinct) and stay protected by the application lookup in `recordPayment`.
   No backfill is run: a single UPDATE could exceed 3,000 rows.
3. Eight `CREATE INDEX ASYNC IF NOT EXISTS agency_*` statements re-create the Phase-1 indexes that were written without `ASYNC`.

## Batching (`src/lib/db/batch.ts`)

- `inBatches(items, size, fn)`, `chunk`, `insertInBatches(table, cols, rows, size)`.
- `deleteInBatches(table, where, params, size)` uses `WHERE id IN (SELECT id ... LIMIT n)` and loops until a short batch.
- `updateInBatches(table, set, where, whereParams, setParams, size)` pages by primary key so rows that still match are not revisited.
- `runBatchedStatement(sql, params)` rewrites a simple `DELETE`/`UPDATE ... WHERE` (used by the DSR eraser).
- Size is always clamped to `MAX_BATCH = 1000`. A single call stops after 50 batches (one cron tick stays bounded).

Call sites capped: retention sweep (limit clamped to 1000, ticket child rows batched), DSR erase/anonymise, demo clear (500 ids per statement),
rate-limit and web-vitals pruning, campaign recipient/click/enrolment cleanup, notification mark-all-read, KB category / milestone / SLA reassignment,
connection teardown (accounting, calsync, mail, documents, webhooks, automations, reports, marketplace, quotes).
Already bounded: attachment purge (<= 1000 per run, per-row statements), import (inserts in chunks of 100, each its own transaction),
snapshot apply (one object per statement), campaign launch (per-row inserts, resolve capped at 5,000 reads).

## Lint

`npm run lint:dsql` runs `scripts/dsql-lint.mjs` (no dependencies) over `aws/migrations.sql`, `aws/phase*/*.sql` (DDL rules `DSQL001-017`)
and `src/**/*.ts(x)` (source rules `DSQLS01-11`). Rules, rationale and fix hints live in `src/lib/dsql-compat/rules.ts`; the report prints
rule id, `file:line`, severity, rationale and fix. Exit code 1 on any non-allow-listed error. Intentional exceptions go in
`scripts/dsql-lint.allow.json` (rule + file + optional excerpt + a mandatory reason). A unit test runs the DDL rules against the real
migration files and fails on any error or stale/reasonless allow entry.

## Migration runner (`scripts/run-migrations.mjs`) review

- Executes one statement per `client.query` (autocommit), so the one-DDL-per-transaction rule holds.
- Strips `ASYNC` only for local Postgres. **Fixed:** on DSQL it now polls `sys.jobs` for the returned `job_id` (up to 5 min) so a failed
  index build is not recorded as applied. Polling problems only warn. Needs a live check.
- Reads only `aws/migrations.sql`; `aws/phase*/*.sql` are folded into it by the release process, not run directly.
- Known looseness (not changed): any error containing "already exists" or "does not exist" is treated as already-applied, which can hide a
  `DROP`/`ALTER` against a missing table. Review the runner output.

## Go-live checklist

1. `npm run lint:dsql`, `npx tsc --noEmit`, `npx vitest run`, `npm run test:integration` (Postgres 17) all green.
2. Fold `aws/phase10/a.sql` into `aws/migrations.sql` (append, do not edit earlier lines); `npm run migrate:dry` and review.
3. `npm run migrate` against the DSQL endpoint with IAM admin credentials. Confirm every `CREATE INDEX ASYNC` job is `completed`
   (`SELECT job_id, status, details FROM sys.jobs`).
4. Set `RATE_LIMIT_STORE` and other env vars from `src/lib/env/vars.json`; `npm run smoke` against the deployed URL.
5. Run the manual verification list below. `npm run test:integration` cannot target DSQL (it assumes Postgres 17), so these are manual.

## Needs a live DSQL check

- [ ] `ALTER TABLE ... ADD COLUMN` with no modifiers succeeds; confirm the legacy `DEFAULT` columns exist (`site_leads.status`, `user_integrations.whatsapp_provider`, `messaging_auto_reply`, `ai_budgets.credits_enforced`, `organizations.kind`).
- [ ] `DROP INDEX IF EXISTS` and `CREATE UNIQUE INDEX ASYNC` (phase10) complete; a duplicate payment insert returns SQLSTATE 23505.
- [ ] Unique index NULL semantics: several `invoice_payments` rows with NULL `ref_key` coexist.
- [ ] `to_regclass('public.x')` and `pg_catalog.pg_tables` work; `information_schema.columns` coverage for the tenant export (`discoverTables`).
- [ ] `percentile_cont(...) WITHIN GROUP` (vitals): if it errors, confirm the JS fallback logs once and the page still renders.
- [ ] `data::json ->> $1` on a TEXT column (custom-field reports).
- [ ] `= ANY($1::text[])` with 500-element arrays; `ILIKE`; `to_char(date_trunc(...))`; `AT TIME ZONE $n`; `generate_series`.
- [ ] `WITH claim AS (UPDATE ... RETURNING ...) INSERT ...` in `procurement/receiving.ts`.
- [ ] `INSERT ... ON CONFLICT (cols) DO UPDATE` for each of the 21 call sites' unique indexes (indexes must be `ACTIVE` first).
- [ ] `UPDATE ... WHERE id IN (SELECT id ... ORDER BY id::text LIMIT n)` and `DELETE ... WHERE id IN (SELECT ... LIMIT n)` (batch helpers) with 1000 rows.
- [ ] OCC: run two concurrent `recordPayment` / booking requests and confirm one retries via `withRetry` instead of surfacing 500.
- [ ] Transaction limits: demo clear on a seeded org and a 2,500-row retention run complete without a limit error.
- [ ] `sys.jobs` polling in the migration runner (column names `job_id`, `status`, `details`).
