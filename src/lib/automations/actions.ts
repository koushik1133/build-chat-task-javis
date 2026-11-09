import { randomUUID } from "crypto";
import { query } from "@/lib/dsql";
import { getTool, needsApproval } from "@/lib/agents/registry";
import type { ToolContext, ToolResult, ToolSpec } from "@/lib/agents/types";
import { enqueueNotification } from "@/lib/notifications/outbox";
import { canSendMarketing, type MarketingDecision } from "@/lib/privacy/consent";
import { sendWebhook } from "@/lib/webhooks/dispatch";
import { evaluateConditions } from "./conditions";
import { renderValue, resolveTemplate } from "./render";
import { APPROVAL_RUN_PREFIX, RUN_LIMITS, type AutomationAutonomy, type PlanStep, type RunContext, type Step } from "./types";

/**
 * Step executors. Each returns a `StepExecution`; the engine persists it,
 * stores `output` under `context.steps[step.id]` and follows `next`.
 *
 * Everything side-effecting goes through `deps` so unit tests can run the
 * engine with fakes (see __tests__/engine.test.ts).
 */

export interface StepExecution {
  status: "ok" | "failed" | "waiting" | "skipped";
  summary: string;
  output?: unknown;
  error?: string;
  /** Step id to continue at; `undefined` = next in order; "end" = finish. */
  next?: string | "end";
  /** For delay steps: when to resume. */
  resumeAt?: Date;
  /** For approval-gated steps: the approvals row to wait on. */
  approvalId?: string;
}

export interface StepEnv {
  dataId: string;
  runId: string;
  automation: { id: string; name: string; autonomy: AutomationAutonomy };
  context: RunContext;
}

export interface StepDeps {
  getTool: (name: string) => ToolSpec | undefined;
  needsApproval: (spec: ToolSpec, input: unknown, ctx: ToolContext) => boolean;
  createApproval: (env: StepEnv, toolName: string, input: unknown, preview: string) => Promise<string>;
  enqueueNotification: typeof enqueueNotification;
  canSendMarketing: (dataId: string, contactId: string, channel: "email" | "sms") => Promise<MarketingDecision>;
  startAgentRun: (dataId: string, agentId: string, prompt: string, automation: { id: string; name: string }) => Promise<string>;
  sendWebhook: (url: string, secret: string, payload: string, headers: { event: string; delivery: string }) => Promise<{ ok: boolean; status: number; ms: number; error?: string }>;
  now: () => Date;
}

async function insertApproval(env: StepEnv, toolName: string, input: unknown, preview: string): Promise<string> {
  const id = randomUUID();
  await query(
    `INSERT INTO approvals (id, user_id, run_id, agent_id, tool_name, input, preview, status, expires_at)
     VALUES ($1, $2, $3, NULL, $4, $5, $6, 'pending', NOW() + ($7 || ' days')::interval)`,
    [id, env.dataId, `${APPROVAL_RUN_PREFIX}${env.runId}`, toolName, JSON.stringify(input ?? {}), preview.slice(0, 1000), String(RUN_LIMITS.approvalTtlDays)]
  );
  return id;
}

export const defaultDeps: StepDeps = {
  getTool,
  needsApproval,
  createApproval: insertApproval,
  enqueueNotification,
  canSendMarketing: (dataId, contactId, channel) => canSendMarketing(dataId, contactId, channel),
  startAgentRun: async (dataId, agentId, prompt, automation) => {
    const { startRun } = await import("@/lib/agents/runner");
    return startRun(dataId, agentId, { prompt, triggerKind: "automation", automationId: automation.id, workflowName: automation.name, triggerRef: automation.id });
  },
  sendWebhook: (url, secret, payload, headers) => sendWebhook(url, secret, payload, headers, { timeoutMs: RUN_LIMITS.toolTimeoutMs }),
  now: () => new Date(),
};

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      }
    );
  });
}

export function toolContextFor(env: StepEnv): ToolContext {
  return { userId: env.dataId, runId: `${APPROVAL_RUN_PREFIX}${env.runId}`, agentId: null, autonomy: env.automation.autonomy };
}

/** Validate + render a tool step's input. */
export function prepareToolInput(spec: ToolSpec, rawInput: Record<string, unknown>, context: RunContext): { ok: true; input: unknown } | { ok: false; error: string } {
  const rendered = renderValue(rawInput, context);
  const parsed = spec.input.safeParse(rendered);
  if (!parsed.success) {
    return { ok: false, error: `invalid input for ${spec.name}: ${parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ")}`.slice(0, 500) };
  }
  return { ok: true, input: parsed.data };
}

/** Run a tool with the automation's autonomy; may pause for approval. `force` skips the gate (approval already granted). */
export async function runTool(env: StepEnv, toolName: string, input: unknown, deps: StepDeps, force = false): Promise<StepExecution> {
  const spec = deps.getTool(toolName);
  if (!spec) return { status: "failed", summary: `Tool ${toolName} is not registered`, error: `unknown tool ${toolName}` };
  const ctx = toolContextFor(env);
  if (!force && deps.needsApproval(spec, input, ctx)) {
    const preview = spec.preview ? spec.preview(input) : `${spec.name} ${JSON.stringify(input).slice(0, 200)}`;
    const approvalId = await deps.createApproval(env, spec.name, input, `${env.automation.name}: ${preview}`);
    return { status: "waiting", summary: `Waiting for approval: ${preview}`, approvalId };
  }
  try {
    const result: ToolResult = await withTimeout(spec.run({ ...ctx, autonomy: "auto" }, input), RUN_LIMITS.toolTimeoutMs, spec.name);
    if (!result.ok) return { status: "failed", summary: result.summary, error: result.error ?? result.summary, output: result.data };
    return { status: "ok", summary: result.summary, output: result.data };
  } catch (err) {
    return { status: "failed", summary: `${spec.name} crashed`, error: errMsg(err) };
  }
}

export async function executeStep(step: Step, env: StepEnv, deps: StepDeps = defaultDeps): Promise<StepExecution> {
  const { context } = env;
  switch (step.kind) {
    case "tool": {
      const spec = deps.getTool(step.config.tool);
      if (!spec) return { status: "failed", summary: `Tool ${step.config.tool} is not registered`, error: `unknown tool ${step.config.tool}` };
      const prepared = prepareToolInput(spec, step.config.input ?? {}, context);
      if (!prepared.ok) return { status: "failed", summary: prepared.error, error: prepared.error };
      return runTool(env, step.config.tool, prepared.input, deps);
    }

    case "delay": {
      const now = deps.now();
      let at: Date | null = null;
      if (step.config.until) {
        const t = Date.parse(resolveTemplate(step.config.until, context));
        if (!Number.isNaN(t)) at = new Date(t);
      }
      if (!at && step.config.minutes) at = new Date(now.getTime() + step.config.minutes * 60_000);
      if (!at) return { status: "failed", summary: "Delay has no valid time", error: "delay: set minutes or a valid until timestamp" };
      const max = now.getTime() + RUN_LIMITS.maxDelayDays * 86_400_000;
      if (at.getTime() > max) at = new Date(max);
      if (at.getTime() <= now.getTime()) return { status: "ok", summary: "Delay already elapsed", output: { until: at.toISOString() } };
      return { status: "waiting", summary: `Waiting until ${at.toISOString()}`, resumeAt: at, output: { until: at.toISOString() } };
    }

    case "branch": {
      const result = evaluateConditions(step.config.conditions, context);
      const target = result ? step.config.then : step.config.else;
      return { status: "ok", summary: `Conditions ${result ? "matched" : "did not match"} → ${target ?? "next step"}`, output: { matched: result }, next: target ?? undefined };
    }

    case "agent": {
      if (!step.config.agent_id) return { status: "failed", summary: "No agent selected", error: "agent step has no agent_id" };
      const prompt = resolveTemplate(step.config.prompt, context);
      try {
        const runId = await deps.startAgentRun(env.dataId, step.config.agent_id, prompt, { id: env.automation.id, name: env.automation.name });
        return { status: "ok", summary: `Queued agent run ${runId}`, output: { run_id: runId, prompt } };
      } catch (err) {
        return { status: "failed", summary: "Agent run could not be queued", error: errMsg(err) };
      }
    }

    case "notify": {
      const to = resolveTemplate(step.config.to, context).trim();
      if (!to) return { status: "skipped", summary: "No recipient after rendering", error: "notify: empty recipient" };
      if (step.config.marketing && step.config.channel !== "in_app") {
        const contactId = step.config.contact_id ? resolveTemplate(step.config.contact_id, context).trim() : "";
        if (!contactId) return { status: "skipped", summary: "Marketing message skipped: no contact id for the consent check" };
        const decision = await deps.canSendMarketing(env.dataId, contactId, step.config.channel);
        if (!decision.allowed) return { status: "skipped", summary: `Marketing message skipped: ${decision.reason}`, output: decision };
      }
      const subject = step.config.subject ? resolveTemplate(step.config.subject, context) : null;
      const body = resolveTemplate(step.config.body, context, { escapeHtml: step.config.channel === "email" });
      try {
        const id = await deps.enqueueNotification(env.dataId, {
          channel: step.config.channel,
          recipient: to,
          subject,
          body,
          // `category` + `member_user_id` let the outbox apply the member's channel/quiet-hour
          // preferences; in-app recipients are member ids, email/SMS recipients are addresses.
          data: {
            automation_id: env.automation.id,
            run_id: env.runId,
            event_type: context.event.type,
            category: "agents",
            ...(step.config.channel === "in_app" ? { member_user_id: to } : {}),
          },
        });
        return { status: "ok", summary: `Queued ${step.config.channel} to ${to}`, output: { outbox_id: id, to, subject } };
      } catch (err) {
        return { status: "failed", summary: "Notification could not be queued", error: errMsg(err) };
      }
    }

    case "webhook": {
      const payload = step.config.payload ? renderValue(step.config.payload, context) : { event: context.event, entity: context.entity, automation: context.automation };
      const body = JSON.stringify(payload);
      const out = await deps.sendWebhook(step.config.url, step.config.secret ?? "", body, { event: context.event.type, delivery: `${env.runId}:${step.id}` });
      if (!out.ok) return { status: "failed", summary: `Webhook failed (${out.status || "no response"})`, error: out.error ?? `HTTP ${out.status}`, output: { status: out.status, ms: out.ms } };
      return { status: "ok", summary: `Webhook ${out.status} in ${out.ms}ms`, output: { status: out.status, ms: out.ms } };
    }

    case "approval": {
      const title = resolveTemplate(step.config.title, context);
      const description = step.config.description ? resolveTemplate(step.config.description, context) : "";
      const approvalId = await deps.createApproval(env, "automations.continue", { step_id: step.id, title }, `${env.automation.name}: ${title}${description ? ` — ${description}` : ""}`);
      return { status: "waiting", summary: `Waiting for approval: ${title}`, approvalId };
    }

    default:
      return { status: "failed", summary: "Unknown step kind", error: `unknown step kind ${(step as { kind: string }).kind}` };
  }
}

/** Dry-run one step: render everything, execute nothing. */
export function planStep(step: Step, env: StepEnv, deps: Pick<StepDeps, "getTool" | "needsApproval"> = defaultDeps): PlanStep {
  const { context } = env;
  const warnings: string[] = [];
  const base = { step_id: step.id, kind: step.kind, name: step.name, warnings };
  switch (step.kind) {
    case "tool": {
      const spec = deps.getTool(step.config.tool);
      if (!spec) {
        warnings.push(`tool ${step.config.tool} is not registered`);
        return { ...base, rendered: renderValue(step.config.input ?? {}, context), summary: `Run ${step.config.tool}`, would_pause: false };
      }
      const prepared = prepareToolInput(spec, step.config.input ?? {}, context);
      if (!prepared.ok) warnings.push(prepared.error);
      const input = prepared.ok ? prepared.input : renderValue(step.config.input ?? {}, context);
      const pause = prepared.ok ? deps.needsApproval(spec, input, toolContextFor(env)) : false;
      return { ...base, rendered: input, summary: spec.preview && prepared.ok ? spec.preview(input) : `Run ${spec.name}`, would_pause: pause };
    }
    case "delay": {
      const until = step.config.until ? resolveTemplate(step.config.until, context) : null;
      if (until && Number.isNaN(Date.parse(until))) warnings.push(`until renders to "${until}", not a date`);
      return { ...base, rendered: { minutes: step.config.minutes, until }, summary: until && !Number.isNaN(Date.parse(until)) ? `Wait until ${until}` : `Wait ${step.config.minutes ?? 0} minutes`, would_pause: false };
    }
    case "branch": {
      const matched = evaluateConditions(step.config.conditions, context);
      return { ...base, rendered: { matched, then: step.config.then ?? null, else: step.config.else ?? null }, summary: `Conditions ${matched ? "match" : "do not match"} → ${(matched ? step.config.then : step.config.else) ?? "next step"}`, would_pause: false };
    }
    case "agent": {
      if (!step.config.agent_id) warnings.push("no agent selected");
      return { ...base, rendered: { agent_id: step.config.agent_id, prompt: resolveTemplate(step.config.prompt, context) }, summary: `Queue agent ${step.config.agent_id || "(none)"}`, would_pause: false };
    }
    case "notify": {
      const to = resolveTemplate(step.config.to, context).trim();
      if (!to) warnings.push("recipient renders to an empty string");
      if (step.config.marketing && step.config.channel !== "in_app" && !step.config.contact_id) warnings.push("marketing is on but no contact_id is set for the consent check");
      return {
        ...base,
        rendered: { channel: step.config.channel, to, subject: step.config.subject ? resolveTemplate(step.config.subject, context) : null, body: resolveTemplate(step.config.body, context), marketing: Boolean(step.config.marketing) },
        summary: `Send ${step.config.channel} to ${to || "(empty)"}`,
        would_pause: false,
      };
    }
    case "webhook":
      return { ...base, rendered: { url: step.config.url, payload: step.config.payload ? renderValue(step.config.payload, context) : { event: context.event } }, summary: `POST ${step.config.url}`, would_pause: false };
    case "approval":
      return { ...base, rendered: { title: resolveTemplate(step.config.title, context) }, summary: `Ask for approval: ${resolveTemplate(step.config.title, context)}`, would_pause: true };
    default:
      return { ...base, rendered: null, summary: "Unknown step", would_pause: false };
  }
}
