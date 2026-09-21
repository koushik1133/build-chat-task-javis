# Phase 2 — what shipped and how to verify it

Phase 2 turned the single-user app into an org-scoped, multi-role platform with
money, notifications, booking and a hardened perimeter. Work ran in five lanes.

## Shipped

| Lane | Scope | Key files |
|---|---|---|
| A | `requireScope` migration of API routes, org switcher, team + invites, sidebar/nav | `src/lib/auth/scope.ts`, `src/lib/app-nav.ts`, `src/app/api/team/**` |
| B | Notifications, audit log, soft delete, outbox email | `src/app/api/notifications/**`, `aws/migrations.sql` (LANE B) |
| C | Payments abstraction (simulated / Stripe / Razorpay), quotes, invoices, public pay pages | `src/lib/payments/**`, `src/app/api/payments/**`, `src/app/p/**` |
| D | Calendar, booking pages, client portal | `src/app/book/**`, `aws/migrations.sql` (LANE D) |
| E | Security headers, signup/login/reset hardening, CORS allow-list, docs, tests, CI | see below |

### Lane E files

* `src/lib/security-headers.ts`, `next.config.ts` — CSP + hardening headers.
* `src/lib/request-limits.ts` — `rateLimit(key, {limit, windowMs})`, `rateLimitAll`, `authRateLimit`, `clientIp`, `resetRateLimits`.
* `src/lib/auth/password-policy.ts`, `src/lib/auth/turnstile.ts`, `src/components/auth/turnstile-widget.tsx`.
* `src/app/api/auth/signup/route.ts` (rewritten), `src/app/api/auth/login/route.ts`, `src/app/api/auth/reset/route.ts`, `src/app/login/page.tsx`.
* `src/lib/cors.ts` applied to `src/app/api/leads/[siteId]`, `src/app/api/leads/widget/[siteId]`, `src/app/api/analytics/[siteId]`.
* `aws/migrations.sql` — `sites.allowed_origins`.
* Tests: `src/lib/__tests__/{cors,rate-limit,scope}.test.ts`, `src/app/api/__tests__/contract.test.ts` (team invite 401/403/200).
* `.github/workflows/ci.yml` — `npm audit --audit-level=high` (non-blocking) + migrations dry-run.
* `docs/SECURITY.md`, this file, `.env.example`.

## Manual verification

Run `npm run dev` and use a browser or `curl`.

### Security headers
```
curl -sI http://localhost:3001/login | grep -iE "content-security|x-frame|nosniff|referrer|permissions"
curl -sI http://localhost:3001/book/x | grep -iE "x-frame|frame-ancestors"   # no X-Frame-Options, frame-ancestors *
```
Expect `Content-Security-Policy-Report-Only` unless `CSP_ENFORCE=1`. Open any app page and confirm no CSP violations in the console before enforcing.

### Signup / login / reset
1. Sign up with a 9-character password → 400 "at least 10 characters". Use your email as password → 400.
2. Valid signup → success card "check your inbox"; confirm via the emailed link → lands on `/onboarding`.
3. Repeat signup 6× from one IP within an hour → 6th is `429`.
4. Sign in with a wrong password and with an unknown email → identical "Wrong email or password." (`401`).
5. Forgot password → always "If an account exists…" (`200`).
6. Set `NEXT_PUBLIC_TURNSTILE_SITE_KEY` + `TURNSTILE_SECRET_KEY` → the widget appears on the signup tab and the button stays disabled until solved. Unset both → no widget.

### CORS allow-list
```
SITE=<site uuid>
curl -si -X OPTIONS -H "Origin: https://evil.com" http://localhost:3001/api/leads/$SITE | grep -i access-control
```
With `PUBLIC_WIDGET_ORIGINS` unset → `Access-Control-Allow-Origin: *`. Set it to `https://good.com` (or `UPDATE sites SET allowed_origins='["https://good.com"]'`) → `evil.com` gets no ACAO header, `good.com` is echoed.

### requireScope isolation
`npx vitest run src/lib/__tests__/scope.test.ts` — asserts 401 when signed out, personal org bootstrap, viewer 403 on edit, owner allowed, no `supabase` key on the scope object, unknown cookie org falls back.

### Team invite 403
`npx vitest run src/app/api/__tests__/contract.test.ts` — viewer POSTing `/api/team/invite` gets `403 {error:"forbidden"}` and no INSERT runs.

### CI
Push a branch: the workflow now also runs `npm audit --audit-level=high` (never fails the build) and `node scripts/run-migrations.mjs --dry-run`.

## Environment matrix

| Variable | Required | Lane | Notes |
|---|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` | yes | — | also whitelisted in CSP `connect-src` |
| `SUPABASE_SERVICE_ROLE_KEY` | yes | — | admin client only; never returned by `requireScope` |
| `DSQL_ENDPOINT`, `DB_USER` | yes | — | Aurora DSQL |
| `NEXT_PUBLIC_APP_URL` | yes | — | used for email redirect links and the widget script |
| `PAYMENTS_PROVIDER` | no (default `simulated`) | C | `simulated` / `stripe` / `razorpay` |
| `PAYMENTS_SIMULATED_SECRET` | when simulated | C | HMAC for simulated webhooks |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` | when stripe | C | |
| `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET` | when razorpay | C | |
| `RESEND_API_KEY`, `EMAIL_FROM` | for email | B | notifications, invites, quotes, invoices |
| `TURNSTILE_SECRET_KEY`, `NEXT_PUBLIC_TURNSTILE_SITE_KEY` | no | E | both unset = skip |
| `CSP_ENFORCE` | no (default off) | E | `1` switches CSP from report-only to enforced |
| `PUBLIC_WIDGET_ORIGINS` | no | E | fallback CORS allow-list; unset = `*` |
| `CRON_SECRET` | yes | — | cron bearer |
