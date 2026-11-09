import { z } from "zod";
import { registerTool } from "@/lib/agents/registry";
import type { ToolResult } from "@/lib/agents/types";
import { createDocument, getDocument, listDocuments } from "@/lib/documents/documents";
import { listTemplates } from "@/lib/documents/templates";
import { sendForSignature } from "@/lib/documents/signing";
import { DOCUMENT_KINDS, DOCUMENT_STATUSES, type DocumentDTO } from "@/lib/documents/types";

/** Documents tools: create from a template, send for e-signature (approval), check status. Scoped to ctx.userId (org data id). */

function fail(error: string): ToolResult {
  return { ok: false, summary: error, error };
}
function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
function brief(d: DocumentDTO) {
  return {
    id: d.id,
    title: d.title,
    kind: d.kind,
    status: d.status,
    contact_id: d.contact_id,
    contact_name: d.contact_name,
    signing_order: d.signing_order,
    sent_at: d.sent_at,
    completed_at: d.completed_at,
    expires_at: d.expires_at,
    signers: d.signers.map((s) => ({ name: s.name, email: s.email, role: s.role, status: s.status, signed_at: s.signed_at })),
  };
}

/* ---------- documents.create_from_template ---------- */
const CreateInput = z.object({
  template: z.string().min(1).max(120).describe("Template id or (case-insensitive) name"),
  contact_id: z.string().max(100).optional(),
  title: z.string().max(200).optional(),
  merge_data: z.record(z.string().max(60), z.string().max(20_000)).optional(),
  signers: z.array(z.object({ name: z.string().min(1).max(200), email: z.string().email().max(320), role: z.string().max(60).optional() })).max(10).optional(),
  signing_order: z.enum(["parallel", "sequential"]).optional(),
  record_id: z.string().max(100).optional(),
  quote_id: z.string().max(100).optional(),
});
type CreateInputT = z.infer<typeof CreateInput>;

registerTool<CreateInputT>({
  name: "documents.create_from_template",
  module: "documents",
  description:
    "Create a draft document (contract, proposal, NDA, letter, form) from one of the org's templates. Contact and org merge fields are filled automatically; pass custom fields in merge_data. The draft is NOT sent — use documents.send.",
  input: CreateInput,
  parameters: {
    type: "object",
    properties: {
      template: { type: "string", description: "Template id or name" },
      contact_id: { type: "string", description: "CRM contact the document is for (fills contact.* fields)" },
      title: { type: "string", description: "Optional title (defaults to the template name)" },
      merge_data: { type: "object", description: "Custom merge values keyed by field key, e.g. { fee: \"$2,500 / month\" }" },
      signers: { type: "array", description: "Signers [{name, email, role?}] (defaults to the contact when omitted)", items: { type: "object" } },
      signing_order: { type: "string", enum: ["parallel", "sequential"] },
      record_id: { type: "string" },
      quote_id: { type: "string" },
    },
    required: ["template"],
  },
  scope: "write",
  preview: (i) => `Create document from template "${i.template}"${i.contact_id ? ` for contact ${i.contact_id}` : ""}`,
  async run(ctx, input) {
    try {
      const templates = await listTemplates(ctx.userId);
      const needle = input.template.trim().toLowerCase();
      const template = templates.find((t) => t.id === input.template) ?? templates.find((t) => t.name.toLowerCase() === needle) ?? templates.find((t) => t.name.toLowerCase().includes(needle));
      if (!template) return fail(`No template matches "${input.template}". Available: ${templates.map((t) => t.name).join(", ") || "none (install starters under Documents → Templates)"}`);
      const doc = await createDocument(
        ctx.userId,
        {
          template_id: template.id,
          contact_id: input.contact_id ?? null,
          title: input.title ?? null,
          merge_data: input.merge_data ?? null,
          signers: input.signers ?? null,
          signing_order: input.signing_order ?? null,
          record_id: input.record_id ?? null,
          quote_id: input.quote_id ?? null,
        },
        null
      );
      const blanks = Object.keys(doc.merge_data).length ? template.fields.filter((f) => !(doc.merge_data[f.key] ?? "").trim()).map((f) => f.key) : [];
      return {
        ok: true,
        summary: `Created draft "${doc.title}" (${doc.id})${blanks.length ? `; blank fields: ${blanks.join(", ")}` : ""}`,
        data: { document: brief(doc), blank_fields: blanks, href: "/documents" },
      };
    } catch (err) {
      return fail(errMsg(err));
    }
  },
});

/* ---------- documents.send ---------- */
const SendInput = z.object({
  document_id: z.string().min(1).max(100),
  signers: z.array(z.object({ name: z.string().min(1).max(200), email: z.string().email().max(320), role: z.string().max(60).optional() })).max(10).optional(),
  message: z.string().max(2000).optional(),
  expires_in_days: z.number().int().min(1).max(365).optional(),
});
type SendInputT = z.infer<typeof SendInput>;

registerTool<SendInputT>({
  name: "documents.send",
  module: "documents",
  description: "Send a draft document for e-signature: emails each signer a private signing link (OTP-verified). Requires approval because it contacts people outside the org.",
  input: SendInput,
  parameters: {
    type: "object",
    properties: {
      document_id: { type: "string" },
      signers: { type: "array", description: "Replace the signer list before sending [{name, email, role?}]", items: { type: "object" } },
      message: { type: "string", description: "Personal note included in the email" },
      expires_in_days: { type: "number", description: "Signing deadline (default 30 days)" },
    },
    required: ["document_id"],
  },
  scope: "write",
  requiresApproval: true,
  preview: (i) => `Send document ${i.document_id} for signature${i.signers?.length ? ` to ${i.signers.map((s) => s.email).join(", ")}` : ""}`,
  async run(ctx, input) {
    try {
      let doc = await getDocument(ctx.userId, input.document_id);
      if (!doc) return fail("Document not found");
      if (input.signers?.length) {
        const { replaceSigners } = await import("@/lib/documents/documents");
        if (doc.status !== "draft") return fail("Signers can only be changed on drafts");
        await replaceSigners(ctx.userId, doc.id, input.signers);
        doc = (await getDocument(ctx.userId, doc.id)) ?? doc;
      }
      if (doc.signers.length === 0 && doc.contact_id) {
        const { queryOne } = await import("@/lib/dsql");
        const c = await queryOne<{ full_name: string; email: string | null }>(`SELECT full_name, email FROM crm_contacts WHERE user_id = $1 AND id = $2`, [ctx.userId, doc.contact_id]);
        if (c?.email) {
          const { replaceSigners } = await import("@/lib/documents/documents");
          await replaceSigners(ctx.userId, doc.id, [{ name: c.full_name, email: c.email, role: "client" }]);
        }
      }
      const out = await sendForSignature(ctx.userId, doc.id, { message: input.message ?? null, expires_in_days: input.expires_in_days ?? null }, null);
      return {
        ok: true,
        summary: `Sent "${out.document.title}" to ${out.notified.map((n) => n.email).join(", ") || "no one (waiting on order)"}`,
        data: { document: brief(out.document), notified: out.notified.map((n) => ({ email: n.email })) },
      };
    } catch (err) {
      return fail(errMsg(err));
    }
  },
});

/* ---------- documents.status ---------- */
const StatusInput = z.object({
  document_id: z.string().max(100).optional(),
  contact_id: z.string().max(100).optional(),
  status: z.enum(DOCUMENT_STATUSES).optional(),
  kind: z.enum(DOCUMENT_KINDS).optional(),
  limit: z.number().int().min(1).max(50).optional(),
});
type StatusInputT = z.infer<typeof StatusInput>;

registerTool<StatusInputT>({
  name: "documents.status",
  module: "documents",
  description: "Check signing status: one document by id, or list recent documents (optionally by contact, status or kind) with who has and has not signed.",
  input: StatusInput,
  parameters: {
    type: "object",
    properties: {
      document_id: { type: "string" },
      contact_id: { type: "string" },
      status: { type: "string", enum: [...DOCUMENT_STATUSES] },
      kind: { type: "string", enum: [...DOCUMENT_KINDS] },
      limit: { type: "number" },
    },
  },
  scope: "read",
  preview: (i) => (i.document_id ? `Status of document ${i.document_id}` : "List documents"),
  async run(ctx, input) {
    try {
      if (input.document_id) {
        const doc = await getDocument(ctx.userId, input.document_id);
        if (!doc) return fail("Document not found");
        const pending = doc.signers.filter((s) => s.status !== "signed").map((s) => s.name);
        return { ok: true, summary: `"${doc.title}" is ${doc.status}${pending.length && doc.status !== "signed" ? `; waiting on ${pending.join(", ")}` : ""}`, data: { document: brief(doc) } };
      }
      const docs = (await listDocuments(ctx.userId, { contactId: input.contact_id ?? null, status: input.status ?? null, limit: input.limit ?? 20 })).filter((d) => !input.kind || d.kind === input.kind);
      return { ok: true, summary: `${docs.length} document${docs.length === 1 ? "" : "s"}`, data: { documents: docs.map(brief) } };
    } catch (err) {
      return fail(errMsg(err));
    }
  },
});
