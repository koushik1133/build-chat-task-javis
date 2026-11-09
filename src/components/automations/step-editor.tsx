"use client";

import { useMemo, useState } from "react";
import { Braces } from "lucide-react";
import { Field } from "@/components/ui/field";
import { Checkbox, Input, Select, Textarea } from "@/components/ui/input";
import { Pill } from "@/components/ui/pill";
import { renderValue, resolveTemplate } from "@/lib/automations/render";
import type { RunContext, Step, StepConfigByKind } from "@/lib/automations/types";
import { ConditionBuilder } from "./condition-builder";
import type { Catalog, JsonSchema } from "./shared";

/**
 * Per-kind config forms. Tool steps generate their form from the tool's JSON
 * schema; every text field gets a `{{ }}` helper (a datalist of context paths)
 * and the live preview renders the input against the sample context.
 */

function TemplateHint({ listId }: { listId: string }) {
  return (
    <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground">
      <Braces className="h-3 w-3" aria-hidden /> type <code>{"{{"}</code> and pick a field (list: {listId.replace(/-.*$/, "")})
    </span>
  );
}

function Preview({ label = "Preview", value }: { label?: string; value: unknown }) {
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return (
    <div className="rounded-md border border-dashed border-border bg-secondary/30 px-3 py-2">
      <p className="mb-1 text-[11px] uppercase tracking-wide text-muted-foreground">{label}</p>
      <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words text-xs">{text || "(empty)"}</pre>
    </div>
  );
}

function schemaType(s: JsonSchema): string {
  if (s.enum) return "enum";
  const t = Array.isArray(s.type) ? s.type.find((x) => x !== "null") : s.type;
  if (t) return t;
  if (s.anyOf) return schemaType(s.anyOf[0] ?? {});
  return "string";
}

function toEditable(v: unknown): string {
  if (v === undefined || v === null) return "";
  if (typeof v === "string") return v;
  return JSON.stringify(v, null, 2);
}

/** Form generated from a tool's input schema. Values stay strings (templates) unless the schema is boolean/number and the text is not a template. */
export function SchemaForm({ schema, value, onChange, listId }: { schema: JsonSchema; value: Record<string, unknown>; onChange: (v: Record<string, unknown>) => void; listId: string }) {
  const props = schema.properties ?? {};
  const required = new Set(schema.required ?? []);
  const set = (k: string, v: unknown) => {
    const next = { ...value };
    if (v === "" || v === undefined) delete next[k];
    else next[k] = v;
    onChange(next);
  };
  const keys = Object.keys(props);
  if (keys.length === 0) return <p className="text-xs text-muted-foreground">This tool takes no input.</p>;
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {keys.map((k) => {
        const s = props[k];
        const t = schemaType(s);
        const label = `${k}${required.has(k) ? " *" : ""}`;
        const hint = s.description;
        if (t === "boolean") {
          const v = value[k];
          return (
            <Field key={k} label={label} hint={hint}>
              <Select value={v === undefined ? "" : String(v)} onChange={(e) => set(k, e.target.value === "" ? undefined : e.target.value === "true" ? true : e.target.value === "false" ? false : e.target.value)}>
                <option value="">(unset)</option>
                <option value="true">true</option>
                <option value="false">false</option>
                <option value="{{event.data.flag}}">template…</option>
              </Select>
            </Field>
          );
        }
        if (t === "enum") {
          return (
            <Field key={k} label={label} hint={hint}>
              <Select value={toEditable(value[k])} onChange={(e) => set(k, e.target.value)}>
                <option value="">(unset)</option>
                {(s.enum ?? []).map((o) => (
                  <option key={String(o)} value={String(o)}>
                    {String(o)}
                  </option>
                ))}
              </Select>
            </Field>
          );
        }
        if (t === "array" || t === "object") {
          return (
            <Field key={k} label={label} hint={hint ?? "JSON, or a {{ }} template that renders to one"} className="sm:col-span-2">
              <Textarea
                rows={3}
                value={toEditable(value[k])}
                onChange={(e) => {
                  const raw = e.target.value;
                  try {
                    set(k, raw.trim() ? JSON.parse(raw) : undefined);
                  } catch {
                    set(k, raw);
                  }
                }}
              />
            </Field>
          );
        }
        if (t === "number" || t === "integer") {
          return (
            <Field key={k} label={label} hint={hint ?? "number or {{ }} template"}>
              <Input list={listId} inputMode="decimal" value={toEditable(value[k])} onChange={(e) => set(k, /^-?\d+(\.\d+)?$/.test(e.target.value.trim()) ? Number(e.target.value) : e.target.value)} />
            </Field>
          );
        }
        const long = /body|message|note|notes|prompt|description|content|html/i.test(k);
        return (
          <Field key={k} label={label} hint={hint} className={long ? "sm:col-span-2" : undefined}>
            {long ? <Textarea rows={3} value={toEditable(value[k])} onChange={(e) => set(k, e.target.value)} /> : <Input list={listId} value={toEditable(value[k])} onChange={(e) => set(k, e.target.value)} />}
          </Field>
        );
      })}
    </div>
  );
}

function ToolSelect({ tools, value, onChange }: { tools: Catalog["tools"]; value: string; onChange: (name: string) => void }) {
  const [q, setQ] = useState("");
  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return tools.filter((t) => !needle || t.name.includes(needle) || t.description.toLowerCase().includes(needle)).slice(0, 60);
  }, [tools, q]);
  return (
    <div className="grid gap-2 sm:grid-cols-[1fr_2fr]">
      <Field label="Find a tool">
        <Input placeholder="e.g. tasks, helpdesk, crm" value={q} onChange={(e) => setQ(e.target.value)} />
      </Field>
      <Field label="Tool">
        <Select value={value} onChange={(e) => onChange(e.target.value)}>
          {!filtered.some((t) => t.name === value) && value && <option value={value}>{value}</option>}
          {filtered.map((t) => (
            <option key={t.name} value={t.name}>
              {t.name} — {t.description.slice(0, 70)}
            </option>
          ))}
        </Select>
      </Field>
    </div>
  );
}

export function StepConfigEditor({ step, onChange, catalog, context, listId, allSteps }: { step: Step; onChange: (s: Step) => void; catalog: Catalog; context: RunContext; listId: string; allSteps: Step[] }) {
  const others = allSteps.filter((s) => s.id !== step.id);
  const setCfg = <K extends Step["kind"]>(cfg: StepConfigByKind[K]) => onChange({ ...step, config: cfg } as Step);

  switch (step.kind) {
    case "tool": {
      const tool = catalog.tools.find((t) => t.name === step.config.tool);
      return (
        <div className="space-y-3">
          <ToolSelect tools={catalog.tools} value={step.config.tool} onChange={(name) => setCfg<"tool">({ tool: name, input: {} })} />
          {tool ? (
            <>
              <p className="text-xs text-muted-foreground">
                {tool.description}{" "}
                {tool.gated && <Pill tone="warning">needs approval unless autonomy is auto</Pill>}
              </p>
              <SchemaForm schema={tool.schema} value={step.config.input} onChange={(input) => setCfg<"tool">({ ...step.config, input })} listId={listId} />
              <TemplateHint listId={listId} />
              <Preview label="Rendered input (sample event)" value={renderValue(step.config.input, context)} />
            </>
          ) : (
            <p className="text-xs text-destructive">Tool {step.config.tool || "(none)"} is not registered.</p>
          )}
        </div>
      );
    }
    case "delay":
      return (
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Wait (minutes)" hint="Up to 30 days">
            <Input type="number" min={1} value={step.config.minutes ?? ""} onChange={(e) => setCfg<"delay">({ ...step.config, minutes: e.target.value ? Number(e.target.value) : undefined })} />
          </Field>
          <Field label="…or until (ISO timestamp / template)" hint="Wins over minutes when it renders to a date">
            <Input list={listId} placeholder="{{entity.due_at}}" value={step.config.until ?? ""} onChange={(e) => setCfg<"delay">({ ...step.config, until: e.target.value || undefined })} />
          </Field>
          {step.config.until && <Preview label="Renders to" value={resolveTemplate(step.config.until, context)} />}
        </div>
      );
    case "branch":
      return (
        <div className="space-y-3">
          <ConditionBuilder value={step.config.conditions} onChange={(c) => setCfg<"branch">({ ...step.config, conditions: c ?? { all: [] } })} fieldOptions={[]} listId={listId} depth={1} />
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="When true, go to">
              <Select value={step.config.then ?? ""} onChange={(e) => setCfg<"branch">({ ...step.config, then: e.target.value || null })}>
                <option value="">next step</option>
                {others.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.id}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="When false, go to">
              <Select value={step.config.else ?? ""} onChange={(e) => setCfg<"branch">({ ...step.config, else: e.target.value || null })}>
                <option value="">next step</option>
                <option value="end">stop the run</option>
                {others.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.id}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
        </div>
      );
    case "agent":
      return (
        <div className="space-y-3">
          <Field label="Agent" hint={catalog.agents.length === 0 ? "Create an agent under AI Agents first" : undefined}>
            <Select value={step.config.agent_id} onChange={(e) => setCfg<"agent">({ ...step.config, agent_id: e.target.value })}>
              <option value="">Select an agent…</option>
              {catalog.agents.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name} — {a.role}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Prompt">
            <Textarea rows={4} value={step.config.prompt} onChange={(e) => setCfg<"agent">({ ...step.config, prompt: e.target.value })} />
          </Field>
          <TemplateHint listId={listId} />
          <Preview value={resolveTemplate(step.config.prompt, context)} />
        </div>
      );
    case "notify":
      return (
        <div className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Channel">
              <Select value={step.config.channel} onChange={(e) => setCfg<"notify">({ ...step.config, channel: e.target.value as "email" | "sms" | "in_app" })}>
                <option value="in_app">In-app (to a user id)</option>
                <option value="email">Email</option>
                <option value="sms">SMS</option>
              </Select>
            </Field>
            <Field label="To" hint={step.config.channel === "in_app" ? "{{org.id}} = workspace owner" : "address or template"}>
              <Input list={listId} value={step.config.to} onChange={(e) => setCfg<"notify">({ ...step.config, to: e.target.value })} />
            </Field>
            <Field label="Subject" className="sm:col-span-2">
              <Input list={listId} value={step.config.subject ?? ""} onChange={(e) => setCfg<"notify">({ ...step.config, subject: e.target.value || undefined })} />
            </Field>
            <Field label="Body" className="sm:col-span-2">
              <Textarea rows={5} value={step.config.body} onChange={(e) => setCfg<"notify">({ ...step.config, body: e.target.value })} />
            </Field>
          </div>
          {step.config.channel !== "in_app" && (
            <div className="grid gap-3 sm:grid-cols-2">
              <Checkbox label="Marketing message (requires consent)" checked={Boolean(step.config.marketing)} onChange={(e) => setCfg<"notify">({ ...step.config, marketing: e.target.checked || undefined })} />
              {step.config.marketing && (
                <Field label="Contact id for the consent check">
                  <Input list={listId} placeholder="{{event.data.contact_id}}" value={step.config.contact_id ?? ""} onChange={(e) => setCfg<"notify">({ ...step.config, contact_id: e.target.value || undefined })} />
                </Field>
              )}
            </div>
          )}
          <TemplateHint listId={listId} />
          <Preview value={{ to: resolveTemplate(step.config.to, context), subject: step.config.subject ? resolveTemplate(step.config.subject, context) : null, body: resolveTemplate(step.config.body, context) }} />
        </div>
      );
    case "webhook":
      return (
        <div className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="URL" hint="https only; private hosts are refused">
              <Input type="url" value={step.config.url} onChange={(e) => setCfg<"webhook">({ ...step.config, url: e.target.value })} />
            </Field>
            <Field label="Signing secret (optional)" hint="X-KernelHub-Signature">
              <Input type="password" autoComplete="off" value={step.config.secret ?? ""} onChange={(e) => setCfg<"webhook">({ ...step.config, secret: e.target.value || undefined })} />
            </Field>
            <Field label="Payload (JSON with templates; default = event + entity)" className="sm:col-span-2">
              <Textarea
                rows={4}
                value={step.config.payload ? JSON.stringify(step.config.payload, null, 2) : ""}
                onChange={(e) => {
                  try {
                    setCfg<"webhook">({ ...step.config, payload: e.target.value.trim() ? (JSON.parse(e.target.value) as Record<string, unknown>) : undefined });
                  } catch {
                    /* keep typing */
                  }
                }}
              />
            </Field>
          </div>
          <Preview value={step.config.payload ? renderValue(step.config.payload, context) : { event: context.event }} />
        </div>
      );
    case "approval":
      return (
        <div className="space-y-3">
          <Field label="Title" hint="Shown in the Approvals inbox">
            <Input list={listId} value={step.config.title} onChange={(e) => setCfg<"approval">({ ...step.config, title: e.target.value })} />
          </Field>
          <Field label="Description">
            <Textarea rows={2} value={step.config.description ?? ""} onChange={(e) => setCfg<"approval">({ ...step.config, description: e.target.value || undefined })} />
          </Field>
          <Preview value={resolveTemplate(step.config.title, context)} />
        </div>
      );
  }
}
