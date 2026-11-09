import { randomUUID } from "crypto";
import { query } from "@/lib/dsql";
import { tableExists } from "@/lib/table-exists";
import { sendChat } from "@/lib/chatops/send";
import { getIntegrationRow } from "@/lib/chatops/subscriptions";
import { enqueueNotification } from "@/lib/notifications/outbox";
import { logger } from "@/lib/log/logger";
import { cooldownElapsed, describeCondition, evaluateRule, parseCondition } from "./evaluate";
import { sampleMetric, orgsWithoutRules } from "./metrics";
import { ensureDefaultRules, ensurePlatformRules, parseChannels, type AlertRuleRow } from "./store";

/**
 * Cron hook (end of each agents tick):
 *   try { counts.alerts = (await processAlerts(50)).evaluated; } catch (err) { ... }
 *
 * Org rules read only that org's data (user_id = data id). Platform rules
 * (user_id NULL) run only when OPERATOR_ORG_ID is set, and notify through that
 * org's chat integrations / the email address stored on the rule.
 */

let platformSeeded = false;

export interface ProcessResult { evaluated: number; fired: number; resolved: number; notified: number }

async function notify(rule: AlertRuleRow, ownerOrg: string | null, title: string, text: string): Promise<number> {
  let sent = 0;
  const dataId = rule.user_id ?? ownerOrg;
  if (!dataId) return 0;
  for (const ch of new Set(parseChannels(rule.channel_ids).map((c) => (c.startsWith("email:") ? c.toLowerCase() : c)))) {
    try {
      if (ch.startsWith("email:")) {
        const to = ch.slice(6).trim();
        if (!to) continue;
        await enqueueNotification(dataId, { channel: "email", recipient: to, subject: title, body: text, data: { category: "alert" } });
        sent++;
      } else {
        const row = await getIntegrationRow(dataId, ch);
        if (!row || !row.enabled) continue;
        const r = await sendChat(ch, { title, text, eventType: "alert.fired" }, { dataId });
        if (r.ok) sent++;
      }
    } catch (err) {
      logger.warn("alert notification failed", { err, rule: rule.key });
    }
  }
  return sent;
}

export async function processAlerts(limit = 50, now: Date = new Date()): Promise<ProcessResult> {
  const out: ProcessResult = { evaluated: 0, fired: 0, resolved: 0, notified: 0 };
  if (!(await tableExists("alert_rules"))) return out;
  const operator = process.env.OPERATOR_ORG_ID?.trim() || null;

  // Lazy seeding: orgs that already show failures get their default rules without having to open the page.
  try {
    for (const id of await orgsWithoutRules(10)) await ensureDefaultRules(id);
    if (operator && !platformSeeded) {
      await ensurePlatformRules();
      platformSeeded = true; // deterministic ids + ON CONFLICT: once per process is enough
    }
  } catch (err) {
    logger.warn("alert seeding failed", { err });
  }

  const rules = await query<AlertRuleRow>(
    `SELECT * FROM alert_rules WHERE enabled = TRUE AND (user_id IS NOT NULL OR $2::boolean) ORDER BY last_eval_at ASC NULLS FIRST LIMIT $1`,
    [limit, Boolean(operator)]
  );
  for (const rule of rules) {
    const cond = parseCondition(rule.condition);
    await query(`UPDATE alert_rules SET last_eval_at = $2 WHERE id = $1`, [rule.id, now]).catch(() => undefined);
    if (!cond) continue;
    out.evaluated++;
    const value = await sampleMetric(cond.metric, rule.user_id, cond.window_min);
    const ev = evaluateRule({ condition: cond }, { [cond.metric]: value });
    const open = await query<{ id: string }>(`SELECT id FROM alert_events WHERE rule_id = $1 AND resolved_at IS NULL ORDER BY fired_at DESC`, [rule.id]);
    if (ev.breached) {
      const message = `${rule.name}: ${describeCondition(cond)} (current ${ev.value})`;
      if (open.length === 0) {
        await query(`INSERT INTO alert_events (id, user_id, rule_id, fired_at, value, message) VALUES ($1,$2,$3,$4,$5,$6)`, [randomUUID(), rule.user_id, rule.id, now, ev.value, message]);
        out.fired++;
      }
      if (cooldownElapsed(rule, now)) {
        out.notified += await notify(rule, operator, `KernelHub alert: ${rule.name}`, message);
        await query(`UPDATE alert_rules SET last_fired_at = $2 WHERE id = $1`, [rule.id, now]).catch(() => undefined);
      }
    } else if (open.length > 0 && ev.value !== null) {
      await query(`UPDATE alert_events SET resolved_at = $2 WHERE rule_id = $1 AND resolved_at IS NULL`, [rule.id, now]);
      out.resolved += open.length;
    }
  }
  return out;
}
