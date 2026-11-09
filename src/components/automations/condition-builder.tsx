"use client";

import { Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/input";
import { CONDITION_OPS, CONDITION_OP_LABELS, type ConditionGroup, type ConditionNode, type ConditionRule } from "@/lib/automations/types";

/**
 * Recursive AND/OR condition editor. A node is either a rule
 * (field / op / value) or a group `{all: [...]}` / `{any: [...]}`.
 * `fieldOptions` feeds a <datalist> so fields autocomplete from the sample
 * payload; the same list id can be shared by every row.
 */

function isRule(n: ConditionNode): n is ConditionRule {
  return typeof (n as ConditionRule).op === "string";
}

function parseValue(raw: string): unknown {
  const t = raw.trim();
  if (t === "") return "";
  if (t === "true") return true;
  if (t === "false") return false;
  if (t === "null") return null;
  if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t);
  if (t.startsWith("[") || t.startsWith("{")) {
    try {
      return JSON.parse(t);
    } catch {
      return t;
    }
  }
  return t;
}

function valueToString(v: unknown): string {
  if (v === undefined || v === null) return v === null ? "null" : "";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

function RuleRow({ rule, onChange, onRemove, listId }: { rule: ConditionRule; onChange: (r: ConditionRule) => void; onRemove: () => void; listId: string }) {
  const needsValue = rule.op !== "exists";
  return (
    <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
      <Input list={listId} aria-label="Field path" placeholder="event.data.status" value={rule.field} onChange={(e) => onChange({ ...rule, field: e.target.value })} className="sm:flex-1" />
      <Select aria-label="Operator" value={rule.op} onChange={(e) => onChange({ ...rule, op: e.target.value as ConditionRule["op"] })} className="sm:w-40">
        {CONDITION_OPS.map((op) => (
          <option key={op} value={op}>
            {CONDITION_OP_LABELS[op]}
          </option>
        ))}
      </Select>
      {needsValue ? (
        <Input aria-label="Value" placeholder={rule.op === "in" ? "a, b, c" : "value"} value={valueToString(rule.value)} onChange={(e) => onChange({ ...rule, value: parseValue(e.target.value) })} className="sm:flex-1" />
      ) : (
        <div className="hidden sm:block sm:flex-1" />
      )}
      <Button type="button" variant="ghost" size="icon-sm" touch aria-label="Remove condition" onClick={onRemove}>
        <Trash2 className="h-4 w-4" aria-hidden />
      </Button>
    </div>
  );
}

export function ConditionBuilder({
  value,
  onChange,
  fieldOptions,
  listId,
  depth = 0,
}: {
  value: ConditionNode | null;
  onChange: (v: ConditionNode | null) => void;
  fieldOptions: string[];
  listId: string;
  depth?: number;
}) {
  const group: ConditionGroup = value && !isRule(value) ? value : value ? { all: [value] } : { all: [] };
  const mode: "all" | "any" = group.any && !group.all ? "any" : "all";
  const items = (mode === "any" ? group.any : group.all) ?? [];

  const commit = (next: ConditionNode[], m: "all" | "any" = mode) => {
    if (next.length === 0 && depth === 0) return onChange(null);
    onChange(m === "any" ? { any: next } : { all: next });
  };
  const update = (i: number, n: ConditionNode) => commit(items.map((x, j) => (j === i ? n : x)));
  const remove = (i: number) => commit(items.filter((_, j) => j !== i));

  return (
    <div className={depth > 0 ? "rounded-lg border border-border bg-secondary/20 p-3" : ""}>
      {depth === 0 && <datalist id={listId}>{fieldOptions.map((f) => <option key={f} value={f} />)}</datalist>}
      <div className="mb-2 flex flex-wrap items-center gap-2 text-sm">
        <span className="text-muted-foreground">Match</span>
        <Select aria-label="Group mode" value={mode} onChange={(e) => commit(items, e.target.value as "all" | "any")} className="w-32">
          <option value="all">all (AND)</option>
          <option value="any">any (OR)</option>
        </Select>
        <span className="text-muted-foreground">of:</span>
      </div>
      <div className="space-y-2">
        {items.length === 0 && <p className="text-xs text-muted-foreground">No conditions — runs for every matching event.</p>}
        {items.map((n, i) =>
          isRule(n) ? (
            <RuleRow key={i} rule={n} listId={listId} onChange={(r) => update(i, r)} onRemove={() => remove(i)} />
          ) : (
            <div key={i} className="flex items-start gap-2">
              <div className="min-w-0 flex-1">
                <ConditionBuilder value={n} onChange={(v) => (v ? update(i, v) : remove(i))} fieldOptions={fieldOptions} listId={listId} depth={depth + 1} />
              </div>
              <Button type="button" variant="ghost" size="icon-sm" touch aria-label="Remove group" onClick={() => remove(i)}>
                <Trash2 className="h-4 w-4" aria-hidden />
              </Button>
            </div>
          )
        )}
      </div>
      <div className="mt-2 flex flex-wrap gap-2">
        <Button type="button" variant="outline" size="sm" onClick={() => commit([...items, { field: "event.data.", op: "eq", value: "" }])}>
          <Plus className="h-3.5 w-3.5" aria-hidden /> Condition
        </Button>
        {depth < 2 && (
          <Button type="button" variant="ghost" size="sm" onClick={() => commit([...items, { any: [] }])}>
            <Plus className="h-3.5 w-3.5" aria-hidden /> Group
          </Button>
        )}
      </div>
    </div>
  );
}
