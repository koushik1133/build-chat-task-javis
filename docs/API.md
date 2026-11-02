# KernelHub REST API v1

Base URL: `https://<your-host>/api/v1` · Spec: `GET /api/v1/openapi.json` (public, generated from the route registry in `src/lib/public-api/registry.ts`).

## Authentication

```
Authorization: Bearer kh_…
```

Create keys under **Settings → API keys**. A key carries scopes:

| Scope | Grants |
| --- | --- |
| `read:<area>` | GET routes for that area |
| `write:<area>` | POST/PATCH/DELETE for that area (implies `read:<area>`) |
| `mcp` | legacy full access (MCP clients) |

Areas: `crm`, `tasks`, `billing`, `calendar`, `helpdesk`, `settings` (others are reserved). A key's data scope is its owner's workspace (`organizations.owner_user_id`).

Missing/invalid key → `401`; wrong scope → `403`; `600` requests/min per key → `429` with `Retry-After`. Every authenticated response carries `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset` (unix seconds).

## Conventions

- **Envelope**: success `{ "data": …, "meta": { "next_cursor": … } }`; errors `{ "error": { "code", "message", "details?" } }`.
- **Codes**: `unauthorized`, `forbidden`, `not_found`, `bad_request` (400), `validation_failed`/`unprocessable` (422), `conflict` (409), `rate_limited` (429), `idempotency_mismatch` (422), `idempotency_in_progress` (409), `internal` (500).
- **Pagination**: lists are newest first; pass `?limit=` (default 50, max 200) and `?cursor=` from `meta.next_cursor` until it is `null`. Cursors are opaque (base64url of `created_at|id`).
- **Idempotency**: send `Idempotency-Key: <≤255 chars>` on any POST. Same key + same body within 24h → stored response with `Idempotent-Replay: true`; same key + different body → `422 idempotency_mismatch`.
- **Money** is integer minor units (`total_minor`), currencies are ISO 4217. **Timestamps** are ISO-8601 UTC.
- **Body limit** 1 MB; unknown fields in request bodies are rejected.
- **Events**: writes emit the same events the UI emits (`crm.contact.created`, `invoice.paid`, …) so agent triggers and webhooks fire regardless of surface.

## Resources

| Resource | Routes | Scope |
| --- | --- | --- |
| Me | `GET /me` | `read:settings` |
| Contacts | `GET /contacts?q=&lifecycle=&domain=` · `POST /contacts` · `GET/PATCH/DELETE /contacts/{id}` | `crm` |
| Tasks | `GET /tasks?done=` · `POST /tasks` · `GET/PATCH/DELETE /tasks/{id}` | `tasks` |
| Quotes | `GET /quotes?status=` · `POST /quotes` · `GET /quotes/{id}` · `POST /quotes/{id}/send` | `billing` |
| Invoices | `GET /invoices?status=` · `POST /invoices` · `GET /invoices/{id}` · `POST /invoices/{id}/send` · `POST /invoices/{id}/payments` | `billing` |
| Products | `GET /products?q=&kind=&low=` · `POST /products` · `GET/PATCH /products/{id}` · `POST /products/{id}/stock` | `billing` |
| Bookings | `GET /bookings?from=&to=&status=` · `GET /bookings/{id}` · `POST /bookings/{id}/cancel` · `GET /booking-types` · `GET /availability?booking_type_id=&from=&to=` | `calendar` |
| Tickets | `GET /tickets?status=&priority=&q=` · `POST /tickets` · `GET /tickets/{id}` · `POST /tickets/{id}/replies` | `helpdesk` |
| Records | `GET /record-types` · `GET/POST /records/{type}` · `GET/PATCH /records/{type}/{id}` · `POST /records/{type}/{id}/move` | `crm` |
| Events | `GET /events?type=&since=` | `read:settings` |
| Webhooks | `GET/POST /webhooks` · `GET/PATCH/DELETE /webhooks/{id}` · `GET /webhooks/sample/{event}` | `settings` |

Request/response shapes are in the OpenAPI document; `{type}` for records is a record-type id or slug.

### Examples

```bash
# list
curl "$BASE/contacts?limit=20" -H "Authorization: Bearer $KEY"

# create (idempotent)
curl -X POST "$BASE/contacts" -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -H "Idempotency-Key: $(uuidgen)" \
  -d '{"full_name":"Ada Lovelace","email":"ada@example.com"}'

# record a manual payment
curl -X POST "$BASE/invoices/$INV/payments" -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"amount_minor":125000,"reference":"bank-7781"}'

# availability for a booking type, next 7 days
curl "$BASE/availability?booking_type_id=$BT&to=$(date -u -v+7d +%FT%TZ)" -H "Authorization: Bearer $KEY"
```

## Webhooks

Subscriptions live under **Settings → Webhooks** or `POST /webhooks` (`{ url, event_types?, description? }`; the signing `secret` is returned once). `event_types` accepts exact types, prefixes like `invoice.*`, or `["*"]`.

Each matching event becomes one delivery per subscription:

```
POST <url>
Content-Type: application/json
X-KernelHub-Event: invoice.paid
X-KernelHub-Delivery: <delivery id>        # unique; de-duplicate on this
X-KernelHub-Signature: t=<unix>,v1=<hex hmac-sha256(secret, "<t>.<raw body>")>

{ "id": "<delivery id>", "type": "invoice.paid", "created_at": "…", "entity": "invoice", "entity_id": "…", "data": { … } }
```

- Respond `2xx` within 10 s. Redirects are not followed.
- Retries after failure: 1m, 5m, 30m, 2h, 12h, then `dead`. 20 consecutive failures disable the subscription (re-enable from the UI or `PATCH { "active": true }`).
- Verify: recompute the HMAC over the raw body, compare in constant time, reject `|now − t| > 300s`. `src/lib/webhooks/sign.ts` has a reference `verifySignature`.
- `GET /webhooks/sample/{event}` returns a representative payload.
- Endpoint URLs must be public `https://` hosts (no IP literals, localhost or internal suffixes). For local testing set `WEBHOOKS_ALLOW_INSECURE=1` (non-production only) to allow `http://localhost`.
- Secrets are encrypted at rest with `CREDENTIAL_ENCRYPTION_KEY`; without it they are stored with a `plain:` prefix (development only).

Delivery is driven by the agents cron tick: `fanOutNewEvents(200)` turns new `events` rows into deliveries (watermark in `webhook_cursors`) and `deliverPending(50)` posts due ones.

### Zapier / Make (REST hooks)

- **Subscribe**: `POST /webhooks` with `{ "url": "<target>", "event_types": ["crm.contact.created"] }` → store `data.id`.
- **Unsubscribe**: `DELETE /webhooks/{id}`.
- **Sample / perform list**: `GET /webhooks/sample/crm.contact.created`, or `GET /events?type=crm.contact.created&limit=3` for real recent payloads.
- **Polling fallback**: `GET /events?since=<iso>`.
- Key needs `write:settings` plus the areas the Zap's actions use.

## Event types

See `EVENT_TYPES` in `src/lib/events/bus.ts`. Phase 4 adds `quote.created`, `quote.sent`, `invoice.created`, `invoice.sent`, `invoice.paid` (now emitted when an invoice settles), `ticket.replied`, `product.created`, `product.stock_changed`.

## Database

`aws/phase4/a.sql`: `api_idempotency`, `webhook_subscriptions`, `webhook_deliveries`, `webhook_cursors`, plus keyset indexes on `crm_contacts` and `events`.
