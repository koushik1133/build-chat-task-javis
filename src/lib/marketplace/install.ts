import { randomUUID } from "crypto";
import { query, queryOne } from "@/lib/dsql";
import { getPlaybook } from "@/lib/agents/playbooks";
import { createType, getType } from "@/lib/records/store";
import { tableExists } from "@/lib/table-exists";
import { assertDefinition, getListing } from "./catalog";
import { isBuiltinId, type InstallResult, type ListingDTO, type ListingKind } from "./types";

/**
 * Create the listing's entity in the installing org. Idempotent per
 * (org, listing, version): re-installing returns the existing entity unless it
 * was deleted since, in which case it is recreated.
 */

async function entityExists(dataId: string, kind: ListingKind, entityId: string): Promise<boolean> {
  switch (kind) {
    case "agent": {
      const r = await queryOne<{ id: string }>(`SELECT id::text AS id FROM agents WHERE id::text = $1 AND user_id = $2 AND deleted_at IS NULL`, [entityId, dataId]).catch(() =>
        queryOne<{ id: string }>(`SELECT id::text AS id FROM agents WHERE id::text = $1 AND user_id = $2`, [entityId, dataId]).catch(() => null)
      );
      return Boolean(r);
    }
    case "playbook": {
      const r = await queryOne<{ enabled: boolean | null }>(`SELECT enabled FROM playbook_settings WHERE user_id = $1 AND playbook_id = $2`, [dataId, entityId]).catch(() => null);
      return Boolean(r && r.enabled !== false);
    }
    case "automation": {
      const r = await queryOne<{ id: string }>(`SELECT id::text AS id FROM automations WHERE id::text = $1 AND user_id = $2`, [entityId, dataId]).catch(() => null);
      return Boolean(r);
    }
    case "pack": {
      const t = await getType(dataId, entityId).catch(() => null);
      return Boolean(t);
    }
  }
}

async function installAgent(dataId: string, listing: ListingDTO): Promise<{ entityId: string; note: string | null }> {
  const def = assertDefinition(listing);
  if (def.kind !== "agent") throw new Error("Definition mismatch");
  const d = def.definition;
  const row = await queryOne<{ id: string }>(
    `INSERT INTO agents (user_id, name, role, system_prompt, template_id, status, tasks_completed, tools, model, autonomy_level, max_steps)
     VALUES ($1, $2, $3, $4, $5, 'idle', 0, $6, $7, $8, $9) RETURNING id::text AS id`,
    [dataId, d.name, d.role, d.system_prompt, d.template_id ?? null, d.tools ? JSON.stringify(d.tools) : null, d.model, d.autonomy_level, d.max_steps]
  ).catch(async () =>
    queryOne<{ id: string }>(
      `INSERT INTO agents (user_id, name, role, system_prompt, template_id, status, tasks_completed) VALUES ($1, $2, $3, $4, $5, 'idle', 0) RETURNING id::text AS id`,
      [dataId, d.name, d.role, d.system_prompt, d.template_id ?? null]
    )
  );
  if (!row) throw new Error("Could not create the agent");
  return { entityId: row.id, note: `Agent "${d.name}" created (idle). Open AI Agents to activate it.` };
}

async function installPlaybook(dataId: string, listing: ListingDTO): Promise<{ entityId: string; note: string | null }> {
  const def = assertDefinition(listing);
  if (def.kind !== "playbook") throw new Error("Definition mismatch");
  const pb = getPlaybook(def.definition.playbook_id);
  if (!pb) throw new Error(`Playbook "${def.definition.playbook_id}" is not available in this version`);
  await query(
    `INSERT INTO playbook_settings (user_id, playbook_id, enabled, updated_at) VALUES ($1, $2, TRUE, NOW())
     ON CONFLICT (user_id, playbook_id) DO UPDATE SET enabled = TRUE, updated_at = NOW()`,
    [dataId, pb.id]
  );
  return { entityId: pb.id, note: `Playbook "${pb.name}" enabled. It runs automatically when the situation is detected.` };
}

async function installAutomation(dataId: string, listing: ListingDTO): Promise<{ entityId: string; note: string | null }> {
  const def = assertDefinition(listing);
  if (def.kind !== "automation") throw new Error("Definition mismatch");
  const d = def.definition;
  const row = await queryOne<{ id: string }>(
    `INSERT INTO automations (user_id, name, trigger_event, action_type, kanban_label, action_config, schedule_time, schedule_timezone, schedule_days, status, run_count)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'paused', 0) RETURNING id::text AS id`,
    [dataId, d.name, d.trigger_event, d.action_type, d.kanban_label, JSON.stringify(d.action_config ?? {}), d.schedule_time, d.schedule_timezone, d.schedule_days]
  );
  if (!row) throw new Error("Could not create the automation");
  return { entityId: row.id, note: `Automation "${d.name}" installed paused. Review its settings (recipients, webhooks, agent) and resume it from Automations.` };
}

async function installPack(dataId: string, listing: ListingDTO): Promise<{ entityId: string; note: string | null }> {
  const def = assertDefinition(listing);
  if (def.kind !== "pack") throw new Error("Definition mismatch");
  const d = def.definition;
  const created: string[] = [];
  const reused: string[] = [];
  for (const tpl of d.recordTypes) {
    const existing = await getType(dataId, tpl.slug);
    if (existing) {
      reused.push(existing.name);
      continue;
    }
    try {
      const t = await createType(
        dataId,
        { slug: tpl.slug, name: tpl.name, icon: tpl.icon ?? null, description: tpl.description ?? null, fields: tpl.fields, stages: tpl.stages, views: tpl.views, copilot_prompt: tpl.copilot_prompt ?? null },
        { pack_slug: d.slug }
      );
      created.push(t.name);
    } catch (err) {
      const again = await getType(dataId, tpl.slug);
      if (!again) throw err;
      reused.push(again.name);
    }
  }
  const first = d.recordTypes[0]?.slug ?? d.slug;
  const parts = [];
  if (created.length) parts.push(`created ${created.join(", ")}`);
  if (reused.length) parts.push(`kept existing ${reused.join(", ")}`);
  return { entityId: first, note: `Pack "${d.name}": ${parts.join("; ") || "nothing to do"}.` };
}

export async function installListing(dataId: string, listingId: string): Promise<InstallResult> {
  const listing = await getListing(dataId, listingId);
  if (!listing) throw new Error("Listing not found");
  const tablesReady = await tableExists("marketplace_installs");

  if (tablesReady) {
    const prior = await queryOne<{ installed_entity_kind: ListingKind; installed_entity_id: string }>(
      `SELECT installed_entity_kind, installed_entity_id FROM marketplace_installs WHERE user_id = $1 AND listing_id = $2 AND version = $3 ORDER BY created_at DESC LIMIT 1`,
      [dataId, listing.id, listing.version]
    );
    if (prior && (await entityExists(dataId, prior.installed_entity_kind, prior.installed_entity_id))) {
      return { listing: { ...listing, installed: true }, entityKind: prior.installed_entity_kind, entityId: prior.installed_entity_id, created: false, note: "Already installed." };
    }
  }

  let out: { entityId: string; note: string | null };
  switch (listing.kind) {
    case "agent":
      out = await installAgent(dataId, listing);
      break;
    case "playbook":
      out = await installPlaybook(dataId, listing);
      break;
    case "automation":
      out = await installAutomation(dataId, listing);
      break;
    case "pack":
      out = await installPack(dataId, listing);
      break;
  }

  if (tablesReady) {
    await query(
      `INSERT INTO marketplace_installs (id, user_id, listing_id, version, installed_entity_kind, installed_entity_id) VALUES ($1, $2, $3, $4, $5, $6)`,
      [randomUUID(), dataId, listing.id, listing.version, listing.kind, out.entityId]
    ).catch((err) => console.error("[marketplace] failed to record install", err));
    if (!isBuiltinId(listing.id)) {
      await query(`UPDATE marketplace_listings SET install_count = install_count + 1 WHERE id = $1`, [listing.id]).catch(() => undefined);
    }
  }
  return { listing: { ...listing, installed: true, install_count: listing.install_count + 1 }, entityKind: listing.kind, entityId: out.entityId, created: true, note: out.note };
}
