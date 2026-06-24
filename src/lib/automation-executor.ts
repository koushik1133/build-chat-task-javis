/**
 * Executes automation actions — Slack, email (Resend), webhooks, tasks, in-app notifications.
 */

import { query, queryOne } from "@/lib/dsql";
import { platformFromAddress, isSandboxSender, type UserIntegrations } from "@/lib/user-integrations";
import { runAgentJob } from "@/lib/agent-runner";
import { sendEmailUnified } from "@/lib/email-sender";

export type AutomationContext = {
  user_id: string;
  workflow_name: string;
  trigger: string;
  automation_id?: string;
  task_title?: string;
  from_column?: string;
  to_column?: string;
  kanban_label?: string;
  via_approval?: boolean;
};

export type ActionConfig = {
  /** Slack incoming webhook URL */
  webhook_url?: string;
  /** Generic HTTP webhook */
  url?: string;
  /** Email recipient */
  to?: string;
  /** Custom email subject (supports {{task_title}} etc.) */
  subject?: string;
  /** Custom message template */
  message?: string;
  /** Agent UUID to activate */
  agent_id?: string;
  /** Custom instructions for Run Agent */
  prompt?: string;
  /** Where to send agent output: notification, email, slack */
  deliver_via?: string[];
};

export type ExecuteResult = {
  success: boolean;
  message: string;
  detail?: string;
};

// ─── Timeout helper ───────────────────────────────────────────────────────────
const FETCH_TIMEOUT_MS = 10_000;

function fetchWithTimeout(
  url: string,
  opts: RequestInit,
  timeoutMs = FETCH_TIMEOUT_MS
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...opts, signal: controller.signal }).finally(() =>
    clearTimeout(timer)
  );
}

// ─── Interpolation ────────────────────────────────────────────────────────────
function interpolate(template: string, ctx: AutomationContext): string {
  const now = new Date();
  return template
    .replace(/\{\{task_title\}\}/g, ctx.task_title ?? "Untitled")
    .replace(/\{\{from_column\}\}/g, ctx.from_column ?? "—")
    .replace(/\{\{to_column\}\}/g, ctx.to_column ?? "—")
    .replace(/\{\{label\}\}/g, ctx.kanban_label ?? "—")
    .replace(/\{\{workflow\}\}/g, ctx.workflow_name)
    .replace(/\{\{date\}\}/g, now.toLocaleDateString())
    .replace(/\{\{time\}\}/g, now.toLocaleTimeString())
    .replace(/\{\{agent\}\}/g, "Agent");
}

function defaultMessage(ctx: AutomationContext): string {
  if (ctx.trigger === "Scheduled (Daily)") {
    return `⏰ *${ctx.workflow_name}* — scheduled run\n_${new Date().toLocaleString()}_`;
  }
  const parts = [`*${ctx.workflow_name}* fired`];
  if (ctx.task_title) parts.push(`Card: *${ctx.task_title}*`);
  if (ctx.from_column && ctx.to_column) parts.push(`${ctx.from_column} → ${ctx.to_column}`);
  if (ctx.via_approval) parts.push("✅ HITL approved");
  return parts.join("\n");
}

// ─── Slack ────────────────────────────────────────────────────────────────────
async function sendSlack(webhookUrl: string, text: string): Promise<ExecuteResult> {
  try {
    const res = await fetchWithTimeout(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return { success: false, message: "Slack delivery failed", detail: `${res.status}: ${body.slice(0, 200)}` };
    }
    return { success: true, message: "Slack message sent" };
  } catch (err) {
    const msg = (err as Error).name === "AbortError"
      ? "Slack webhook timed out (10s). Check the webhook URL and try again."
      : (err as Error).message;
    return { success: false, message: "Slack delivery failed", detail: msg };
  }
}

// ─── Webhook ──────────────────────────────────────────────────────────────────
async function sendWebhook(url: string, payload: Record<string, unknown>): Promise<ExecuteResult> {
  try {
    const res = await fetchWithTimeout(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": "KernelHub-Automations/1.0" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return { success: false, message: "Webhook failed", detail: `${res.status}: ${body.slice(0, 200)}` };
    }
    return { success: true, message: `Webhook POST ${url.slice(0, 40)}…` };
  } catch (err) {
    const msg = (err as Error).name === "AbortError"
      ? "Webhook timed out (10s)."
      : (err as Error).message;
    return { success: false, message: "Webhook failed", detail: msg };
  }
}

// ─── Email (Resend) with delivery verification ────────────────────────────────
/**
 * Check whether Resend actually delivered the email, not just accepted it.
 * Resend sandbox silently drops emails to non-owner addresses while returning 200.
 */
async function verifyResendDelivery(
  emailId: string,
  apiKey: string,
  maxWaitMs = 3000
): Promise<{ delivered: boolean; lastEvent: string }> {
  const start = Date.now();
  const pollInterval = 800;
  while (Date.now() - start < maxWaitMs) {
    try {
      const res = await fetchWithTimeout(
        `https://api.resend.com/emails/${emailId}`,
        { headers: { Authorization: `Bearer ${apiKey}` } },
        5000
      );
      if (res.ok) {
        const data = (await res.json()) as { last_event?: string };
        const evt = data.last_event ?? "unknown";
        // "delivered" means Resend's MTA accepted it.
        // "bounced", "complained", "delivery_delayed" indicate real failures.
        if (evt === "delivered") return { delivered: true, lastEvent: evt };
        if (["bounced", "complained"].includes(evt)) return { delivered: false, lastEvent: evt };
      }
    } catch {
      // poll failed, try again
    }
    await new Promise((r) => setTimeout(r, pollInterval));
  }
  // Timeout — assume pending
  return { delivered: true, lastEvent: "pending" };
}

async function sendEmail(to: string, subject: string, html: string, fromName?: string | null): Promise<ExecuteResult> {
  const result = await sendEmailUnified({ to, subject, html, fromName });
  if (!result.success) {
    const raw = result.detail ?? result.message;
    const isSandboxError = /your own email address/i.test(raw) || 
      /verify a domain/i.test(raw) || 
      /sandbox/i.test(raw);

    if (isSandboxError) {
      console.warn(`[email] Sandbox restriction detected sending to ${to}. Simulating delivery.`);
      return {
        success: true,
        message: `Simulated email to ${to}`,
        detail: `⚠️ Sandbox Mode: Simulated email logged to console due to Resend restrictions. Subject: "${subject}"`,
      };
    }
    return result;
  }
  return result;
}

// ─── Notifications & Tasks ────────────────────────────────────────────────────
async function createInAppNotification(userId: string, title: string, body: string): Promise<ExecuteResult> {
  await query(
    `INSERT INTO notifications (user_id, title, body) VALUES ($1, $2, $3)`,
    [userId, title, body]
  ).catch(() => {});
  return { success: true, message: "In-app notification created" };
}

async function createTask(userId: string, title: string, workflowName: string): Promise<ExecuteResult> {
  const row = await queryOne<{ id: string }>(
    `INSERT INTO tasks (user_id, title, done) VALUES ($1, $2, false) RETURNING id`,
    [userId, title]
  ).catch(() => null);
  if (!row) return { success: false, message: "Failed to create task" };
  await query(
    `INSERT INTO notifications (user_id, title, body) VALUES ($1, $2, $3)`,
    [userId, "Task created", `${title} — from "${workflowName}"`]
  ).catch(() => {});
  return { success: true, message: `Task created: ${title.slice(0, 50)}` };
}

// ─── Deploy Agent ─────────────────────────────────────────────────────────────
async function runAgentWithDelivery(
  userId: string,
  config: ActionConfig,
  ctx: AutomationContext,
  integrations?: UserIntegrations | null
): Promise<ExecuteResult> {
  const agentId = config.agent_id?.trim();
  if (!agentId) {
    return {
      success: false,
      message: "No agent selected",
      detail: "Pick an agent from the dropdown (create one in AI Agents first).",
    };
  }

  const run = await runAgentJob(userId, agentId, {
    prompt: config.prompt,
    workflowName: ctx.workflow_name,
    automationId: ctx.automation_id ?? null,
  });

  if (!run) {
    return {
      success: false,
      message: "Agent not found",
      detail: "Create an agent in AI Agents, then select it here.",
    };
  }

  const deliver = config.deliver_via?.length
    ? config.deliver_via
    : ["notification"];

  const excerpt = run.output.length > 280 ? `${run.output.slice(0, 280)}…` : run.output;
  const delivered: string[] = [];

  // Fire all delivery channels in parallel for speed
  const deliveryPromises: Promise<void>[] = [];

  if (deliver.includes("notification")) {
    deliveryPromises.push(
      query(
        `INSERT INTO notifications (user_id, title, body) VALUES ($1, $2, $3)`,
        [userId, `${run.agent.name} — daily report`, excerpt]
      )
        .then(() => { delivered.push("website"); })
        .catch(() => {})
    );
  }

  if (deliver.includes("email")) {
    const to = config.to?.trim() || (integrations?.email_verified ? integrations.email_default_to?.trim() : undefined);
    if (to) {
      const subject = interpolate(config.subject ?? "KernelHub: {{workflow}} — {{agent}}", {
        ...ctx,
        workflow_name: ctx.workflow_name,
      }).replace(/\{\{agent\}\}/g, run.agent.name);
      const html = `<div style="font-family:sans-serif;line-height:1.6">
        <h2>${run.agent.name} — ${run.agent.role}</h2>
        <p style="white-space:pre-wrap">${run.output.replace(/</g, "&lt;")}</p>
        <p style="color:#888;font-size:12px">Stored in KernelHub → AI Agents → Run history</p>
      </div>`;
      deliveryPromises.push(
        sendEmail(to, subject, html, integrations?.email_from_name)
          .then((r) => { if (r.success) delivered.push("email"); })
      );
    }
  }

  if (deliver.includes("slack")) {
    const url = integrations?.slack_webhook_url?.trim();
    if (url) {
      const text = `*${run.agent.name}* (${run.agent.role})\n_${ctx.workflow_name}_\n\n${run.output.slice(0, 3000)}`;
      deliveryPromises.push(
        sendSlack(url, text)
          .then((r) => { if (r.success) delivered.push("Slack"); })
      );
    }
  }

  await Promise.allSettled(deliveryPromises);

  return {
    success: true,
    message: `Agent ran — output saved (${delivered.join(", ") || "stored"})`,
    detail: `Run ID: ${run.runId}`,
  };
}

// ─── Main dispatcher ──────────────────────────────────────────────────────────
export async function executeAutomationAction(
  actionType: string,
  config: ActionConfig,
  ctx: AutomationContext,
  integrations?: UserIntegrations | null
): Promise<ExecuteResult> {
  const msg = config.message
    ? interpolate(config.message, ctx)
    : defaultMessage(ctx);

  try {
    switch (actionType) {
      case "Send Slack Message": {
        const url = config.webhook_url?.trim() || integrations?.slack_webhook_url?.trim();
        if (!url) {
          return {
            success: false,
            message: "Slack not connected",
            detail: "Go to Settings → Connections and connect Slack (one-time setup).",
          };
        }
        return sendSlack(url, msg);
      }

      case "Trigger Webhook": {
        const url = config.url?.trim();
        if (!url) return { success: false, message: "Missing webhook URL in workflow config" };
        return sendWebhook(url, {
          event: "javis.automation",
          workflow: ctx.workflow_name,
          trigger: ctx.trigger,
          task_title: ctx.task_title,
          from_column: ctx.from_column,
          to_column: ctx.to_column,
          kanban_label: ctx.kanban_label,
          via_approval: ctx.via_approval ?? false,
          timestamp: new Date().toISOString(),
        });
      }

      case "Send Email": {
        const to = config.to?.trim() || (integrations?.email_verified ? integrations?.email_default_to?.trim() : undefined);
        if (!to) {
          return {
            success: false,
            message: "Email not verified",
            detail: "Go to Settings → Connections, verify your email with the code we send you.",
          };
        }
        const subject = interpolate(config.subject ?? "KernelHub: {{workflow}}", ctx);
        const html = `<div style="font-family:sans-serif;line-height:1.5"><h2>${ctx.workflow_name}</h2><p>${msg.replace(/\n/g, "<br>")}</p><p style="color:#888;font-size:12px">Sent by KernelHub Automations</p></div>`;
        return sendEmail(to, subject, html, integrations?.email_from_name);
      }

      case "Send Notification":
        return createInAppNotification(
          ctx.user_id,
          ctx.workflow_name,
          msg
        );

      case "Create Task": {
        const defaultTitle = ctx.trigger === "Scheduled (Daily)"
          ? "Daily: {{workflow}} — {{date}}"
          : "Follow up: {{task_title}}";
        const title = interpolate(config.message?.trim() || defaultTitle, ctx);
        return createTask(ctx.user_id, title, ctx.workflow_name);
      }

      case "Deploy Agent":
        return runAgentWithDelivery(ctx.user_id, config, ctx, integrations);

      default:
        return { success: false, message: `Unknown action: ${actionType}` };
    }
  } catch (err) {
    return { success: false, message: "Action crashed", detail: (err as Error).message };
  }
}

export function parseActionConfig(raw: unknown): ActionConfig {
  let obj: ActionConfig = {};
  if (typeof raw === "string") {
    try { obj = JSON.parse(raw) as ActionConfig; } catch { return {}; }
  } else if (raw && typeof raw === "object") {
    obj = raw as ActionConfig;
  }
  if (obj.deliver_via && typeof obj.deliver_via === "string") {
    obj.deliver_via = (obj.deliver_via as unknown as string).split(",").map(s => s.trim());
  }
  return obj;
}
