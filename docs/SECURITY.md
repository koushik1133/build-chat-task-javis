# Security model

This document summarises how KernelHub protects tenant data and which controls
are real versus simulated. It is the reference for reviewers and for anyone
extending the platform in Phase 3+.

## Threat model (summary)

| Threat | Primary control |
|---|---|
| Cross-tenant data access | Every data query keys on `scope.dataId` from `requireScope()`; org membership + role checked per request |
| Credential stuffing / signup abuse | Per-IP rate limits (5/hour, 20/day) on signup, login, reset; optional Turnstile on signup; generic error messages |
| Account enumeration | Signup, login and reset return identical bodies whether or not the email exists |
| XSS on app pages | CSP (report-only by default, `CSP_ENFORCE=1` to enforce), `X-Content-Type-Options`, generated-site HTML never rendered inside the app origin |
| Clickjacking | `X-Frame-Options: DENY` + `frame-ancestors 'none'` everywhere except public embed routes (`/p/*`, `/book/*`, widget script) |
| Public endpoint abuse (lead forms, widget, analytics) | Body size cap (16 KB), payload sanitiser, per-site enrichment throttle, CORS allow-list |
| Forged webhooks (payments, Twilio) | Provider signature verification (`src/lib/payments/*`, `src/lib/twilio-webhook.ts`) |
| Token leakage for public links | Only `sha256(token)` is stored (`share_tokens.token_hash`, `memberships.invite_token_hash`); raw token appears once in the response |
| Service-role key exposure | `requireScope()` never returns a Supabase client; the admin client is created lazily only in the few routes that need it |

## Authentication

* Supabase Auth via `@supabase/ssr`. Session cookies are refreshed in `src/middleware.ts`.
* API routes call `requireUser()` (validates with `auth.getUser()`, never trusts the cookie alone).
* Sign-up: `POST /api/auth/signup` → `supabase.auth.signUp` with `emailRedirectTo` → user confirms by email → `/auth/callback` exchanges the code. No admin `createUser` / auto-confirm.
* Password policy (`src/lib/auth/password-policy.ts`): minimum 10 characters, max 128, must not equal the email or its local part. Enforced server-side and mirrored in the UI.
* Login: `POST /api/auth/login` (server-side `signInWithPassword`, rate limited). Magic link and Google OAuth still go directly through the Supabase browser client.
* Password reset: `POST /api/auth/reset` — always `200 { ok: true }`.
* Optional bot check: Cloudflare Turnstile on signup when `TURNSTILE_SECRET_KEY` is set (`src/lib/auth/turnstile.ts`). Unset = skipped silently.

## Authorization and org scoping

`src/lib/auth/scope.ts`:

* Each user gets a personal organization on first request (`ensurePersonalOrg`).
* The active org comes from the `kh_org` cookie (or an explicit `orgId`); an unknown/foreign org id silently falls back to the personal org.
* `requireScope({ area, edit })` resolves the caller's role and effective permission matrix (`DEFAULT_MATRIX` + `role_area_overrides`) and throws `ScopeError("FORBIDDEN")` → 403 when the check fails.
* `scope.dataId` is the `user_id` under which the org's rows live. Routes must use it instead of `user.id`.
* The returned `Scope` object contains only ids, role, permissions and `can()` — never a Supabase client (guarded by `src/lib/__tests__/scope.test.ts`).

## Public token endpoints

* Client portal (`/p/*`), quotes/invoices/pay pages and booking (`/book/*`) are reached through random 32-byte tokens. The database stores only the SHA-256 hash; lookups hash the presented token.
* Team invites (`/invite/<token>`) work the same way (`memberships.invite_token_hash`) and are rate limited per inviter (20/hour).
* These routes are embeddable (`frame-ancestors *`) and must never expose data beyond the single record the token references.

## Webhook verification

* Stripe: `STRIPE_WEBHOOK_SECRET`, signature checked with the SDK before any state change.
* Razorpay: HMAC-SHA256 with `RAZORPAY_WEBHOOK_SECRET`, compared with `timingSafeEqual`.
* Simulated provider: HMAC with `PAYMENTS_SIMULATED_SECRET`; no money moves.
* Twilio (SMS / voice / WhatsApp): request signature validated in `src/lib/twilio-webhook.ts`; `TWILIO_SKIP_SIGNATURE_VERIFICATION=true` is for local development only.
* Cron: `CRON_SECRET` bearer check.

## Response headers

Defined once in `src/lib/security-headers.ts` and wired through `next.config.ts` `headers()`.

| Header | Value |
|---|---|
| `Content-Security-Policy[-Report-Only]` | `default-src 'self'`; scripts `'self' 'unsafe-inline'` (+ `'unsafe-eval'` in dev, + Turnstile origin when enabled); styles `'self' 'unsafe-inline' fonts.googleapis.com`; fonts `'self' data: fonts.gstatic.com`; images `'self' data: blob: https:`; connect `'self'` + Supabase URL (+ `ws:`/`wss:` in dev); `frame-ancestors 'none'` (or `*` on embed routes); `object-src 'none'`; `base-uri 'self'`; `form-action 'self'` |
| `X-Frame-Options` | `DENY` (omitted on `/p/*`, `/book/*`, `/api/leads/widget/*`) |
| `X-Content-Type-Options` | `nosniff` |
| `Referrer-Policy` | `strict-origin-when-cross-origin` |
| `Permissions-Policy` | `camera=(), microphone=(), geolocation=()` |
| `Strict-Transport-Security` | `max-age=63072000; includeSubDomains; preload` (production only) |

CSP ships **report-only** so a stray inline script cannot take the app down. Watch the browser console for violations, then set `CSP_ENFORCE=1`.

## CORS for public endpoints

`src/lib/cors.ts` applies to `/api/leads/[siteId]`, `/api/leads/widget/[siteId]` and `/api/analytics/[siteId]`:

1. `sites.allowed_origins` (JSON array or comma list) for the site, else
2. `PUBLIC_WIDGET_ORIGINS` env, else
3. wildcard `*` (anonymous form endpoints; an empty list must not break existing embeds).

Non-matching origins receive no `Access-Control-Allow-Origin` header, so the browser blocks the response. Preflights answer `204`.

## Rate limits

In-process fixed windows (`src/lib/request-limits.ts`). They bound a single instance and are a cost/abuse guard, not a hard security control; move to the datastore if multi-instance enforcement is required.

| Endpoint | Key | Limit |
|---|---|---|
| `POST /api/auth/signup` | IP | 5/hour, 20/day |
| `POST /api/auth/login` | IP | 5/hour, 20/day |
| `POST /api/auth/reset` | IP | 5/hour, 20/day |
| `POST /api/team/invite` | user | 20/hour |
| Lead enrichment (LLM) | site | 20/hour |

## What is simulated

* Payments default to `PAYMENTS_PROVIDER=simulated`: checkout and webhooks are signed with `PAYMENTS_SIMULATED_SECRET` and mark invoices paid without any real charge.
* Rate limits are per process (see above).
* CSP is report-only until `CSP_ENFORCE=1`.
* Turnstile is inactive unless both keys are set.
