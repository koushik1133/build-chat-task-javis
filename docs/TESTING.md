# Testing

## Unit tests (hermetic)

```
npm test            # = vitest run; no database, no network
```

Every `src/**/*.test.ts` file runs. Suites that need Postgres are wrapped in
`describe.skipIf(process.env.DB_INTEGRATION !== "1")`, so the default run reports
them as skipped.

## Integration tests (real route handlers + local Postgres)

Location: `src/__integration__/*.flow.test.ts`, harness in `src/__integration__/setup.ts`.

```
npm run test:integration                 # add to package.json (see below)
scripts/integration-db.sh                # same, and starts Postgres 17 if it is down
scripts/integration-db.sh billing        # one flow
DB_INTEGRATION=1 npx vitest run src/__integration__   # raw
```

Add this script to `package.json`:

```json
"test:integration": "DB_INTEGRATION=1 vitest run src/__integration__"
```

### How it works

- The tests import `GET/POST/...` straight from `src/app/api/**/route.ts`, build a
  `NextRequest`, and pass `{ params: Promise.resolve({...}) }` exactly as Next 15 does.
  No dev server, no browser, no Supabase login.
- `@/lib/auth/scope` and `@/lib/supabase/server` are mocked per file
  (`vi.mock(..., () => import("./setup").then(m => m.scopeMockFactory()))`). `setScope(org, { role, userId, can })`
  switches the synthetic caller: owner by default, `role: "viewer"` to assert 403s,
  `can: () => ...` to emulate an org-level area override, `setScope(null)` for 401.
  Public/token routes need no scope.
- Everything else is real: `src/lib/dsql.ts` against `DSQL_ENDPOINT=127.0.0.1`
  (loaded from `.env.local`; the harness forces localhost so it can never reach a
  remote cluster), `emitEvent` → `events`, notification outbox, share tokens, stock
  ledger, payments (simulated provider), webhooks (`WEBHOOKS_ALLOW_INSECURE=1` so a
  local `http.createServer` receiver is allowed).
- Each file creates a fresh organization + owner membership (`createTestOrg`) whose
  owner id is the data key for all module tables. `afterAll` runs `cleanupDataIds`,
  which discovers every table with a `user_id` column from `information_schema` and
  deletes that id's rows, plus known child tables (`quote_versions`,
  `quote_acceptances`, `invoice_payments`, `availability_rules`, `calendar_blocks`,
  `role_area_overrides`) and the org/memberships (including agency child orgs).
- Failures print the method, path, status and response body
  (`api(handler, path, { expect: 201 })`), so a 4xx/5xx is diagnosable from the test
  output alone. Fire-and-forget writes (`void emitEvent`, `void recordAudit`) are
  asserted with `expectEvent` / `waitForRows`, which poll briefly.

### Flows covered

| File | What it proves |
| --- | --- |
| `billing.flow.test.ts` | contact → quote w/ tracked product → send → public view (viewed) → OTP → e-sign accept (hashes, signature, consent snapshot) → INV auto-created → stock reserved → pay link → simulated payment → paid → stock consumed → webhook replay idempotent → quote/invoice PDFs → OTP-gated client decline releases stock → `expireQuotes` sweep |
| `booking.flow.test.ts` | 24×7 availability → booking type → public slots → book (contact upsert, cancel link email) → 409 double-book → portal lists it → cancel via token → crew link day view → clock in/out writes `time_entries` → revoke |
| `helpdesk.flow.test.ts` | SLA policy → widget ticket (CORS allow-list) → sequential numbers → internal note vs public reply (`first_responded_at`, pending, email) → customer reply reopens → `runSlaSweep` flags once → KB draft → publish → public help center + search |
| `records.flow.test.ts` | install pack (idempotent) → record coercion → move (event) → activity → links → migrate-legacy (idempotent, silent) → CSV/JSON export + audit |
| `team.flow.test.ts` | invite → accept via token (single-use, expiry 410) → viewer/member/admin matrix incl. per-call `can` override → audit rows via `/api/audit` → agency child workspace → switch cookie → rollup |
| `api-v1.flow.test.ts` | API keys w/ scopes → Bearer 401/403/200 + rate-limit headers → keyset cursor pagination incl. same-millisecond rows → Idempotency-Key replay / mismatch 422 → webhook subscribe → `fanOutNewEvents` → `deliverPending` to a local receiver → HMAC signature verifies → backoff → dead after `MAX_ATTEMPTS` → manual retry → unsubscribe → revoked key 401 |
| `credits.flow.test.ts` | welcome grant → usage debit (idempotent) → enforcement 402 through `/api/optimize/pricing` with a mocked LLM → checkout → `/p/credits/<token>` → simulated pay → ledger, replay, failure, expiry 410 |
| `import-export.flow.test.ts` | CSV preview + heuristic mapping → dry run → import → dedupe on re-import → export csv/json → spreadsheet formula guard |
| `privacy-and-mail.flow.test.ts` | consent ledger, notices, retention floors, DSR verify/export/anonymize + tombstones; simulated mailbox connect → inbound sync → disconnect. Each half self-skips (with a console note) when its tables are missing. |

### Conventions for new flows

1. One file per flow, `describeDb("…")` at the top level, `createTestOrg` in
   `beforeAll`, `cleanupDataIds([...])` in `afterAll` (push any extra data ids such as
   agency child org ids).
2. Assert three things for every step: response status + shape, the DB row, and the
   `events` row when the code emits one.
3. Keep global sweeps (`expireQuotes`, `runSlaSweep`, `fanOutNewEvents`,
   `deliverPending`) tolerant of other files' rows: assert on your own ids, not on
   totals.
