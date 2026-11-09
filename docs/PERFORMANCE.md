# Performance & scale (Phase 6, lane D)

How KernelHub keeps list pages fast as a workspace grows past a few hundred rows
per module. Covers the index audit, request-level caching, keyset pagination,
bundle splitting, route-level loading states and Core Web Vitals telemetry.

## 1. Query audit and indexes (`aws/phase6/d.sql`)

Every module table is keyed by `user_id` (the org data id). Each list query was
checked for an index whose prefix matches `WHERE user_id = $1 [AND filter]` and
whose remaining columns match the `ORDER BY`. Missing composites were added as
`CREATE INDEX ASYNC IF NOT EXISTS` (DSQL dialect). Apply locally with
`sed 's/ ASYNC//g' aws/phase6/d.sql | psql -h 127.0.0.1 -U $DB_USER -d ${DB_NAME:-postgres}`.

| Query (route → shape) | Index added |
| --- | --- |
| `GET /api/tasks` → `WHERE user_id ORDER BY created_at DESC, id DESC` | `idx_tasks_user_created_id (user_id, created_at, id)` |
| `GET /api/helpdesk/tickets?cursor=` → `WHERE user_id [AND status IN …] ORDER BY created_at DESC, id DESC` | `idx_tickets_user_created_id`, `idx_tickets_user_status_created` |
| Tickets default priority sort → `… ORDER BY CASE status…, CASE priority…, updated_at DESC` | `idx_tickets_user_updated (user_id, updated_at)` |
| `GET /api/records/[type]?order=created` → `WHERE user_id AND type_id AND deleted_at IS NULL ORDER BY created_at DESC, id DESC` | `idx_records_user_type_created_id` |
| `GET /api/products?order=created` → `WHERE user_id AND deleted_at IS NULL [AND active] ORDER BY created_at DESC, id DESC` | `idx_products_user_created_id` |
| `GET /api/expenses?order=created`, `GET /api/time?order=created` | `idx_expenses_user_created_id`, `idx_time_entries_user_created_id` |
| `GET /api/crm/contacts` (legacy `ORDER BY updated_at DESC`; lifecycle filter + keyset) | `idx_crm_contacts_user_updated`, `idx_crm_contacts_user_lifecycle_created` (keyset itself uses the existing `crm_contacts_user_created`) |
| `GET /api/audit?cursor=` → `WHERE user_id [AND entity] ORDER BY created_at DESC, id DESC` | `idx_audit_log_user_created_id`, `idx_audit_log_user_entity_created` |
| `GET /api/notifications/outbox` list + bell (`channel='in_app' AND status='sent' AND read_at IS NULL`) | `idx_notification_outbox_user_created_id`, `idx_notification_outbox_user_channel_status_created` |
| `GET /api/ai/credits` ledger keyset | `idx_ai_credit_ledger_user_created_id` |
| `requireScope()` org switch → `memberships WHERE user_id AND org_id AND status='active'` | `idx_memberships_user_org` |
| `effectivePermissions()` → `role_area_overrides WHERE org_id AND role` | `idx_role_area_overrides_org_role` |
| `buildChannelNav()` → `social_accounts WHERE user_id AND connected GROUP BY platform` | `idx_social_accounts_user_connected` |
| `GET /api/bookings?status=` → `WHERE user_id AND starts_at < $3 AND ends_at > $2 [AND status]` | `idx_bookings_user_status_starts` |

Keyset predicates compare `date_trunc('milliseconds', created_at)` (see
`src/lib/public-api/pagination.ts`), which Postgres can still satisfy from the
`(user_id, created_at, id)` index because `user_id` equality narrows the scan
and the sort is a top-N over that prefix. `ILIKE '%q%'` search terms cannot use
a b-tree; they are bounded by the user_id prefix and the page LIMIT.

`scripts/explain.mjs` runs `EXPLAIN (FORMAT JSON)` (no ANALYZE) for the ten
hottest shapes against local Postgres and prints the index used; it exits 1 if
a table with ≥1k rows falls back to a sequential scan.

### N+1 review

`src/lib/**` was scanned for `for … await query` / `map(async …)` loops. The
remaining loops are either per-row *writes* that must run individually
(stock movements, SCIM provisioning, retention policies, demo seed) or already
batched via `= ANY($1::text[])` (`getProductsByIds`, `countsBy` in system
status, outbox mark-read, audit cleanup). No read-side N+1 was found in the list
routes; `src/lib/home/summary.ts` fans out with `Promise.all` and one
`getOrgSettings` call, which is now request-memoised (below).

## 2. Request-level caching (`src/lib/request-cache.ts`)

`requestMemo(fn)` wraps a loader in `React.cache()` when the runtime React
exposes it (the App Router's bundled React does; the `react@18` in
`package.json` used by Vitest does not, so it degrades to a passthrough). The
memo is scoped to one server render / route-handler invocation and cannot leak
across requests or tenants.

Memoised loaders — behaviour is identical, the SELECT just runs once per request:

- `getOrgSettings(dataId)` — the (app) layout called it directly **and** through
  `getRequestLocale()`, and `buildHomeSummary()` calls it again.
- `getBranding(dataId)` — public layouts, email wrappers and `generateMetadata`.
  `updateBranding()` re-reads through the uncached `loadBranding()` after the write.
- `buildChannelNav(dataId)` — layout and sidebar.
- `listUserOrgs(userId)` and the three lookups inside `requireScope()` (personal
  org bootstrap, membership JOIN, role overrides) — pages and nested route
  handlers call `requireScope()` several times per request.

Tests: `src/lib/__tests__/request-cache.test.ts` mocks `@/lib/dsql`, wraps each
uncached loader with a Map-backed cache implementation and asserts one query per
key, plus a passthrough test for the no-cache case.

## 3. Server-side pagination

All large lists accept `?cursor=&limit=` (keyset, `created_at DESC, id DESC`,
opaque base64url cursor, `limit` clamped to 1..200) and return `next_cursor`
(`null` on the last page). Filters and search compose with the cursor.

| Endpoint | Default behaviour (no params) | Paged mode |
| --- | --- | --- |
| `GET /api/crm/contacts` | first 50 newest + `next_cursor` (was 200 by `updated_at`) | `cursor`, `limit`, `q`, `domain`, `lifecycle` |
| `GET /api/tasks` | first 50 + `next_cursor` | `cursor`, `limit` (TIMESTAMP column read via `AT TIME ZONE 'UTC'`) |
| `GET /api/helpdesk/tickets` | first 50 newest + `next_cursor` + `policies` | `cursor`, `limit`, `status`, `priority`, `q`, `contact_id` |
| `GET /api/records/[type]` | board payload (all rows by `updated_at`, `next_cursor: null`) | `order=created` or `cursor` → 50/page |
| `GET /api/products` | all by name, `next_cursor: null` | `order=created` or `cursor` |
| `GET /api/expenses`, `GET /api/time` | legacy ordering, `next_cursor: null` | `order=created` or `cursor` |
| `GET /api/audit` | 50 + `next_cursor` (and legacy `nextBefore`) | `cursor`, `entity`, `entityId` |
| `GET /api/notifications/outbox` | 100 + `next_cursor` | `cursor`, `channel`, `status` |
| `GET /api/ai/credits` | 50 ledger rows + `ledger_next_cursor` | `cursor`, `limit` |

UI: `src/components/ui/load-more.tsx` — `<LoadMore>` renders an `aria-live`
count ("Showing 150 contacts · more available"), a keyboard-reachable **Load
more** button and an `IntersectionObserver` sentinel that fetches the next page
when scrolled into view (240 px lookahead). Pages wired: CRM, tasks, helpdesk,
inventory (products), finance (expenses + time), records table view, Settings →
Audit log, Settings → Outbox. Appended pages are de-duplicated by `id`.

## 4. Bundle splitting

Static import analysis (no `next build` in this environment):

- `react-markdown` + `remark-gfm` + `highlight.js/lib/common` were imported
  statically by `src/components/markdown.tsx`, which chat, knowledge, strategy,
  marketplace, github panel and the public help center all import. The renderer
  now lives in `markdown-impl.tsx` and `Markdown` is a `next/dynamic` wrapper
  with a skeleton (SSR kept so help articles stay crawlable).
- `CommandPalette` (16 icons + search logic) and `CopilotDrawer` (message list,
  tool calls, approvals) are mounted on every (app) page but closed on first
  paint: bodies moved to `*-body.tsx`, wrappers use `dynamic(…, { ssr: false })`.
  `OPEN_COPILOT_EVENT` moved to `src/components/copilot-events.ts` (re-exported).
- `ProductTour` is `dynamic` in `app-shell.tsx`; the 500-line `OnboardingWizard`
  is `dynamic` in `(app)/onboarding/page.tsx`.
- `pptxgenjs` / `pdf-parse` are only referenced from route handlers
  (`api/strategy/export`, `api/build/resume`, `lib/chunk.ts`) — never in a client bundle.
- `lucide-react`: every import is a named import (`import { X } from "lucide-react"`);
  no namespace or default imports exist (grep-verified).

## 5. Rendering

- `loading.tsx` skeletons (shared `src/components/ui/page-skeleton.tsx`, built on
  the kit's `Skeleton`) for `home`, `crm`, `tasks`, `helpdesk`, `inventory`,
  `finance`, `billing`, `calendar`, `r/[type]` and `settings/*`.
- Help center article page: `export const revalidate = 60` (ISR per org/slug);
  the view counter moved to a client beacon → `POST /api/help/view` (anonymous,
  rate-limited, strict schema) so cached pages still count.
- Public booking slots `GET /api/book/[org]/[type]`: `force-dynamic` +
  `Cache-Control: no-store`.
- The large (app) pages are client components by design (optimistic edits,
  dialogs, filters) — converting them was judged risky and skipped.

## 6. Web Vitals

- `src/components/web-vitals.tsx` — `useReportWebVitals`, 10% per-page-load
  sampling (`NEXT_PUBLIC_VITALS_SAMPLE` overrides), `sendBeacon` to `/api/vitals`.
  Mount once in `src/app/layout.tsx`: `<WebVitals />` (import from `@/components/web-vitals`).
- `POST /api/vitals` — anonymous, zod `.strict()`, per-IP + global rate limit,
  body capped at 2 KiB, 204/202 (never retried).
- Table `web_vitals (id, path, name, value, rating, navigation_type, created_at)`
  — no PII; `path` is normalised (`/crm/[id]`). `pruneVitals(days)` is available
  for a cron hook.
- `GET /api/system/status` now returns `vitals: { global: true, windowHours, rows[] }`
  (p75 + sample count + good share per route/metric over 24 h, via
  `percentile_cont`). Settings → System health renders it with a
  "Global · all workspaces" label because the aggregate is deployment-wide,
  not tenant-scoped.

## 7. Verification

- `src/__integration__/perf.flow.test.ts` seeds 500 contacts + 300 tickets,
  walks every cursor to exhaustion (no gaps/dupes, filters + search with
  cursors, bad cursor → 400), logs per-page latency against a 300 ms soft
  budget, checks the EXPLAIN plans and exercises the vitals pipeline end to end.
  Run with `DB_INTEGRATION=1 npx vitest run src/__integration__/perf.flow.test.ts`.
- `node scripts/explain.mjs [--json]` — EXPLAIN report for the ten hottest queries.
