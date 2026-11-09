# Tax compliance (Phase 11, lane D)

Preparation aids for India GST, EU/UK VAT and US sales tax, plus e-invoice exports and filing-ready reports.
**Nothing here is legal or tax advice.** The UI shows a "verify with your accountant" notice, KernelHub never files for you
(filing is marked manually with the government reference) and e-invoice submission is simulated.

## What is implemented

| Area | Where |
| --- | --- |
| Profile (`tax_profiles`), contact fields (`tax_country/state/registration_type`), product `hsn_sac_code`/`tax_category` | `aws/phase11/d.sql`, `src/lib/tax-compliance/store.ts` |
| Regime data tables (with `effective_from` + source) | `src/lib/tax-compliance/regimes.ts` |
| Validators: GSTIN (checksum), PAN, EU VAT formats, UK VAT mod-97, US states, optional VIES | `validators.ts` |
| Place of supply (India) | `place-of-supply.ts` |
| Resolver (pure) + `resolveDocumentTax` (DB) | `resolver.ts`, `document.ts` |
| Hook into totals | `resolveDocumentTotals(dataId, items, opts)` in `src/lib/money/tax-rates.ts` - only when a non-generic profile exists |
| E-invoice builders | `einvoice/peppol-ubl.ts`, `einvoice/india-irp.ts`, service `einvoice/service.ts` |
| Reports | `reports.ts` (pure), `reports-data.ts` (loader), `/api/tax/reports` |
| Filing reminders | `reminders.ts` (`taxFilingReminders`) emits `tax.filing_due` |
| UI | `/tax` (Setup, Reports, Filings, E-invoices, Exemptions) |

### India GST
- Intra-state: the base GST rate (from the org `tax_rates` row on the line) is split into CGST + SGST at half each; inter-state, SEZ and exports use IGST. With `lut_zero_rated` exports/SEZ are zero-rated with an LUT legend.
- CGST and SGST are computed by the existing engine and are equal per line; `splitGstTotal()` is provided for report code that must split a total (odd unit goes to CGST).
- Composition and unregistered suppliers charge no tax and print the statutory legend.
- Place of supply: goods follow ship-to, services follow the recipient (GSTIN state, else address, else supplier state with a warning).
- HSN/SAC is stored on lines (`hsn_sac`) or taken from the product at report/e-invoice time.
- Reports: GSTR-1 style (B2B, B2CL, B2CS, exports, credit/debit notes, HSN summary) and GSTR-3B style (outward liability, zero-rated, nil-rated, ITC from supplier bills + expenses).

### EU / UK VAT
- Domestic: catalogue rates. B2B intra-EU with a VALID VAT ID: 0% + reverse-charge (services, category AE) or intra-Community supply (goods, category K) legend. B2C with OSS registration: destination standard rate. Exports: zero-rated (goods) / outside scope (services).
- Reports: box summary (UK 9 boxes; EU generic layout), EC Sales List by customer VAT ID, OSS summary by country.

### US sales tax
- No rates are hard-coded as legal truth. `TaxRateProvider` interface: (a) manual org `tax_rates` rows whose `jurisdiction` is the state code/name, (b) a simulated ZIP-prefix estimate (opt-in via `allow_estimates`, always flagged "estimate"), (c) a hook for a real provider (TaxJar/Avalara): implement `TaxRateProvider` and pass it in `providers` - **not implemented**.
- Tax is only charged in `nexus_states`. Exemption certificates (`tax_exemptions`) zero the tax until they expire.

### E-invoicing
- Peppol BIS Billing 3.0 / EN 16931 UBL 2.1 XML and India IRP-schema JSON (v1.1 shape) are generated and stored in `e_invoices` (unique per invoice+format). Missing fields are listed per field. Golden fixtures live in `src/lib/tax-compliance/__tests__/fixtures` (`UPDATE_GOLDEN=1` to regenerate after review).
- Submission is **simulated**: a deterministic IRN (SHA-256 of GSTIN+FY+type+number, as the scheme defines), fake ack number and QR payload. No government or Peppol network call is made.

## Data sources / assumptions
- EU standard rates (`EU_STANDARD_RATES`, reviewed 2025-01-01): European Commission publication. Reduced rates are not encoded; add them as org tax rates.
- India state codes: GST portal list. GSTIN checksum: published base-36 algorithm.
- Reporting currency = `reporting_currency` billing setting, else INR/EUR/GBP/USD by regime. Conversion uses the newest stored `fx_rates` row per pair; the rate used is listed in `fx_notes`. Documents without a rate are excluded and warned.
- Expense `amount_minor` is assumed to include `tax_minor`.
- Credit notes are re-resolved with the contact only (no ship-to), so they inherit the contact-based place of supply.

## Needs verification
- GSTR-1 B2CL threshold (default INR 2.5 lakh) and HSN digit requirements by turnover.
- LUT / SEZ treatment, reverse charge on inward supplies (not tracked), ITC eligibility and split by IGST/CGST/SGST (bills carry one tax amount).
- IRP schema field details (unit codes, Stcd/Pos for exports) and e-invoice applicability thresholds.
- EU: distance-sales thresholds for B2C origin-rate sales, goods vs services default (`supply_kind`), member-state return box layouts, exemption reason code lists.
- UK: Northern Ireland protocol, MTD box 2/8/9 rules, treatment of services to EU businesses (outside scope assumed).
- US: sub-state jurisdictions, product taxability categories, marketplace facilitator rules, origin- vs destination-based sourcing (destination assumed).
- Filing due-date offsets in `reminders.ts` are approximations.
- Peppol endpoint scheme (9925 used for VAT ids) and BuyerReference defaulting to the invoice number.

## Adding a regime
1. Add the key to `REGIMES` and `REGIME_INFO` in `regimes.ts` (with `effective_from` and source).
2. Add validators in `validators.ts` and a branch in `validateTaxId`.
3. Add a `resolveXxx` function in `resolver.ts` and a case in `resolveTax` returning re-pointed lines + `ComplianceMeta`.
4. Add a report builder in `reports.ts` and a case in `buildRegimeReport`; add the default currency in `reports-data.ts`.
5. Optionally add an e-invoice builder under `einvoice/` and map it in `formatForRegime`.
6. Add unit tests (validators, resolver, report aggregation) and extend `tax.flow.test.ts`.
