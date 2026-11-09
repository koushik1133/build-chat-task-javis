# Accounting sync (QuickBooks Online, Xero, simulated)

KernelHub pushes invoices, payments and expenses into your ledger and pulls back payments recorded there. The CSV export under **Reports** keeps working regardless.

## What syncs

| KernelHub | QuickBooks Online | Xero | When |
| --- | --- | --- | --- |
| CRM contact | Customer | Contact | Before its first invoice / payment |
| Invoice (sent, partially paid, paid, overdue) | Invoice | Invoice (ACCREC) | On `invoice.sent` / `invoice.paid`, on edit, or manually |
| Payment (succeeded) | Payment linked to the Invoice | Payment on the Invoice | After its invoice is linked |
| Expense | Purchase (Cash) | BankTransaction (SPEND) | On `expense.created` |
| Product | Item | Item | Manually (Push now / `accounting.push_invoice` uses linked items when present) |
| Payment recorded in the ledger | Payment (CDC) | Payment (If-Modified-Since) | Every pull; recorded locally as provider `accounting:<provider>` |

Each pushed record is tracked in `accounting_links` (`remote_id`, payload hash). Unchanged records are skipped; changed ones are updated in place (QBO: sparse update with the live `SyncToken`; Xero: POST with the id). Payments we pushed are never pulled back, and pulled payments are never pushed back, so nothing is double-counted.

## Environment

| Variable | Purpose |
| --- | --- |
| `CREDENTIAL_ENCRYPTION_KEY` | Required for QuickBooks and Xero: tokens are stored encrypted (also signs the OAuth CSRF state). |
| `QBO_CLIENT_ID`, `QBO_CLIENT_SECRET` | Intuit app keys. |
| `QBO_ENV` | `sandbox` (default) or `production` — picks the API base URL. |
| `XERO_CLIENT_ID`, `XERO_CLIENT_SECRET` | Xero app keys. |
| `NEXT_PUBLIC_APP_URL` | Public origin used to build redirect URIs (falls back to the request origin). |

The simulated ledger needs nothing and stores every payload in `accounting_sim_objects` so you can see exactly what would be sent.

## Intuit (QuickBooks Online) developer app

1. Sign in at <https://developer.intuit.com> → **Dashboard → Create an app → QuickBooks Online and Payments**.
2. Under **Keys & credentials** copy the *Development* Client ID / Secret into `QBO_CLIENT_ID` / `QBO_CLIENT_SECRET` (use *Production* keys with `QBO_ENV=production` once the app passes Intuit's review).
3. Add the redirect URI: `https://<your-domain>/api/accounting/callback/quickbooks` (for local work `http://localhost:3001/api/accounting/callback/quickbooks`). Intuit requires HTTPS for everything except localhost.
4. Scope used: `com.intuit.quickbooks.accounting`. Create a sandbox company from the dashboard to test against.
5. In KernelHub open **Settings → Accounting → QuickBooks Online → Connect**, pick the company, then choose the income, expense, bank and tax-code mappings and press **Sync now**.

Notes: QBO refresh tokens rotate on every refresh and expire after 100 days of inactivity — the cron keeps them warm. Change Data Capture only reaches back 30 days; the pull cursor is clamped accordingly.

## Xero developer app

1. Sign in at <https://developer.xero.com/app/manage> → **New app → Web app**.
2. Redirect URI: `https://<your-domain>/api/accounting/callback/xero` (Xero allows `http://localhost:3001/...` for development).
3. Generate a client secret under **Configuration** and set `XERO_CLIENT_ID` / `XERO_CLIENT_SECRET`.
4. Scopes requested: `openid profile email offline_access accounting.transactions accounting.contacts accounting.settings`. Uncertified apps may connect up to 25 organisations.
5. Connect from **Settings → Accounting → Xero**. The first organisation you authorise becomes the tenant (`Xero-Tenant-Id` header on every call).

Mapping tips: invoice and expense lines take an **account code**; payments and bank transactions take the **bank account id** — the mapping form lists the right identifier for each. Tax codes are Xero `TaxType` values (e.g. `OUTPUT`, `NONE`).

## Cron

The agents cron tick (`/api/cron/agents`) should call, in order:

```ts
import { processAccountingEvents, pushDue, pullDue } from "@/lib/accounting/sync";
counts.accounting_events = (await processAccountingEvents(200)).pushed; // auto-push on invoice.sent / invoice.paid / expense.created
counts.accounting_push   = (await pushDue(50)).pushed;                  // changed-since-last-push sweep
counts.accounting_pull   = (await pullDue(10)).recorded;                // payments entered in the ledger
```

`processAccountingEvents` keeps its own watermark in `accounting_cursors` (name `events`), independent of the webhook fan-out.

## Testing the full loop without a ledger

1. **Settings → Accounting → Simulated ledger → Connect.**
2. Send an invoice from **Billing** (or use *Push now* with kind `invoice`). The payload appears under *What would be sent* and the invoice row shows **Synced**.
3. `POST /api/accounting/simulate-payment { connection_id, invoice_id }` creates a remote payment and pulls it; the invoice becomes **paid** with a payment from provider `accounting:simulated`.

## API

| Route | Method | Area |
| --- | --- | --- |
| `/api/accounting/connections` | GET (list + providers), DELETE `?id=` | billing read / settings edit |
| `/api/accounting/connect/[provider]` | GET → OAuth redirect (simulated connects directly) | settings edit |
| `/api/accounting/callback/[provider]` | GET (OAuth return) | settings edit |
| `/api/accounting/connections/[id]` | GET (details + chart of accounts), PATCH `{settings,status}`, POST (sync now) | billing |
| `/api/accounting/connections/[id]/log` | GET `?status=&direction=&kind=&limit=` | billing read |
| `/api/accounting/links` | GET `?kind=invoice` → per-entity sync state | billing read |
| `/api/accounting/push` | POST `{kind,id,connection_id?,force?}` | billing edit |
| `/api/accounting/simulate-payment` | POST `{connection_id,invoice_id,amount_minor?}` (simulated only) | billing edit |

Agent tools: `accounting.sync_status` (read) and `accounting.push_invoice` (write, approval required).
