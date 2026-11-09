# Privacy & data lifecycle controls

KernelHub ships the controls a Data Fiduciary (DPDP Act 2023 / DPDP Rules) or controller (GDPR) needs, enforced in the data model and runtime rather than in a policy document. This page lists what exists, where it lives, and which duty it serves. It is engineering documentation, not legal advice: notice text, lawful grounds and retention periods are decided by your counsel and configured here.

## Where things live

| Control | Code | Storage | UI |
| --- | --- | --- | --- |
| Consent ledger | `src/lib/privacy/consent.ts` | `consent_records` (append-only) | Settings → Privacy & data → Consents; client portal → Privacy |
| Versioned notices | `src/lib/privacy/notices.ts` | `privacy_notices` (immutable versions) | Notices tab; public `/p/privacy/<org-slug>?lang=en|es|hi` |
| Data-subject requests | `src/lib/privacy/dsr.ts` | `dsr_requests` | Requests tab; portal self-service; agent tool `privacy.open_request` |
| Export (access / portability) | `buildSubjectExport()` | — (generated live from whitelists) | Requests → Export JSON; portal "Download my data" |
| Erasure | `eraseSubject()` | in-place anonymisation or delete + tombstones | Requests → Erase subject |
| Retention | `src/lib/privacy/retention.ts` | `retention_policies` | Retention tab; cron `applyRetention()` |
| Breach log + 72h clock | `src/lib/privacy/incidents.ts` | `security_incidents` | Incidents tab |
| Grievance officer / response period | `src/lib/privacy/settings.ts` | `organizations.settings.privacy` | Grievance contact tab; public notice; portal |

Migration: `aws/phase5/d.sql`. All tables are tenant-keyed by `user_id` (org data id).

## Duty → control map

| Duty | DPDP | GDPR | How KernelHub meets it |
| --- | --- | --- | --- |
| Notice before/with consent | s.5 | Art. 13/14 | Versioned markdown notices per locale; consent evidence stores `notice_version`. Public page per org slug. |
| Free, specific, informed, unambiguous consent | s.6(1) | Art. 4(11), 7 | One purpose per ledger row (`marketing_email`, `marketing_sms`, `marketing_voice`, `transactional`, `analytics`, `portal`). Widget/booking forms accept `consent: {marketing: boolean}`; nothing is pre-ticked or bundled. |
| Withdrawal as easy as giving | s.6(4)–(6) | Art. 7(3) | Portal → Privacy → one switch per purpose, effective immediately (new `withdrawn` row). |
| Proof of consent | s.6(10) | Art. 7(1) | Append-only ledger with IP, UA, source, text/notice version; never updated or deleted. |
| Stop processing on withdrawal | s.6(6) | Art. 7(3), 21 | `canSendMarketing(dataId, contactId, channel)` gates outbound marketing (consent + opt-outs + tombstones, fails closed). Voice dialer skips contacts without `marketing_voice` consent unless the campaign sets `require_consent=false`. |
| Right of access / information | s.11 | Art. 15, 20 | `buildSubjectExport()` assembles every row referencing the subject from column whitelists (contacts, leads, bookings, tickets + customer messages, quotes/invoices/payments, records, mail, conversations, voice targets, opt-outs, consents, requests). Staff ids and `user_id` are stripped (`stripInternalKeys`, unit-tested). |
| Correction / erasure | s.12 | Art. 16, 17 | Correction requests tracked; `eraseSubject()` anonymises PII in place (name → "Erased", email/phone nulled, free text redacted) or deletes rows. Accounting records (quotes/invoices/payments) keep amounts with the contact label "Erased customer". Pinecone chunks `contact:<id>` deleted, portal share tokens revoked, audit entry written. |
| Opt-outs survive erasure | s.6(6) | Art. 21 | sha256 tombstones of email/phone are written to `consent_records` (`subject_kind='tombstone'`) before any PII is removed; `canSendMarketing` checks them. |
| Nomination | s.14 | — | `nomination` request kind recorded and tracked like any other request. |
| Grievance redressal within published period (≤ 90 days) | s.13, Rule 14 | Art. 12(3) | `dsr_due_days` (default 30, hard-capped at 90) sets `due_at`; due-countdown pills; cron reminder 5 days before due; grievance officer shown publicly. |
| Erase when purpose served / retention | s.8(7) | Art. 5(1)(e) | Retention policies per entity kind with statutory floors (audit log ≥ 365 days); invoices/quotes/payments are never purged. Nightly `applyRetention()`. |
| Breach notification | s.8(6), Rule 7 | Art. 33/34 | Incident log with `detected_at`; 72-hour countdown for the authority update; separate "affected people notified" stamp; in-app alert on creation. |
| Accountability / audit | s.8 | Art. 5(2), 30 | Every privacy action writes to `audit_log` (`privacy.*` actions). |
| Agent/automation safety | s.8(1) | Art. 24 | Agent tools `privacy.consent_status` (read) and `privacy.open_request` (write, approval required). Automation executor should call `canSendMarketing()` before any marketing step. |

## Operational hooks

- **Cron, daily:** `remindDueSoon()` from `src/lib/privacy/dsr.ts` (in-app reminders 5 days before due / when overdue, once per request) and `applyRetention(limit)` from `src/lib/privacy/retention.ts`.
- **Automation executor:** before sending a marketing email/SMS/voice step for a contact, `await canSendMarketing(dataId, contactId, "email" | "sms" | "voice")` and skip when `allowed === false` (reason is one of `no_consent | opted_out | tombstoned | unknown_contact`).
- **Lead widget / booking forms:** pass `consent: { marketing: true|false }` beside the form fields. Sites can set `sites.consent_text` for the checkbox copy.

## API

Staff (area `settings`, edit for writes): `GET/POST /api/privacy/requests`, `GET/PATCH /api/privacy/requests/[id]`, `POST /api/privacy/requests/[id]/verify` (`{}` sends OTP, `{code}` verifies), `GET /api/privacy/requests/[id]/export`, `POST /api/privacy/requests/[id]/erase` (`{mode: anonymize|delete}`), `GET/POST /api/privacy/consents`, `GET/PUT /api/privacy/retention`, `GET/POST /api/privacy/notices`, `GET/POST /api/privacy/incidents`, `PATCH /api/privacy/incidents/[id]`, `GET/PATCH /api/privacy/settings`.

Public (portal token): `GET/POST /api/p/portal/[token]/privacy` — consent toggles, open requests (pre-verified by the token), immediate export when `auto_fulfil_access` is on.

## Not covered (needs a decision from you)

- Children under 18 (DPDP s.9) — no age gate; add one before collecting data from minors.
- Processor register / egress allow-list — vendor contracts are tracked outside the product today.
- Significant Data Fiduciary duties (DPO, DPIA, audit) apply only on notification.
- Backups and log archives erase on their own cycle; `eraseSubject()` covers the primary database and the vector index.
