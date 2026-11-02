import { query, queryOne } from "@/lib/dsql";
import { emitEvent } from "@/lib/events/bus";
import { twilioIsLive } from "@/lib/notifications/status";
import { twilioSignature } from "@/lib/twilio-webhook";
import { timingSafeEqual } from "crypto";
import { recordOptOut, type CampaignRow, type TargetRow } from "./campaigns";
import { buildCampaignTwiml, buildGatherResultTwiml, buildHangupTwiml, interpretDigits, mergeScript, webhookUrl, type GatherOutcome } from "./twiml";
import { canDialNow, isRetryDue, type CallWindow } from "./window";

/**
 * The dialer. `dialNext` is the cron hook: it picks running campaigns whose
 * local calling window is open, takes due targets (never on the DNC list —
 * `addTargets` already filtered them and opt-outs flip status), and places
 * calls through Twilio's REST API. Without TWILIO_* the provider is
 * simulated: outcomes are drawn at random and flagged `simulated` so the UI
 * can say so.
 */

export type VoiceMode = "live" | "simulated";

export function voiceMode(): VoiceMode {
  return twilioIsLive() ? "live" : "simulated";
}

function appBase(): string {
  return process.env.NEXT_PUBLIC_APP_URL?.trim().replace(/\/$/, "") || "http://localhost:3001";
}

interface TargetWithCampaign extends TargetRow {
  campaign: CampaignRow;
}

export interface DialResult {
  campaigns: number;
  dialed: number;
  simulated: number;
  completed_campaigns: number;
  failed: number;
}

async function contactFields(target: TargetRow): Promise<{ first_name: string; full_name: string; company: string }> {
  let full = "";
  let company = "";
  if (target.contact_id) {
    const c = await queryOne<{ full_name: string; company: string | null }>(`SELECT full_name, company FROM crm_contacts WHERE id = $1`, [target.contact_id]).catch(() => null);
    full = c?.full_name ?? "";
    company = c?.company ?? "";
  }
  const first = target.first_name || full.split(/\s+/)[0] || "";
  return { first_name: first, full_name: full || first, company };
}

export async function renderScript(campaign: CampaignRow, target: TargetRow): Promise<string> {
  const fields = await contactFields(target);
  return mergeScript(campaign.script, fields) || "Hello, this is an automated call.";
}

async function markAttempt(target: TargetRow, callSid: string | null): Promise<void> {
  await query(
    `UPDATE voice_campaign_targets SET status = 'calling', attempts = attempts + 1, last_attempt_at = NOW(), call_sid = $1 WHERE id = $2`,
    [callSid, target.id]
  );
}

async function insertCall(target: TargetRow, callSid: string | null, status: string): Promise<string> {
  const row = await queryOne<{ id: string }>(
    `INSERT INTO voice_calls (user_id, campaign_id, target_id, call_sid, direction, status, created_at) VALUES ($1,$2,$3,$4,'outbound',$5,NOW()) RETURNING id`,
    [target.user_id, target.campaign_id, target.id, callSid, status]
  );
  return row?.id ?? "";
}

/** Twilio REST: create an outbound call that fetches TwiML from our webhook. */
async function createTwilioCall(target: TargetRow): Promise<string> {
  const sid = process.env.TWILIO_ACCOUNT_SID ?? "";
  const token = process.env.TWILIO_AUTH_TOKEN ?? "";
  const from = process.env.TWILIO_FROM_NUMBER ?? "";
  const base = appBase();
  const form = new URLSearchParams({
    From: from,
    To: target.phone,
    Url: webhookUrl(base, target.id, "twiml"),
    Method: "POST",
    StatusCallback: webhookUrl(base, target.id, "status"),
    StatusCallbackMethod: "POST",
    MachineDetection: "Enable",
    Timeout: "25",
  });
  for (const ev of ["initiated", "ringing", "answered", "completed"]) form.append("StatusCallbackEvent", ev);
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(sid)}/Calls.json`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${sid}:${token}`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: form.toString(),
    signal: AbortSignal.timeout(15_000),
  });
  const data = (await res.json().catch(() => ({}))) as { sid?: string; message?: string };
  if (!res.ok) throw new Error(data.message ?? `Twilio returned ${res.status}`);
  return data.sid ?? "";
}

const SIMULATED_OUTCOMES: Array<{ status: TargetRow["status"]; weight: number; digits?: string; answeredBy?: string }> = [
  { status: "answered", weight: 35, digits: "1", answeredBy: "human" },
  { status: "answered", weight: 15, digits: "", answeredBy: "human" },
  { status: "opted_out", weight: 5, digits: "2", answeredBy: "human" },
  { status: "voicemail", weight: 20, answeredBy: "machine_start" },
  { status: "no_answer", weight: 20 },
  { status: "failed", weight: 5 },
];

function pickSimulatedOutcome() {
  const total = SIMULATED_OUTCOMES.reduce((n, o) => n + o.weight, 0);
  let r = Math.random() * total;
  for (const o of SIMULATED_OUTCOMES) {
    r -= o.weight;
    if (r <= 0) return o;
  }
  return SIMULATED_OUTCOMES[SIMULATED_OUTCOMES.length - 1];
}

/** Apply a final outcome to a target + its call row and emit `call.completed`. */
export async function completeTarget(
  target: Pick<TargetRow, "id" | "user_id" | "campaign_id" | "phone" | "contact_id">,
  input: { status: TargetRow["status"]; callStatus: string; durationS?: number | null; callSid?: string | null; outcome: Record<string, unknown>; simulated?: boolean }
): Promise<void> {
  const outcome = { ...input.outcome, simulated: Boolean(input.simulated), at: new Date().toISOString() };
  await query(`UPDATE voice_campaign_targets SET status = $1, outcome = $2, call_sid = COALESCE($3, call_sid) WHERE id = $4`, [
    input.status,
    JSON.stringify(outcome),
    input.callSid ?? null,
    target.id,
  ]);
  if (input.callSid) {
    await query(`UPDATE voice_calls SET status = $1, duration_s = $2 WHERE target_id = $3 AND call_sid = $4`, [input.callStatus, input.durationS ?? null, target.id, input.callSid]);
  } else {
    await query(`UPDATE voice_calls SET status = $1, duration_s = $2 WHERE id = (SELECT id FROM voice_calls WHERE target_id = $3 ORDER BY created_at DESC LIMIT 1)`, [
      input.callStatus,
      input.durationS ?? null,
      target.id,
    ]);
  }
  if (input.status === "opted_out") {
    await recordOptOut(target.user_id, { phone: target.phone, contact_id: target.contact_id, channel: "voice", reason: "Pressed 2 during campaign call" }).catch(() => undefined);
  }
  void emitEvent(target.user_id, {
    type: "call.completed",
    entity: "voice_campaign_target",
    entityId: target.id,
    data: { campaign_id: target.campaign_id, phone: target.phone, status: input.status, call_status: input.callStatus, simulated: Boolean(input.simulated), ...input.outcome },
  });
  await maybeFinishCampaign(target.user_id, target.campaign_id);
}

/** Flip a running campaign to done once no target can be dialled again. */
export async function maybeFinishCampaign(dataId: string, campaignId: string): Promise<boolean> {
  const campaign = await queryOne<CampaignRow>(`SELECT id, status, max_attempts FROM voice_campaigns WHERE id = $1 AND user_id = $2`, [campaignId, dataId]);
  if (!campaign || campaign.status !== "running") return false;
  const pending = await queryOne<{ n: string | number }>(
    `SELECT COUNT(*) AS n FROM voice_campaign_targets
      WHERE campaign_id = $1 AND (status = 'calling' OR (status IN ('queued','no_answer','voicemail','failed') AND attempts < $2))`,
    [campaignId, Math.max(1, campaign.max_attempts)]
  );
  if (Number(pending?.n ?? 0) > 0) return false;
  await query(`UPDATE voice_campaigns SET status = 'done', updated_at = NOW() WHERE id = $1`, [campaignId]);
  return true;
}

async function dialOne(t: TargetWithCampaign, mode: VoiceMode): Promise<"dialed" | "simulated" | "failed"> {
  if (mode === "live") {
    try {
      const sid = await createTwilioCall(t);
      await markAttempt(t, sid);
      await insertCall(t, sid, "queued");
      return "dialed";
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await markAttempt(t, null);
      await insertCall(t, null, "failed");
      await completeTarget(t, { status: "failed", callStatus: "failed", outcome: { error: message.slice(0, 200) } });
      return "failed";
    }
  }
  // Simulated: the call "happens" instantly with a random outcome.
  const sid = `SIM${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`.toUpperCase();
  await markAttempt(t, sid);
  await insertCall(t, sid, "simulated");
  const o = pickSimulatedOutcome();
  const gather = o.digits !== undefined ? interpretDigits(o.digits) : null;
  await completeTarget(t, {
    status: o.status,
    callStatus: o.status === "no_answer" ? "no-answer" : o.status === "failed" ? "failed" : "completed",
    durationS: o.status === "answered" || o.status === "opted_out" ? 20 + Math.floor(Math.random() * 60) : o.status === "voicemail" ? 15 : 0,
    callSid: sid,
    simulated: true,
    outcome: { digits: o.digits ?? null, gather, answered_by: o.answeredBy ?? null },
  });
  return "simulated";
}

/** Cron hook: place up to `limit` calls across all running campaigns whose window is open. */
export async function dialNext(limit = 20, now = new Date()): Promise<DialResult> {
  const result: DialResult = { campaigns: 0, dialed: 0, simulated: 0, completed_campaigns: 0, failed: 0 };
  const mode = voiceMode();
  const campaigns = await query<CampaignRow>(
    `SELECT id, user_id, name, script, voice, status, schedule_at, window_start, window_end, timezone, max_attempts, created_by, created_at, updated_at
       FROM voice_campaigns WHERE status IN ('running','scheduled') ORDER BY updated_at ASC LIMIT 50`
  ).catch(() => []);

  let budget = Math.max(1, Math.min(200, limit));
  for (const c of campaigns) {
    if (budget <= 0) break;
    if (c.status === "scheduled") {
      // Promote scheduled campaigns whose start time has passed.
      if (c.schedule_at && new Date(c.schedule_at).getTime() <= now.getTime()) {
        await query(`UPDATE voice_campaigns SET status = 'running', updated_at = NOW() WHERE id = $1 AND status = 'scheduled'`, [c.id]);
        c.status = "running";
      } else continue;
    }
    const window: CallWindow & { status: string; schedule_at: string | null } = { window_start: c.window_start, window_end: c.window_end, timezone: c.timezone, status: c.status, schedule_at: c.schedule_at };
    if (!canDialNow(now, window)) continue;
    result.campaigns++;

    const targets = await query<TargetRow>(
      `SELECT id, user_id, campaign_id, contact_id, phone, first_name, status, attempts, last_attempt_at, call_sid, outcome, created_at
         FROM voice_campaign_targets
        WHERE campaign_id = $1 AND status IN ('queued','no_answer','voicemail','failed') AND attempts < $2
        ORDER BY attempts ASC, created_at ASC LIMIT $3`,
      [c.id, Math.max(1, c.max_attempts), budget]
    );
    const due = targets.filter((t) => isRetryDue(t, c.max_attempts, now));
    if (due.length === 0) {
      if (await maybeFinishCampaign(c.user_id, c.id)) result.completed_campaigns++;
      continue;
    }
    for (const t of due) {
      if (budget <= 0) break;
      budget--;
      const r = await dialOne({ ...t, campaign: c }, mode);
      if (r === "dialed") result.dialed++;
      else if (r === "simulated") result.simulated++;
      else result.failed++;
    }
  }
  return result;
}

// ── Webhook handling (Twilio → us) ───────────────────────────────────────────

/**
 * Verify Twilio's signature for the campaign webhook. The URL Twilio signed
 * includes the query string (target + kind), so candidates keep `search`.
 */
export function verifyCampaignSignature(req: Request, params: URLSearchParams): boolean {
  if (process.env.TWILIO_SKIP_SIGNATURE_VERIFICATION === "true") return true;
  const token = process.env.TWILIO_AUTH_TOKEN ?? "";
  const provided = req.headers.get("x-twilio-signature");
  if (!token || !provided) return false;
  const url = new URL(req.url);
  const pathAndQuery = `${url.pathname}${url.search}`;
  const candidates = new Set<string>([req.url]);
  const configured = process.env.NEXT_PUBLIC_APP_URL?.trim().replace(/\/$/, "");
  if (configured) candidates.add(`${configured}${pathAndQuery}`);
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
  const proto = req.headers.get("x-forwarded-proto") ?? "https";
  if (host) candidates.add(`${proto}://${host}${pathAndQuery}`);
  const given = Buffer.from(provided);
  for (const candidate of candidates) {
    const expected = Buffer.from(twilioSignature(candidate, params, token));
    if (expected.length === given.length && timingSafeEqual(expected, given)) return true;
  }
  return false;
}

export async function loadTargetWithCampaign(targetId: string): Promise<TargetWithCampaign | null> {
  const t = await queryOne<TargetRow>(
    `SELECT id, user_id, campaign_id, contact_id, phone, first_name, status, attempts, last_attempt_at, call_sid, outcome, created_at FROM voice_campaign_targets WHERE id = $1`,
    [targetId]
  );
  if (!t) return null;
  const c = await queryOne<CampaignRow>(
    `SELECT id, user_id, name, script, voice, status, schedule_at, window_start, window_end, timezone, max_attempts, created_by, created_at, updated_at FROM voice_campaigns WHERE id = $1 AND user_id = $2`,
    [t.campaign_id, t.user_id]
  );
  return c ? { ...t, campaign: c } : null;
}

/** First TwiML fetch when the callee answers: read the merged script, then gather a digit. */
export async function twimlForTarget(t: TargetWithCampaign, params: URLSearchParams): Promise<string> {
  const answeredBy = params.get("AnsweredBy") ?? "";
  if (answeredBy.startsWith("machine")) {
    // Leave a short voicemail; the status callback closes the target as voicemail.
    const script = await renderScript(t.campaign, t);
    return buildHangupTwiml(script, t.campaign.voice);
  }
  const script = await renderScript(t.campaign, t);
  return buildCampaignTwiml({ script, voice: t.campaign.voice, gatherAction: webhookUrl(appBase(), t.id, "gather") });
}

/** Digit pressed during the Gather. */
export async function handleGather(t: TargetWithCampaign, params: URLSearchParams): Promise<string> {
  const outcome: GatherOutcome = interpretDigits(params.get("Digits"));
  const callSid = params.get("CallSid") ?? t.call_sid;
  await completeTarget(t, {
    status: outcome === "opted_out" ? "opted_out" : "answered",
    callStatus: "completed",
    callSid,
    outcome: { digits: params.get("Digits") ?? null, gather: outcome, answered_by: params.get("AnsweredBy") ?? "human" },
  });
  return buildGatherResultTwiml(outcome, t.campaign.voice);
}

/** Twilio status callback: closes targets that never reached the Gather. */
export async function handleStatus(t: TargetWithCampaign, params: URLSearchParams): Promise<void> {
  const callStatus = params.get("CallStatus") ?? "";
  const callSid = params.get("CallSid") ?? t.call_sid;
  const duration = Number(params.get("CallDuration") ?? "");
  const answeredBy = params.get("AnsweredBy") ?? "";
  if (!["completed", "busy", "no-answer", "failed", "canceled"].includes(callStatus)) {
    if (callSid) await query(`UPDATE voice_calls SET status = $1 WHERE target_id = $2 AND call_sid = $3`, [callStatus === "in-progress" ? "in_progress" : callStatus, t.id, callSid]).catch(() => undefined);
    return;
  }
  // Already finalised by the Gather handler — keep that richer outcome.
  const fresh = await queryOne<{ status: string }>(`SELECT status FROM voice_campaign_targets WHERE id = $1`, [t.id]);
  if (fresh && fresh.status !== "calling") {
    if (callSid) await query(`UPDATE voice_calls SET status = $1, duration_s = $2 WHERE target_id = $3 AND call_sid = $4`, [callStatus, Number.isFinite(duration) ? duration : null, t.id, callSid]).catch(() => undefined);
    return;
  }
  let status: TargetRow["status"];
  if (callStatus === "completed") status = answeredBy.startsWith("machine") ? "voicemail" : "answered";
  else if (callStatus === "busy" || callStatus === "no-answer" || callStatus === "canceled") status = "no_answer";
  else status = "failed";
  await completeTarget(t, {
    status,
    callStatus,
    durationS: Number.isFinite(duration) ? duration : null,
    callSid,
    outcome: { digits: null, gather: "no_input", answered_by: answeredBy || null },
  });
}
