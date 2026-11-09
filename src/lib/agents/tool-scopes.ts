import type { Area } from "@/lib/auth/roles";
import { hasScope, readScope, writeScope } from "@/lib/public-api/scopes";
import type { ToolSpec } from "./types";

/**
 * Which API-key scope a tool needs (client-safe, no DB).
 *
 * Tool `module` → area. Read tools need `read:<area>`, write tools
 * `write:<area>`; the legacy `mcp` scope grants everything. Used by the MCP
 * server to filter `tools/list` and refuse `tools/call`.
 */
export const TOOL_MODULE_AREA: Record<string, Area> = {
  crm: "crm",
  records: "crm",
  privacy: "crm",
  documents: "crm",
  marketing: "crm",
  engagement: "crm",
  leads: "leads",
  comms: "messaging",
  webchat: "messaging",
  voice: "messaging",
  knowledge: "knowledge",
  production: "production",
  tasks: "tasks",
  agents: "agents",
  automations: "agents",
  marketplace: "agents",
  snapshots: "settings",
  social: "social",
  calendar: "calendar",
  billing: "billing",
  finance: "billing",
  inventory: "billing",
  procurement: "billing",
  projects: "tasks",
  orders: "billing",
  shipping: "billing",
  tax: "billing",
  storefront: "billing",
  memberships: "billing",
  credits: "billing",
  plan: "billing",
  helpdesk: "helpdesk",
  strategy: "reports",
  optimize: "reports",
  agency: "reports",
  home: "reports",
  reports: "reports",
  workforce: "team",
  chat: "settings",
};

export function areaForTool(spec: Pick<ToolSpec, "module">): Area {
  return TOOL_MODULE_AREA[spec.module] ?? "settings";
}

export function scopeForTool(spec: Pick<ToolSpec, "module" | "scope">) {
  const area = areaForTool(spec);
  return spec.scope === "write" ? writeScope(area) : readScope(area);
}

/** True when the key's scopes allow calling this tool. */
export function keyMayUseTool(granted: readonly string[], spec: Pick<ToolSpec, "module" | "scope">): boolean {
  return hasScope(granted, scopeForTool(spec));
}

/** Full JSON schema for a tool: registry `parameters` plus `additionalProperties: false`. */
export function toolInputSchema(t: Pick<ToolSpec, "parameters">): Record<string, unknown> {
  const params = t.parameters as Record<string, unknown>;
  return { type: "object", properties: {}, ...params, additionalProperties: false };
}
