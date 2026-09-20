import type { ToolContext, ToolSpec } from "./types";

/**
 * The single registry of tools an agent can call.
 *
 * The agent loop, the per-module copilots and the MCP server all read from
 * here, so a tool exists in one place or nowhere. Modules register at import
 * time via `registerTool`; `src/lib/agents/tools/index.ts` imports them all.
 */

const tools = new Map<string, ToolSpec>();

export function registerTool<T>(spec: ToolSpec<T>): ToolSpec<T> {
  if (!/^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/.test(spec.name)) {
    throw new Error(`Tool name must look like "module.action": ${spec.name}`);
  }
  if (tools.has(spec.name)) {
    // Hot reload in dev re-imports modules; the latest definition wins.
    tools.delete(spec.name);
  }
  tools.set(spec.name, spec as ToolSpec);
  return spec;
}

export function getTool(name: string): ToolSpec | undefined {
  return tools.get(name);
}

export interface ToolFilter {
  /** Restrict to these names (an agent's allowlist). */
  names?: string[] | null;
  /** Restrict to one module (a copilot's scope). */
  module?: string;
  scope?: "read" | "write";
}

export function listTools(filter: ToolFilter = {}): ToolSpec[] {
  let out = [...tools.values()];
  if (filter.names && filter.names.length > 0) {
    const allow = new Set(filter.names);
    out = out.filter((t) => allow.has(t.name));
  }
  if (filter.module) out = out.filter((t) => t.module === filter.module);
  if (filter.scope) out = out.filter((t) => t.scope === filter.scope);
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** Decide whether a call must pause for a human, given the agent's autonomy. */
export function needsApproval(spec: ToolSpec, input: unknown, ctx: ToolContext): boolean {
  if (ctx.autonomy === "draft") return spec.scope === "write";
  if (ctx.autonomy === "auto") return false;
  // "approve": defer to the tool's own rule; default write tools to gated.
  const rule = spec.requiresApproval;
  if (typeof rule === "function") return rule(input, ctx);
  if (typeof rule === "boolean") return rule;
  return spec.scope === "write";
}

/** OpenAI-compatible `tools` array for the model. */
export function toOpenAiTools(specs: ToolSpec[]) {
  return specs.map((t) => ({
    type: "function" as const,
    function: {
      name: t.name.replace(".", "__"), // OpenAI-compatible names can't contain "."
      description: t.description,
      parameters: t.parameters,
    },
  }));
}

/** Reverse of the name mangling in `toOpenAiTools`. */
export function fromOpenAiToolName(name: string): string {
  return name.replace("__", ".");
}
