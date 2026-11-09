/**
 * The single place that imports every tool module so `registerTool` runs.
 *
 * Importing this file is a side effect: each module registers its tools with
 * the registry at import time. Call `ensureToolsLoaded()` from anything that
 * lists or runs tools (the agent loop, copilots, the MCP server) so tree
 * shaking or lazy routes can never leave the registry empty.
 */

// ── TOOL MODULES (add one `import "./<module>";` line per module) ────────────
// BEGIN tool-module imports
import "./crm";
import "./leads";
import "./comms";
import "./knowledge";
import "./production";
import "./tasks";
import "./agents";
import "./strategy";
import "./social";
import "./calendar";
import "./billing";
import "./finance";
import "./records";
import "./helpdesk";
import "./marketplace";
import "./credits";
import "./optimize";
import "./accounting";
import "./privacy";
import "./voice";
import "./inventory";
import "./agency";
import "./home";
import "./webchat";
import "./documents";
import "./automations";
import "./reports";
import "./procurement";
import "./workforce";
import "./snapshots";
import "./chat";
import "./marketing";
import "./projects";
import "./orders";
// END tool-module imports
// ─────────────────────────────────────────────────────────────────────────────

let loaded = false;

/** Idempotent; safe to call on every request. */
export function ensureToolsLoaded(): void {
  loaded = true;
}

export function toolsLoaded(): boolean {
  return loaded;
}
