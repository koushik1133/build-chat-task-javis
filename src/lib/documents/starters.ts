import type { DocumentKind, MergeField } from "./types";

/**
 * Built-in starter templates, installable per org (like record packs). Bodies
 * are plain markdown with `{{merge.fields}}`; orgs edit their copy freely.
 */
export interface StarterTemplate {
  slug: string;
  name: string;
  kind: DocumentKind;
  description: string;
  requires_signature: boolean;
  signer_roles: string[];
  fields: MergeField[];
  body_md: string;
}

const CONTACT_FIELDS: MergeField[] = [
  { key: "contact.full_name", label: "Client name", source: "contact", required: true },
  { key: "contact.email", label: "Client email", source: "contact" },
  { key: "contact.company", label: "Client company", source: "contact" },
  { key: "org.name", label: "Your business", source: "org", required: true },
  { key: "org.support_email", label: "Your support email", source: "org" },
  { key: "org.today", label: "Date", source: "org" },
];

export const STARTER_TEMPLATES: readonly StarterTemplate[] = [
  {
    slug: "service-agreement",
    name: "Service agreement",
    kind: "contract",
    description: "Scope, fees, payment terms and termination for ongoing or project services.",
    requires_signature: true,
    signer_roles: ["client", "provider"],
    fields: [
      ...CONTACT_FIELDS,
      { key: "service_description", label: "Services to be provided", source: "custom", required: true },
      { key: "fee", label: "Fee (e.g. $2,500 per month)", source: "custom", required: true },
      { key: "start_date", label: "Start date", source: "custom", required: true },
      { key: "notice_days", label: "Termination notice (days)", source: "custom" },
    ],
    body_md: `# Service Agreement

This Service Agreement (the "Agreement") is made on {{org.today}} between **{{org.name}}** (the "Provider") and **{{contact.full_name}}**{{contact.company}} (the "Client").

## 1. Services
The Provider will provide the following services to the Client:

{{service_description}}

## 2. Fees and payment
The Client agrees to pay {{fee}}. Invoices are due within 14 days of the invoice date. Late payments may incur interest at 1.5% per month.

## 3. Term
Services begin on {{start_date}} and continue until terminated by either party with {{notice_days}} days' written notice.

## 4. Confidentiality
Each party will keep the other party's non-public information confidential and use it only to perform this Agreement.

## 5. Intellectual property
Deliverables become the Client's property on full payment. The Provider retains ownership of pre-existing materials and tools.

## 6. Liability
Neither party is liable for indirect or consequential loss. The Provider's total liability is limited to the fees paid in the preceding three months.

## 7. Signatures
By signing electronically, each party agrees to be bound by this Agreement.`,
  },
  {
    slug: "nda",
    name: "Mutual NDA",
    kind: "nda",
    description: "Two-way confidentiality agreement for early conversations.",
    requires_signature: true,
    signer_roles: ["party_a", "party_b"],
    fields: [...CONTACT_FIELDS, { key: "purpose", label: "Purpose of disclosure", source: "custom", required: true }, { key: "term_years", label: "Term (years)", source: "custom" }],
    body_md: `# Mutual Non-Disclosure Agreement

Effective {{org.today}}, **{{org.name}}** and **{{contact.full_name}}** (each a "Party") agree as follows.

## 1. Purpose
The Parties wish to exchange confidential information for the purpose of {{purpose}}.

## 2. Confidential information
"Confidential Information" means any non-public information disclosed by one Party to the other, in any form, that is marked confidential or would reasonably be understood to be confidential.

## 3. Obligations
Each receiving Party will:
- use Confidential Information only for the Purpose;
- protect it with at least reasonable care;
- disclose it only to personnel who need to know and are bound by equivalent obligations.

## 4. Exclusions
Information that is public, already known, independently developed or lawfully obtained from a third party is not Confidential Information.

## 5. Term
These obligations last {{term_years}} years from the effective date.

## 6. Return
On request, each Party will return or destroy the other's Confidential Information.`,
  },
  {
    slug: "proposal",
    name: "Project proposal",
    kind: "proposal",
    description: "Problem, approach, timeline and investment — accept by signing.",
    requires_signature: true,
    signer_roles: ["client"],
    fields: [
      ...CONTACT_FIELDS,
      { key: "project_name", label: "Project name", source: "custom", required: true },
      { key: "problem", label: "Problem statement", source: "custom", required: true },
      { key: "approach", label: "Approach", source: "custom", required: true },
      { key: "timeline", label: "Timeline", source: "custom" },
      { key: "investment", label: "Investment", source: "custom", required: true },
    ],
    body_md: `# Proposal: {{project_name}}

Prepared for **{{contact.full_name}}** by {{org.name}} on {{org.today}}.

## The challenge
{{problem}}

## Our approach
{{approach}}

## Timeline
{{timeline}}

## Investment
| Item | Amount |
| --- | --- |
| {{project_name}} | {{investment}} |

## Next steps
Sign below to accept this proposal. We will schedule a kick-off call within two business days.`,
  },
  {
    slug: "consent-form",
    name: "Consent form",
    kind: "form",
    description: "Plain-language consent to a service, treatment or data use.",
    requires_signature: true,
    signer_roles: ["participant"],
    fields: [...CONTACT_FIELDS, { key: "activity", label: "What is being consented to", source: "custom", required: true }, { key: "risks", label: "Risks / considerations", source: "custom" }],
    body_md: `# Consent Form

**Participant:** {{contact.full_name}}
**Provider:** {{org.name}}
**Date:** {{org.today}}

## What you are consenting to
{{activity}}

## Things to consider
{{risks}}

## Your rights
- You may withdraw consent at any time by contacting {{org.support_email}}.
- Your information is handled according to our privacy policy.
- You can ask questions before signing.

## Declaration
I confirm that I have read and understood the information above and I give my consent.`,
  },
  {
    slug: "engagement-letter",
    name: "Engagement letter",
    kind: "letter",
    description: "Confirms the scope and terms of a professional engagement.",
    requires_signature: true,
    signer_roles: ["client"],
    fields: [...CONTACT_FIELDS, { key: "engagement_scope", label: "Scope of engagement", source: "custom", required: true }, { key: "fees", label: "Fees and billing", source: "custom", required: true }],
    body_md: `{{org.today}}

Dear {{contact.full_name}},

Thank you for choosing **{{org.name}}**. This letter confirms the terms of our engagement.

## Scope
{{engagement_scope}}

## Fees
{{fees}}

## Responsibilities
You agree to provide the information we need in a timely manner. We will perform the work with reasonable skill and care and keep you informed of progress.

## Acceptance
Please sign below to confirm your agreement to these terms. We look forward to working with you.

Kind regards,

{{org.name}}`,
  },
];

export function findStarter(slug: string): StarterTemplate | null {
  return STARTER_TEMPLATES.find((s) => s.slug === slug) ?? null;
}
