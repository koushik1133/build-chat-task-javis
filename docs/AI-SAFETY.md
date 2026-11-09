# AI safety, grounding and cost controls

KernelHub runs AI on text that strangers write: SMS, WhatsApp, email, web chat, tickets, lead forms, contact names. Anyone can put instructions in that text. This document describes the threat model and the layers that contain it.

## Threat model

A multi-channel business agent can read customer data, send messages, move money and delete records. An attacker needs only to send a message. Goals we defend against:

- **Instruction override**: "ignore previous instructions", role spoofing, forged delimiters, encoded or invisible text.
- **Action hijack**: persuading the model to call `comms.send_email`, refund, delete or publish tools.
- **Exfiltration**: getting the model to reveal the system prompt, keys, other customers' data or internal ids.
- **Hallucinated commitments**: inventing prices, hours or policies the business never stated.
- **Cost abuse**: driving unbounded model spend through a public channel.

We assume the model can be manipulated. Controls therefore live outside the model.

## Layers

1. **Untrusted-content boundary** (`src/lib/ai/untrusted.ts`). Everything from outside the org is wrapped as `<<<UNTRUSTED:label:nonce ... nonce>>>` with a per-call random nonce. Content is NFKC-normalised, zero-width and bidi characters are stripped, marker look-alikes and the nonce are neutralised, and length is capped. `UNTRUSTED_PREAMBLE` is appended to system prompts. Applied to: receptionist (all channels, history), agent-loop tool results from tools flagged `untrustedOutput` (tickets, leads, contacts, webchat sessions), copilot context builders (contact notes, lead data, ticket text), and the KB-from-tickets draft.
2. **Taint and action firewall** (`src/lib/agents/registry.ts`). Each tool has a `risk` (`low|medium|high`; defaults come from a name-based classification, overridable per tool). When untrusted content enters a run, `ctx.tainted` becomes true. A tainted run cannot auto-execute a `high` risk write (external sends, payments, deletion, publishing, accounting push, campaigns), whatever the autonomy level. The approval preview reads "Requires approval: run contains customer-supplied content". The receptionist is always tainted and may only call its own allowlisted tools.
3. **Output guard** (`src/lib/ai/output-guard.ts`). Before an AI-authored reply reaches a customer, it is checked for key-like strings, system-prompt leakage markers, internal ids and routes, unresolved `{{merge}}` fields and excess length. A failure downgrades auto-send to a pending approval with the reasons in the preview. `redactForLog` / `promptPreview` redact emails, phones, cards, JWTs and keys for stored text; agent run steps redact output of untrusted-output tools.
4. **Grounding** (`src/lib/receptionist/inbound-agent.ts`). KB retrieval runs before the model. Replies built from KB articles carry a `(Source: Title)` suffix and the approval stores `grounding {sources, confidence}`. A factual question (price, hours, policy, warranty, location) with no retrieval above `GROUNDING_THRESHOLD` and no business-profile overlap gets a handoff reply and never reaches the model.
5. **Budgets** (`src/lib/llm/budgets.ts`). Monthly cap, daily cap, per-feature monthly caps, max tokens per call and a cheaper fallback model for `tier: "fast"` work. A tripped cap returns 402 `llm_budget_exceeded` with `cap` (`monthly|daily|feature`) and `feature`. Configure under Settings, AI, Limits.
6. **Evals** (`src/lib/evals/golden`). Offline golden suites replay scripted (including manipulated) model turns through the real receptionist and registry. Run `npm run eval:golden`.

## Operator guidance

- Keep high-risk tools on `approve` autonomy for agents that read inbound content. Auto autonomy is safe for internal-only workflows; the firewall still protects mixed ones.
- Review held replies in the Approvals inbox: "Held by output guard" means a reply looked unsafe.
- Publish accurate KB articles and fill the business profile. The assistant refuses to guess; thin content means more handoffs.
- Set a daily cap and a receptionist feature cap for any public channel.
- Add a case to `injection.json` whenever you see a new attack in the wild.

## Known limits

Wrapping reduces but does not eliminate manipulation of the reply text itself; the firewall and guard bound the damage. Mail-body wrapping is covered through the receptionist; there is no standalone mail-reading tool today. Redaction is pattern-based.
