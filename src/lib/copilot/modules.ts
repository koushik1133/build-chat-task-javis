/**
 * Copilot module packs — client-safe (no DB imports; the drawer imports this).
 *
 * A pack decides, for one area of the app, (a) which tool modules the copilot
 * may call, (b) a short system-prompt fragment with that module's house rules
 * and (c) how to recognise the page: path prefixes and the query/path params
 * that carry entity ids (`?ticket=…`, `/r/<type>`, …). The server
 * (`copilot.ts`) and the drawer (`copilot-drawer.tsx`) share this file so the
 * module chosen in the browser is the module the server grounds.
 */

export const COPILOT_MODULES = [
  "crm",
  "leads",
  "production",
  "social",
  "strategy",
  "tasks",
  "ads",
  "agents",
  "helpdesk",
  "knowledge",
  "inventory",
  "procurement",
  "orders",
  "workforce",
  "projects",
  "finance",
  "billing",
  "calendar",
  "records",
  "reports",
  "insights",
  "marketplace",
  "voice",
  "marketing",
  "documents",
  "settings",
  "plan",
  "home",
  "general",
] as const;
export type CopilotModule = (typeof COPILOT_MODULES)[number];

export interface CopilotPack {
  label: string;
  /** Path prefixes that select this pack (first match wins, in COPILOT_PACKS order). */
  paths: readonly string[];
  /** Tool `module` names offered (see src/lib/agents/tools). */
  tools: readonly string[];
  /** Concise house rules appended to the system prompt. */
  prompt: string;
  /** Query-string keys whose values are entity ids worth fetching first, mapped to the `get_*` tool to call. */
  entityParams?: Readonly<Record<string, string>>;
}

const SHARED_TOOLS = ["knowledge"] as const;

export const COPILOT_PACKS: Record<CopilotModule, CopilotPack> = {
  home: {
    label: "Home",
    paths: ["/home", "/inbox"],
    tools: ["home", "tasks", "helpdesk", "billing", "calendar", "agents"],
    prompt: "You are on the Home dashboard. Start with home.summary for the KPIs and the 'needs you' list; then act on specific items with the module tools. Keep summaries to the three most important things. /inbox is the unified activity center (notifications, snooze, approvals link); the command palette (Cmd/Ctrl+K) searches every module and `?` lists keyboard shortcuts.",
  },
  crm: {
    label: "CRM",
    paths: ["/crm", "/contacts"],
    tools: ["crm", "comms", "privacy", "records"],
    prompt: "CRM rules: look contacts up before creating them (avoid duplicates); log activities for anything you do on a contact; check privacy.consent_status before any marketing send. Customers can message the team from their portal (portal.message_received events, /messaging Portal conversations); replying to them needs approval.",
    entityParams: { contact: "crm.get_contact", id: "crm.get_contact" },
  },
  leads: {
    label: "Leads",
    paths: ["/leads"],
    tools: ["leads", "crm", "comms"],
    prompt: "Leads rules: qualify before converting; leads.mark_status records the pipeline decision; drafts go through comms.draft_email and sends need approval.",
    entityParams: { lead: "leads.get", id: "leads.get" },
  },
  production: {
    label: "Production",
    paths: ["/production", "/board"],
    tools: ["production", "tasks"],
    prompt: "Production board rules: use the column ids from the snapshot when moving cards; columns marked 'needs approval' pause for a human.",
    entityParams: { card: "production.list_cards" },
  },
  social: {
    label: "Social",
    paths: ["/social", "/channels"],
    tools: ["social"],
    prompt: "Social rules: draft first, schedule second; publishing immediately always needs approval. Match the platform's length limits.",
    entityParams: { post: "social.list_posts" },
  },
  strategy: {
    label: "Strategy",
    paths: ["/strategy"],
    tools: ["strategy"],
    prompt: "Strategy rules: ground recommendations in the saved documents and the Business DNA block; cite which document you used.",
    entityParams: { strategy: "strategy.get", id: "strategy.get" },
  },
  tasks: {
    label: "Tasks",
    paths: ["/tasks", "/todo"],
    tools: ["tasks"],
    prompt: "Tasks rules: one task per actionable item; complete tasks only when the user says so.",
  },
  ads: {
    label: "Ads",
    paths: ["/ads"],
    tools: ["strategy"],
    prompt: "Ads rules: read-only on spend data; recommend changes, do not promise to apply them.",
  },
  agents: {
    label: "Agents",
    paths: ["/agents", "/approvals", "/automations"],
    tools: ["agents", "marketplace", "automations"],
    prompt:
      "Agents rules: explain what an agent will do before queuing a run; point at the Approvals inbox for pending items; suggest marketplace listings when no agent fits. Automations: use automations.list to see workflows and their last error before suggesting fixes; recommend a template (automations.install_template) when the user describes a common workflow; templates install paused — tell the user to review recipients and enable it from /automations.",
    entityParams: { run: "agents.list", agent: "agents.list", automation: "automations.list" },
  },
  helpdesk: {
    label: "Helpdesk",
    paths: ["/helpdesk", "/tickets"],
    tools: ["helpdesk", "crm"],
    prompt: "Helpdesk rules: fetch the ticket (helpdesk.get_ticket) before replying; search the knowledge base (kb.search) for an answer first; replies to customers need approval, internal notes and status/SLA changes do not. Respect SLA due times — mention breaches explicitly.",
    entityParams: { ticket: "helpdesk.get_ticket" },
  },
  knowledge: {
    label: "Knowledge",
    paths: ["/knowledge", "/kb", "/help-center"],
    tools: ["knowledge", "helpdesk"],
    prompt: "Knowledge rules: search before writing; create articles as drafts (kb.create_article) and let the user publish; write markdown with a short intro and numbered steps.",
    entityParams: { article: "kb.search" },
  },
  inventory: {
    label: "Inventory",
    paths: ["/inventory", "/products", "/pricebook", "/equipment"],
    tools: ["inventory", "finance"],
    prompt: "Inventory rules: find the product (products.search) before adjusting stock; receives are safe, consumes/adjustments need approval; check-outs reserve stock and must be checked in.",
    entityParams: { product: "products.search", checkout: "inventory.list_checkouts" },
  },
  orders: {
    label: "Orders & storefront",
    paths: ["/orders", "/storefront"],
    tools: ["orders", "storefront", "inventory", "billing"],
    prompt: "Orders rules: list orders with orders.list before acting; fulfilling an order needs approval and only works on paid orders; never mark an order paid by hand — payment comes from the linked invoice; use storefront.catalog to answer what is on sale and in stock.",
    entityParams: { order: "orders.list" },
  },
  workforce: {
    label: "Workforce",
    paths: ["/workforce"],
    tools: ["workforce", "calendar"],
    prompt: "Workforce rules: check workforce.schedule_gaps before proposing shifts; creating shifts needs approval and must name the staff member, start and end in ISO; never approve leave on your own — summarise workforce.leave_requests and let the manager decide.",
  },
  projects: {
    label: "Projects",
    paths: ["/projects"],
    tools: ["projects", "tasks", "finance"],
    prompt: "Projects rules: start from projects.status before summarising; money is in minor units — convert for the user; creating tasks needs approval and must name the project; never mark milestones done on the user's behalf — suggest it.",
    entityParams: { project: "projects.status" },
  },
  procurement: {
    label: "Procurement",
    paths: ["/procurement", "/suppliers", "/purchase-orders", "/supplier-bills"],
    tools: ["procurement", "inventory", "finance"],
    prompt: "Procurement rules: start from procurement.reorder_suggestions; purchase orders are drafted (approval) and sent by the user; never mark a bill paid without a payment record; quote AP aging from the tool, not from memory.",
    entityParams: { po: "procurement.reorder_suggestions", supplier: "procurement.ap_aging" },
  },
  finance: {
    label: "Finance",
    paths: ["/finance", "/expenses", "/time", "/job-costing", "/change-orders"],
    tools: ["finance", "billing"],
    prompt: "Finance rules: money is in minor units (cents) — convert for the user; tie expenses and time to a job with ref_kind/ref_id when known; change orders are created as drafts.",
    entityParams: { expense: "expenses.log", job: "reports.job_costing" },
  },
  billing: {
    label: "Billing",
    paths: ["/billing", "/quotes", "/invoices", "/payments"],
    tools: ["billing", "crm", "finance"],
    prompt: "Billing rules: quotes and invoices are drafted first; sending needs approval; never mark something paid without a payment record; push to accounting only when asked.",
    entityParams: { quote: "billing.list_quotes", invoice: "billing.list_invoices" },
  },
  calendar: {
    label: "Calendar",
    paths: ["/calendar", "/bookings", "/settings/calendar-sync"],
    tools: ["calendar", "crm"],
    prompt: "Calendar rules: offer only real availability (calendar.propose_slots); booking, rescheduling and cancelling notify the customer and need approval.",
    entityParams: { booking: "calendar.propose_slots" },
  },
  records: {
    label: "Records",
    paths: ["/r/", "/records"],
    tools: ["records", "crm", "tasks"],
    prompt: "Records rules: call records.list_types once to learn fields and stages; use the stage keys exactly; deletes always need approval.",
    entityParams: { record: "records.search" },
  },
  reports: {
    label: "Reports",
    paths: ["/reports", "/analytics"],
    tools: ["reports", "optimize", "finance", "billing", "agency"],
    prompt: "Reports rules: call reports.list_saved to learn datasets and field keys, then reports.run (saved report_id or an ad-hoc spec with filters/group_by/measures) for any count, sum or trend; state the period and dataset you used; do not estimate when a tool can compute; mention when rows were truncated.",
    entityParams: { report: "reports.run" },
  },
  insights: {
    label: "Insights",
    paths: ["/insights", "/optimize"],
    tools: ["optimize", "finance"],
    prompt: "Insights rules: run optimize.cashflow / capacity / pricing for anything forward-looking; explain the main driver in one sentence and give one concrete action.",
  },
  marketplace: {
    label: "Marketplace",
    paths: ["/marketplace"],
    tools: ["marketplace", "agents"],
    prompt: "Marketplace rules: search with the user's goal in words; describe what installing a listing creates before installing; installs need approval.",
    entityParams: { listing: "marketplace.search" },
  },
  voice: {
    label: "Voice",
    paths: ["/voice", "/calls"],
    tools: ["voice", "crm", "privacy"],
    prompt: "Voice rules: campaigns dial real phones — always confirm audience size and script with the user; starting a campaign needs approval; respect do-not-call and consent.",
    entityParams: { campaign: "voice.campaign_status" },
  },
  marketing: {
    label: "Marketing",
    paths: ["/marketing"],
    tools: ["marketing", "crm", "privacy"],
    prompt: "Marketing rules: consent first — report marketing.audience_count (eligible vs total) before proposing any send; never promise a send to contacts without consent; enrolling into a sequence needs approval; use marketing.campaign_stats for performance questions.",
    entityParams: { campaign: "marketing.campaign_stats", audience: "marketing.audience_count" },
  },
  documents: {
    label: "Documents",
    paths: ["/documents"],
    tools: ["documents", "crm"],
    prompt: "Documents rules: create drafts from the org's templates (documents.create_from_template) and fill custom merge fields from the conversation; never invent legal terms. Sending for signature emails real people and needs approval; check documents.status before re-sending. The signed PDF is attached automatically when everyone has signed.",
    entityParams: { document: "documents.status", id: "documents.status" },
  },
  plan: {
    label: "Plan & usage",
    paths: ["/settings/plan", "/pricing"],
    tools: ["plan", "credits"],
    prompt: "Plan rules: use plan.usage to report the plan, trial days left and usage against each limit; explain upgrades but never start a checkout yourself (owners and admins do that in Settings, Plan & usage). Say clearly when limits are not enforced.",
  },
  settings: {
    label: "Settings",
    paths: ["/settings"],
    tools: ["credits", "privacy", "agents", "chat", "snapshots"],
    prompt: "Settings rules: explain where a setting lives and what it affects; you can read credit balance and consent state but configuration changes are done by the user in the UI. Calendar sync (/settings/calendar-sync) pushes bookings to Google/Outlook and blocks slots from external busy time; chat apps (/settings/chat-apps) relay events to Slack/Teams/Discord, and chat.send posts a message (needs approval).",
  },
  general: {
    label: "Workspace",
    paths: [],
    tools: ["knowledge", "comms", "tasks", "crm", "leads", "home"],
    prompt: "No specific page: use home.summary for an overview, then the relevant module tools.",
  },
};

/** Ordered for prefix matching: longer/more specific prefixes first. */
const PACK_ORDER = (Object.keys(COPILOT_PACKS) as CopilotModule[]).filter((m) => m !== "general");

export function moduleFromPath(pathname: string | null | undefined): CopilotModule {
  const p = (pathname ?? "").toLowerCase();
  if (!p || p === "/") return "general";
  let best: { module: CopilotModule; len: number } | null = null;
  for (const m of PACK_ORDER) {
    for (const prefix of COPILOT_PACKS[m].paths) {
      const hit = prefix.endsWith("/") ? p.startsWith(prefix) : p === prefix || p.startsWith(`${prefix}/`) || p.startsWith(`${prefix}?`);
      if (hit && (!best || prefix.length > best.len)) best = { module: m, len: prefix.length };
    }
  }
  return best?.module ?? "general";
}

/** Tool modules offered for a copilot module (pack tools + shared). */
export function toolModulesFor(module: CopilotModule): string[] {
  const out = new Set<string>([...COPILOT_PACKS[module].tools, ...SHARED_TOOLS]);
  return [...out];
}

export interface PageContext {
  /** Current app pathname, e.g. "/helpdesk". */
  pathname: string;
  /** Entity ids visible on the page keyed by param name, e.g. { ticket: "t_1" }. */
  params?: Record<string, string>;
  /** Record type slug when on /r/<type>. */
  recordType?: string | null;
}

const ID_RE = /^[A-Za-z0-9_:-]{1,120}$/;

/**
 * Build the page context the drawer sends: pathname + whitelisted entity ids
 * from the query string (only keys the module pack knows) + record type slug.
 */
export function pageContextFrom(pathname: string | null | undefined, search: string | URLSearchParams | null | undefined, override: { recordType?: string | null } = {}): PageContext {
  const path = pathname ?? "/";
  const mod = moduleFromPath(path);
  const pack = COPILOT_PACKS[mod];
  const sp = typeof search === "string" ? new URLSearchParams(search) : search ?? new URLSearchParams();
  const params: Record<string, string> = {};
  for (const key of Object.keys(pack.entityParams ?? {})) {
    const v = sp.get(key);
    if (v && ID_RE.test(v)) params[key] = v;
  }
  // Second path segment that looks like an id (/crm/<id>, /agents/<id>).
  const segs = path.split("/").filter(Boolean);
  if (segs[1] && mod !== "records" && /^[0-9a-f-]{20,}$/i.test(segs[1]) && !params.id) params.id = segs[1];
  let recordType: string | null = override.recordType ?? null;
  if (!recordType && mod === "records" && segs[0] === "r" && segs[1] && /^[a-z][a-z0-9-]{0,39}$/.test(segs[1])) recordType = segs[1];
  return { pathname: path, params, recordType };
}

/** Human line for the drawer header. */
export function describePage(ctx: PageContext | null | undefined): string {
  if (!ctx) return "";
  const parts: string[] = [];
  if (ctx.recordType) parts.push(ctx.recordType);
  for (const [k, v] of Object.entries(ctx.params ?? {})) parts.push(`${k} ${v.length > 10 ? `${v.slice(0, 8)}…` : v}`);
  return parts.join(" · ");
}
