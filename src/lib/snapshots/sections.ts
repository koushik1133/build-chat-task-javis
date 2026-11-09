import { createHash } from "crypto";
import { query, queryOne } from "@/lib/dsql";
import { getOrgSettings, parseOrgSettings, updateOrgSettings } from "@/lib/org-settings";
import { getBillingSettings, updateBillingSettings } from "@/lib/money/settings";
import { getPrivacySettings, updatePrivacySettings } from "@/lib/privacy/settings";
import { getBranding, isSafeAssetUrl, updateBranding, type BrandingPatch } from "@/lib/branding";
import { createType, listTypes, updateType } from "@/lib/records/store";
import { createTaxRate, listTaxRates, updateTaxRate, type TaxRateInput } from "@/lib/money/tax-rates";
import { createPolicy, listPolicies as listSla, updatePolicy, type PolicyInput } from "@/lib/helpdesk/tickets";
import { AUTOMATION_COLS, createAutomation, definitionOf, getAutomation, saveAutomation, type AutomationRow } from "@/lib/automations/store";
import type { AutomationDefinition } from "@/lib/automations/types";
import { scrubAutomationV2 } from "@/lib/marketplace/types";
import { getPlaybook } from "@/lib/agents/playbooks";
import { createArticle, listArticles, updateArticle, type ArticleInput } from "@/lib/kb/articles";
import { createTemplate as createDocTemplate, listTemplates as listDocTemplates, updateTemplate as updateDocTemplate, type TemplateInput as DocTemplateInput } from "@/lib/documents/templates";
import { createTemplate as createMailTemplate, listTemplates as listMailTemplates, updateTemplate as updateMailTemplate } from "@/lib/marketing/templates";
import { createSequence, listSequences, updateSequence, type SequenceInput } from "@/lib/marketing/sequences";
import { createAudience, listAudiences, updateAudience } from "@/lib/marketing/audiences";
import { AudienceDefinitionSchema } from "@/lib/marketing/types";
import { createSavedReport, createDashboard, listDashboards, listSavedReports, updateDashboard, updateSavedReport, type DashboardInput, type SavedReportInput } from "@/lib/reports/store";
import { getStorefront, updateStorefront, type StorefrontPatch } from "@/lib/storefront/settings";
import { upsertPolicy as upsertRetention } from "@/lib/privacy/retention";
import { RETENTION_KINDS, type RetentionKind } from "@/lib/privacy/constants";
import { listNotices, publishNotice } from "@/lib/privacy/notices";
import type { Area } from "@/lib/auth/roles";
import { SECRET_KEY_RE, type SectionKey } from "./types";
import type { SnapshotSections } from "./schema";

/**
 * Per-section export / lookup / create / update. Every write goes through the
 * module's own lib function (validation, events, indexes) except `agents` and
 * `playbook_settings`, which have no lib writer (the marketplace installer
 * uses the same INSERTs).
 *
 * Singleton sections (settings, branding, storefront) use the natural key
 * "singleton".
 */

export const SINGLETON_KEY = "singleton";

export interface ApplyCtx {
  dataId: string;
  actorId: string | null;
}

export interface SectionImpl {
  key: SectionKey;
  /** Items for the snapshot document; undefined/empty = nothing to include. */
  exportItems(dataId: string): Promise<unknown[]>;
  keyOf(item: unknown): string;
  /** natural key -> object id for rows that already exist in the target. */
  existing(dataId: string): Promise<Map<string, string>>;
  create(ctx: ApplyCtx, item: unknown): Promise<string>;
  update(ctx: ApplyCtx, id: string, item: unknown): Promise<void>;
}

/* ─── helpers ───────────────────────────────────────────────────────────── */

export function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

/** Stable JSON (sorted keys) so equal content hashes equally. */
export function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(",")}}`;
  }
  return JSON.stringify(v) ?? "null";
}

/** Recursively drop any key that looks like a credential. */
export function stripSecretKeys<T>(v: T): T {
  if (Array.isArray(v)) return v.map(stripSecretKeys) as unknown as T;
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) if (!SECRET_KEY_RE.test(k)) out[k] = stripSecretKeys(val);
    return out as T;
  }
  return v;
}

function parseJson<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function pickDefined<T extends Record<string, unknown>>(o: T): Partial<T> {
  const out: Partial<T> = {};
  for (const [k, v] of Object.entries(o)) if (v !== undefined) (out as Record<string, unknown>)[k] = v;
  return out;
}

type Obj = Record<string, unknown>;
const asObj = (v: unknown): Obj => (v && typeof v === "object" ? (v as Obj) : {});
const str = (v: unknown): string => (typeof v === "string" ? v : "");
const byName = <T extends { id: string; name: string }>(rows: T[]): Map<string, string> => new Map(rows.map((r) => [r.name, r.id]));

/* ─── singletons ────────────────────────────────────────────────────────── */

const settings: SectionImpl = {
  key: "settings",
  async exportItems(dataId) {
    const [org, billing, privacy] = await Promise.all([getOrgSettings(dataId), getBillingSettings(dataId), getPrivacySettings(dataId)]);
    // tax_number is a business identifier of THIS workspace, never carried over.
    return [
      {
        locale: org.locale,
        currency: org.currency,
        timezone: org.timezone,
        billing: {
          tax_id_label: billing.tax_id_label ?? undefined,
          prices_include_tax: billing.prices_include_tax,
          tax_rounding: billing.tax_rounding,
          default_terms_days: billing.default_terms_days,
          dunning_schedule: billing.dunning_schedule,
          quote_prefix: billing.quote_prefix,
          invoice_prefix: billing.invoice_prefix,
          credit_note_prefix: billing.credit_note_prefix,
          reporting_currency: billing.reporting_currency,
        },
        // Grievance officer name/email are personal data of this workspace and stay behind.
        privacy: { dsr_due_days: privacy.dsr_due_days, auto_fulfil_access: privacy.auto_fulfil_access },
      },
    ];
  },
  keyOf: () => SINGLETON_KEY,
  async existing(dataId) {
    const row = await queryOne<{ settings: string | null }>(`SELECT settings FROM organizations WHERE owner_user_id = $1`, [dataId]).catch(() => null);
    const raw = parseOrgSettings(row?.settings);
    return "locale" in raw || "currency" in raw || "timezone" in raw ? new Map([[SINGLETON_KEY, dataId]]) : new Map();
  },
  async create(ctx, item) {
    await settings.update(ctx, ctx.dataId, item);
    return ctx.dataId;
  },
  async update(ctx, _id, item) {
    const i = asObj(item);
    const org = pickDefined({ locale: i.locale, currency: i.currency, timezone: i.timezone });
    if (Object.keys(org).length) await updateOrgSettings(ctx.dataId, org as Parameters<typeof updateOrgSettings>[1]);
    if (i.billing) await updateBillingSettings(ctx.dataId, pickDefined(asObj(i.billing)) as Parameters<typeof updateBillingSettings>[1]);
    if (i.privacy) await updatePrivacySettings(ctx.dataId, pickDefined(asObj(i.privacy)) as Parameters<typeof updatePrivacySettings>[1]);
  },
};

const branding: SectionImpl = {
  key: "branding",
  async exportItems(dataId) {
    const b = await getBranding(dataId);
    if (!b.configured) return [];
    return [
      {
        brand_name: b.brand_name,
        primary_color: b.primary_color,
        accent_color: b.accent_color,
        email_footer: b.email_footer,
        // Only https logos travel; custom domain, support email and favicon stay behind.
        logo_url: b.logo_url && isSafeAssetUrl(b.logo_url) && b.logo_url.startsWith("https://") ? b.logo_url : null,
      },
    ];
  },
  keyOf: () => SINGLETON_KEY,
  async existing(dataId) {
    return (await getBranding(dataId)).configured ? new Map([[SINGLETON_KEY, dataId]]) : new Map();
  },
  async create(ctx, item) {
    await branding.update(ctx, ctx.dataId, item);
    return ctx.dataId;
  },
  async update(ctx, _id, item) {
    await updateBranding(ctx.dataId, pickDefined(asObj(item)) as BrandingPatch);
  },
};

const storefront: SectionImpl = {
  key: "storefront",
  async exportItems(dataId) {
    const s = await getStorefront(dataId);
    if (!s.configured) return [];
    return [
      {
        title: s.title,
        intro_md: s.intro_md,
        currency: s.currency,
        collect_shipping: s.collect_shipping,
        shipping_flat_minor: s.shipping_flat_minor,
        pickup_enabled: s.pickup_enabled,
        terms_md: s.terms_md,
        settings: s.settings,
      },
    ];
  },
  keyOf: () => SINGLETON_KEY,
  async existing(dataId) {
    return (await getStorefront(dataId)).configured ? new Map([[SINGLETON_KEY, dataId]]) : new Map();
  },
  async create(ctx, item) {
    await storefront.update(ctx, ctx.dataId, item);
    return ctx.dataId;
  },
  async update(ctx, _id, item) {
    // Slug and enabled flag are never carried: a copied slug would collide, and a storefront must be opened deliberately.
    await updateStorefront(ctx.dataId, pickDefined(asObj(item)) as StorefrontPatch);
  },
};

/* ─── collections ───────────────────────────────────────────────────────── */

const recordTypes: SectionImpl = {
  key: "record_types",
  async exportItems(dataId) {
    return (await listTypes(dataId)).map((t) => ({
      slug: t.slug, name: t.name, icon: t.icon, description: t.description, fields: t.fields, stages: t.stages, views: t.views, copilot_prompt: t.copilot_prompt, pack_slug: t.pack_slug,
    }));
  },
  keyOf: (i) => str(asObj(i).slug),
  async existing(dataId) {
    return new Map((await listTypes(dataId)).map((t) => [t.slug, t.id]));
  },
  async create(ctx, item) {
    const i = asObj(item);
    const t = await createType(
      ctx.dataId,
      { slug: i.slug, name: i.name, icon: i.icon ?? null, description: i.description ?? null, fields: i.fields, stages: i.stages, views: i.views, copilot_prompt: i.copilot_prompt ?? null } as unknown as Parameters<typeof createType>[1],
      { pack_slug: typeof i.pack_slug === "string" ? i.pack_slug : undefined }
    );
    return t.id;
  },
  async update(ctx, id, item) {
    const i = asObj(item);
    await updateType(ctx.dataId, id, { name: i.name, icon: i.icon ?? null, description: i.description ?? null, fields: i.fields, stages: i.stages, views: i.views, copilot_prompt: i.copilot_prompt ?? null });
  },
};

const taxRates: SectionImpl = {
  key: "tax_rates",
  async exportItems(dataId) {
    return (await listTaxRates(dataId, { includeInactive: true })).map((r) => ({
      name: r.name, rate_bp: r.rate_bp, kind: r.kind, jurisdiction: r.jurisdiction, compound: r.compound, is_default: r.is_default, active: r.active,
    }));
  },
  keyOf: (i) => str(asObj(i).name),
  async existing(dataId) {
    return byName(await listTaxRates(dataId, { includeInactive: true }));
  },
  async create(ctx, item) {
    return (await createTaxRate(ctx.dataId, item as TaxRateInput)).id;
  },
  async update(ctx, id, item) {
    await updateTaxRate(ctx.dataId, id, item as Parameters<typeof updateTaxRate>[2]);
  },
};

const slaPolicies: SectionImpl = {
  key: "sla_policies",
  async exportItems(dataId) {
    return (await listSla(dataId)).map((p) => ({
      name: p.name, first_response_minutes: Number(p.first_response_minutes), resolution_minutes: Number(p.resolution_minutes), business_hours_only: p.business_hours_only,
      priority_overrides: parseJson<Obj | null>(p.priority_overrides, null), is_default: p.is_default,
    }));
  },
  keyOf: (i) => str(asObj(i).name),
  async existing(dataId) {
    return byName(await listSla(dataId));
  },
  async create(ctx, item) {
    const i = asObj(item);
    // Never steal the default flag from an existing default policy: only the first policy becomes default automatically.
    return (await createPolicy(ctx.dataId, { ...(i as unknown as PolicyInput), is_default: i.is_default === true ? true : undefined })).id;
  },
  async update(ctx, id, item) {
    await updatePolicy(ctx.dataId, id, item as Partial<PolicyInput>);
  },
};

async function automationRows(dataId: string): Promise<AutomationRow[]> {
  return query<AutomationRow>(`SELECT ${AUTOMATION_COLS} FROM automations WHERE user_id = $1 ORDER BY created_at ASC LIMIT 500`, [dataId]);
}

const automations: SectionImpl = {
  key: "automations",
  async exportItems(dataId) {
    const out: unknown[] = [];
    for (const row of await automationRows(dataId)) {
      const { definition } = scrubAutomationV2(definitionOf(row));
      out.push(stripSecretKeys(definition));
    }
    return out;
  },
  keyOf: (i) => str(asObj(i).name),
  async existing(dataId) {
    return new Map((await automationRows(dataId)).map((r) => [r.name, r.id]));
  },
  async create(ctx, item) {
    const i = asObj(item);
    const def = { name: i.name, description: i.description ?? null, trigger_type: i.trigger_type, trigger_config: i.trigger_config ?? {}, conditions: i.conditions ?? null, steps: i.steps, autonomy: "approve", enabled: false } as unknown as AutomationDefinition;
    // Always created paused + approval-gated: scrubbed placeholders (recipients, webhook URL, agent) need review first.
    return (await createAutomation(ctx.dataId, def, { templateKey: `snapshot:${str(i.name).slice(0, 80)}` })).id;
  },
  async update(ctx, id, item) {
    const cur = await getAutomation(ctx.dataId, id);
    if (!cur) throw new Error("Automation not found");
    const curDef = definitionOf(cur);
    const i = asObj(item);
    const def = { name: i.name, description: i.description ?? null, trigger_type: i.trigger_type, trigger_config: i.trigger_config ?? {}, conditions: i.conditions ?? null, steps: i.steps, autonomy: curDef.autonomy, enabled: false } as unknown as AutomationDefinition;
    await saveAutomation(ctx.dataId, id, def);
  },
};

interface AgentRowLite {
  id: string; name: string; role: string; system_prompt: string | null; tools: string | null; model: string | null; autonomy_level: string | null; max_steps: number | null;
}
async function agentRows(dataId: string): Promise<AgentRowLite[]> {
  const cols = `id::text AS id, name, role, system_prompt, tools, model, autonomy_level, max_steps`;
  return query<AgentRowLite>(`SELECT ${cols} FROM agents WHERE user_id = $1 AND deleted_at IS NULL ORDER BY created_at ASC LIMIT 500`, [dataId]).catch(() =>
    query<AgentRowLite>(`SELECT ${cols} FROM agents WHERE user_id = $1 ORDER BY created_at ASC LIMIT 500`, [dataId])
  );
}

/** An imported agent never lands unattended: "auto" is downgraded to "approve" (a person raises it deliberately). */
export function safeAutonomy(v: unknown): "draft" | "approve" {
  return v === "draft" ? "draft" : "approve";
}

const agents: SectionImpl = {
  key: "agents",
  async exportItems(dataId) {
    return (await agentRows(dataId)).map((a) => {
      const tools = parseJson<unknown>(a.tools, null);
      return {
        name: a.name, role: a.role, system_prompt: a.system_prompt,
        tools: Array.isArray(tools) ? tools.filter((t): t is string => typeof t === "string") : null,
        autonomy_level: a.autonomy_level === "draft" || a.autonomy_level === "auto" ? a.autonomy_level : "approve",
        model: a.model, max_steps: a.max_steps ? Number(a.max_steps) : null,
      };
    });
  },
  keyOf: (i) => str(asObj(i).name),
  async existing(dataId) {
    return new Map((await agentRows(dataId)).map((r) => [r.name, r.id]));
  },
  async create(ctx, item) {
    const d = asObj(item);
    const tools = Array.isArray(d.tools) ? JSON.stringify(d.tools) : null;
    const autonomy = safeAutonomy(d.autonomy_level);
    const row = await queryOne<{ id: string }>(
      `INSERT INTO agents (user_id, name, role, system_prompt, status, tasks_completed, tools, model, autonomy_level, max_steps)
       VALUES ($1, $2, $3, $4, 'idle', 0, $5, $6, $7, $8) RETURNING id::text AS id`,
      [ctx.dataId, d.name, d.role, d.system_prompt ?? null, tools, d.model ?? null, autonomy, d.max_steps ?? null]
    );
    if (!row) throw new Error("Could not create the agent");
    return row.id;
  },
  async update(ctx, id, item) {
    const d = asObj(item);
    await query(
      `UPDATE agents SET role = $3, system_prompt = $4, tools = $5, model = $6, autonomy_level = $7, max_steps = $8 WHERE id::text = $1 AND user_id = $2`,
      [id, ctx.dataId, d.role, d.system_prompt ?? null, Array.isArray(d.tools) ? JSON.stringify(d.tools) : null, d.model ?? null, safeAutonomy(d.autonomy_level), d.max_steps ?? null]
    );
  },
};

const playbookSettings: SectionImpl = {
  key: "playbook_settings",
  async exportItems(dataId) {
    const rows = await query<{ playbook_id: string; enabled: boolean | null }>(`SELECT playbook_id, enabled FROM playbook_settings WHERE user_id = $1 ORDER BY playbook_id`, [dataId]).catch(() => []);
    return rows.map((r) => ({ playbook_id: r.playbook_id, enabled: r.enabled !== false }));
  },
  keyOf: (i) => str(asObj(i).playbook_id),
  async existing(dataId) {
    const rows = await query<{ playbook_id: string }>(`SELECT playbook_id FROM playbook_settings WHERE user_id = $1`, [dataId]).catch(() => []);
    return new Map(rows.map((r) => [r.playbook_id, r.playbook_id]));
  },
  async create(ctx, item) {
    const i = asObj(item);
    const pb = getPlaybook(str(i.playbook_id));
    if (!pb) throw new Error(`Playbook "${str(i.playbook_id)}" is not available in this version`);
    await query(
      `INSERT INTO playbook_settings (user_id, playbook_id, enabled, updated_at) VALUES ($1, $2, $3, NOW())
       ON CONFLICT (user_id, playbook_id) DO UPDATE SET enabled = EXCLUDED.enabled, updated_at = NOW()`,
      [ctx.dataId, pb.id, i.enabled !== false]
    );
    return pb.id;
  },
  async update(ctx, id, item) {
    await query(`UPDATE playbook_settings SET enabled = $3, updated_at = NOW() WHERE user_id = $1 AND playbook_id = $2`, [ctx.dataId, id, asObj(item).enabled !== false]);
  },
};

const kbArticles: SectionImpl = {
  key: "kb_articles",
  async exportItems(dataId) {
    // Published only: drafts are work in progress, not configuration.
    return (await listArticles(dataId, { status: "published", limit: 500 })).map((a) => ({
      slug: a.slug, title: a.title, body_md: a.body_md, excerpt: a.excerpt, category: a.category, tags: parseJson<string[]>(a.tags, []), is_public: a.is_public,
    }));
  },
  keyOf: (i) => str(asObj(i).slug),
  async existing(dataId) {
    return new Map((await listArticles(dataId, { limit: 500 })).map((a) => [a.slug, a.id]));
  },
  async create(ctx, item) {
    return (await createArticle(ctx.dataId, { ...(item as ArticleInput), status: "draft" })).id;
  },
  async update(ctx, id, item) {
    const { slug: _slug, ...rest } = item as ArticleInput;
    void _slug;
    await updateArticle(ctx.dataId, id, rest);
  },
};

const documentTemplates: SectionImpl = {
  key: "document_templates",
  async exportItems(dataId) {
    return (await listDocTemplates(dataId)).map((t) => ({
      name: t.name, kind: t.kind, body_md: t.body_md, fields: t.fields, requires_signature: t.requires_signature, signer_roles: t.signer_roles,
    }));
  },
  keyOf: (i) => str(asObj(i).name),
  async existing(dataId) {
    return byName(await listDocTemplates(dataId));
  },
  async create(ctx, item) {
    return (await createDocTemplate(ctx.dataId, item as DocTemplateInput, ctx.actorId)).id;
  },
  async update(ctx, id, item) {
    await updateDocTemplate(ctx.dataId, id, item as Partial<DocTemplateInput>, ctx.actorId);
  },
};

const emailTemplates: SectionImpl = {
  key: "email_templates",
  async exportItems(dataId) {
    return (await listMailTemplates(dataId)).map((t) => ({ name: t.name, subject: t.subject, preheader: t.preheader, body_md: t.body_md, category: t.category }));
  },
  keyOf: (i) => str(asObj(i).name),
  async existing(dataId) {
    return byName(await listMailTemplates(dataId));
  },
  async create(ctx, item) {
    return (await createMailTemplate(ctx.dataId, item as Parameters<typeof createMailTemplate>[1])).id;
  },
  async update(ctx, id, item) {
    await updateMailTemplate(ctx.dataId, id, item as Parameters<typeof updateMailTemplate>[2]);
  },
};

const audiences: SectionImpl = {
  key: "audiences",
  async exportItems(dataId) {
    return (await listAudiences(dataId)).map((a) => ({ name: a.name, definition: parseJson<Obj>(a.definition, {}), is_dynamic: a.is_dynamic }));
  },
  keyOf: (i) => str(asObj(i).name),
  async existing(dataId) {
    return byName(await listAudiences(dataId));
  },
  async create(ctx, item) {
    const i = asObj(item);
    return (await createAudience(ctx.dataId, { name: str(i.name), definition: AudienceDefinitionSchema.parse(i.definition ?? {}), is_dynamic: i.is_dynamic !== false })).id;
  },
  async update(ctx, id, item) {
    const i = asObj(item);
    await updateAudience(ctx.dataId, id, { name: str(i.name), definition: AudienceDefinitionSchema.parse(i.definition ?? {}), is_dynamic: i.is_dynamic !== false });
  },
};

const sequences: SectionImpl = {
  key: "sequences",
  async exportItems(dataId) {
    const [rows, auds, tpls] = await Promise.all([listSequences(dataId), listAudiences(dataId), listMailTemplates(dataId)]);
    const audName = new Map(auds.map((a) => [a.id, a.name]));
    const tplName = new Map(tpls.map((t) => [t.id, t.name]));
    return rows.map((s) => {
      const tc = parseJson<Obj>(s.trigger_config, {});
      const steps = parseJson<Obj[]>(s.steps, []).map((st) => {
        const { template_id, ...rest } = st;
        const tn = typeof template_id === "string" ? tplName.get(template_id) : undefined;
        return tn ? { ...rest, template_name: tn } : rest;
      });
      const audienceName = typeof tc.audience_id === "string" ? audName.get(tc.audience_id) : undefined;
      return {
        name: s.name, trigger: s.trigger,
        trigger_config: { ...(audienceName ? { audience_name: audienceName } : {}), ...(typeof tc.event_type === "string" ? { event_type: tc.event_type } : {}) },
        steps, status: s.status,
      };
    });
  },
  keyOf: (i) => str(asObj(i).name),
  async existing(dataId) {
    return byName(await listSequences(dataId));
  },
  async create(ctx, item) {
    return (await createSequence(ctx.dataId, await resolveSequence(ctx.dataId, item))).id;
  },
  async update(ctx, id, item) {
    await updateSequence(ctx.dataId, id, await resolveSequence(ctx.dataId, item));
  },
};

async function resolveSequence(dataId: string, item: unknown): Promise<SequenceInput> {
  const i = asObj(item);
  const [auds, tpls] = await Promise.all([listAudiences(dataId), listMailTemplates(dataId)]);
  const audId = new Map(auds.map((a) => [a.name, a.id]));
  const tplId = new Map(tpls.map((t) => [t.name, t.id]));
  const tc = asObj(i.trigger_config);
  const trigger_config: Obj = {};
  if (typeof tc.audience_name === "string") {
    const id = audId.get(tc.audience_name);
    if (!id) throw new Error(`Audience "${tc.audience_name}" does not exist in this workspace (include the audiences section)`);
    trigger_config.audience_id = id;
  }
  if (typeof tc.event_type === "string") trigger_config.event_type = tc.event_type;
  const steps = (Array.isArray(i.steps) ? i.steps : []).map((s) => {
    const { template_name, ...rest } = asObj(s);
    if (typeof template_name === "string") {
      const id = tplId.get(template_name);
      if (!id) throw new Error(`Email template "${template_name}" does not exist in this workspace (include the email_templates section)`);
      return { ...rest, template_id: id };
    }
    return rest;
  });
  return { name: str(i.name), trigger: i.trigger, trigger_config, steps, status: "paused" } as unknown as SequenceInput;
}

const savedReports: SectionImpl = {
  key: "saved_reports",
  async exportItems(dataId) {
    // actorId "" => only org-visible reports (private ones belong to their author).
    return (await listSavedReports(dataId, "", 500)).filter((r) => r.visibility === "org").map((r) => ({ name: r.name, description: r.description, spec: r.spec, chart: r.chart, visibility: r.visibility }));
  },
  keyOf: (i) => str(asObj(i).name),
  async existing(dataId) {
    return byName(await listSavedReports(dataId, "", 500));
  },
  async create(ctx, item) {
    return (await createSavedReport(ctx.dataId, ctx.actorId ?? ctx.dataId, item as SavedReportInput)).id;
  },
  async update(ctx, id, item) {
    await updateSavedReport(ctx.dataId, ctx.actorId ?? ctx.dataId, id, item as Partial<SavedReportInput>);
  },
};

const dashboards: SectionImpl = {
  key: "dashboards",
  async exportItems(dataId) {
    const [boards, reps] = await Promise.all([listDashboards(dataId), listSavedReports(dataId, "", 500)]);
    const repName = new Map(reps.map((r) => [r.id, r.name]));
    return boards.map((d) => ({
      name: d.name, role: d.role, is_default: d.is_default,
      layout: d.layout.map((l) => {
        const { report_id, ...rest } = l as unknown as Obj;
        const rn = typeof report_id === "string" ? repName.get(report_id) : undefined;
        return rn ? { ...rest, report_name: rn } : rest;
      }),
    }));
  },
  keyOf: (i) => str(asObj(i).name),
  async existing(dataId) {
    return byName(await listDashboards(dataId));
  },
  async create(ctx, item) {
    return (await createDashboard(ctx.dataId, ctx.actorId ?? ctx.dataId, await resolveDashboard(ctx.dataId, item))).id;
  },
  async update(ctx, id, item) {
    await updateDashboard(ctx.dataId, id, await resolveDashboard(ctx.dataId, item));
  },
};

async function resolveDashboard(dataId: string, item: unknown): Promise<DashboardInput> {
  const i = asObj(item);
  const reps = await listSavedReports(dataId, "", 500);
  const repId = new Map(reps.map((r) => [r.name, r.id]));
  const layout = (Array.isArray(i.layout) ? i.layout : []).flatMap((l) => {
    const { report_name, ...rest } = asObj(l);
    if (typeof report_name === "string") {
      const id = repId.get(report_name);
      return id ? [{ ...rest, report_id: id }] : []; // unresolved report: drop the tile rather than point at nothing
    }
    return [rest];
  });
  return { name: str(i.name), role: i.role ?? null, layout, is_default: i.is_default === true ? true : undefined } as unknown as DashboardInput;
}

const retentionPolicies: SectionImpl = {
  key: "retention_policies",
  async exportItems(dataId) {
    const rows = await query<{ entity_kind: string; keep_days: number; action: string; enabled: boolean }>(
      `SELECT entity_kind, keep_days, action, enabled FROM retention_policies WHERE user_id = $1 ORDER BY entity_kind`, [dataId]
    ).catch(() => []);
    return rows.map((r) => ({ entity_kind: r.entity_kind, keep_days: Number(r.keep_days), action: r.action, enabled: r.enabled }));
  },
  keyOf: (i) => str(asObj(i).entity_kind),
  async existing(dataId) {
    const rows = await query<{ id: string; entity_kind: string }>(`SELECT id, entity_kind FROM retention_policies WHERE user_id = $1`, [dataId]).catch(() => []);
    return new Map(rows.map((r) => [r.entity_kind, r.id]));
  },
  async create(ctx, item) {
    const i = asObj(item);
    if (!(RETENTION_KINDS as readonly string[]).includes(str(i.entity_kind))) throw new Error(`Unknown retention kind "${str(i.entity_kind)}"`);
    const row = await upsertRetention(ctx.dataId, i.entity_kind as RetentionKind, { keep_days: Number(i.keep_days), action: i.action as "anonymize" | "delete" | "archive", enabled: false });
    return row.id;
  },
  async update(ctx, _id, item) {
    await retentionPolicies.create(ctx, item);
  },
};

const privacyNotices: SectionImpl = {
  key: "privacy_notices",
  async exportItems(dataId) {
    const seen = new Set<string>();
    const out: unknown[] = [];
    for (const n of await listNotices(dataId)) {
      // listNotices is ordered locale ASC, version DESC: first published per locale is the latest.
      if (!n.published_at || seen.has(n.locale)) continue;
      seen.add(n.locale);
      out.push({ locale: n.locale, body_md: n.body_md });
    }
    return out;
  },
  keyOf: (i) => str(asObj(i).locale),
  async existing(dataId) {
    const m = new Map<string, string>();
    for (const n of await listNotices(dataId)) if (n.published_at && !m.has(n.locale)) m.set(n.locale, n.id);
    return m;
  },
  async create(ctx, item) {
    const i = asObj(item);
    return (await publishNotice(ctx.dataId, { locale: str(i.locale), body_md: str(i.body_md) }, ctx.actorId)).id;
  },
  async update(ctx, _id, item) {
    // Notices are immutable: "updating" publishes the next version.
    await privacyNotices.create(ctx, item);
  },
};

/** Permission area a caller needs to edit each section; applying a snapshot must not widen a member's rights. */
export const SECTION_AREA: Record<SectionKey, Area> = {
  settings: "settings", branding: "settings", record_types: "settings", tax_rates: "billing", sla_policies: "helpdesk", automations: "settings",
  agents: "agents", playbook_settings: "agents", kb_articles: "knowledge", document_templates: "settings", email_templates: "crm", sequences: "crm",
  audiences: "crm", saved_reports: "reports", dashboards: "reports", storefront: "settings", retention_policies: "settings", privacy_notices: "settings",
};

export const SECTION_IMPLS: Record<SectionKey, SectionImpl> = {
  settings, branding, record_types: recordTypes, tax_rates: taxRates, sla_policies: slaPolicies, automations, agents, playbook_settings: playbookSettings,
  kb_articles: kbArticles, document_templates: documentTemplates, email_templates: emailTemplates, sequences, audiences, saved_reports: savedReports,
  dashboards, storefront, retention_policies: retentionPolicies, privacy_notices: privacyNotices,
};

/** Dependencies first: audiences/templates before sequences, reports before dashboards. */
export const APPLY_ORDER: SectionKey[] = [
  "settings", "branding", "record_types", "tax_rates", "sla_policies", "audiences", "email_templates", "sequences", "document_templates", "kb_articles",
  "automations", "agents", "playbook_settings", "saved_reports", "dashboards", "storefront", "retention_policies", "privacy_notices",
];

export type SectionsDoc = SnapshotSections;
