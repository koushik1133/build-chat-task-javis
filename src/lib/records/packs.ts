import { query } from "@/lib/dsql";
import { createRecord, createType, getType, listTypes } from "./store";
import type { FieldDef, Pack, PackTypeTemplate, RecordType, StageDef } from "./types";

/**
 * Template packs: bundles of record types that mirror the old one-screen
 * vertical hubs, plus a few generic ones. Installing a pack creates its
 * record types for the workspace; it is idempotent by (user_id, slug).
 */

const f = (key: string, label: string, type: FieldDef["type"], extra: Partial<FieldDef> = {}): FieldDef => ({
  key,
  label,
  type,
  ...extra,
});
const s = (key: string, label: string, color?: string): StageDef => ({ key, label, color });

const C = {
  gray: "gray",
  blue: "blue",
  amber: "amber",
  green: "green",
  red: "red",
  purple: "purple",
  orange: "orange",
} as const;

export const PACKS: Pack[] = [
  {
    slug: "healthcare",
    name: "Healthcare",
    description: "Patient intake and appointment tracking for clinics and practices.",
    icon: "heart",
    recordTypes: [
      {
        slug: "patients",
        name: "Patients",
        icon: "heart",
        description: "Patient intake records with history, medications and consent.",
        fields: [
          f("dob", "Date of birth", "date"),
          f("contact_email", "Email", "email"),
          f("contact_phone", "Phone", "phone"),
          f("chief_complaint", "Chief complaint", "textarea", { required: true }),
          f("medical_history", "Medical history", "textarea"),
          f("medications", "Medications", "textarea"),
          f("allergies", "Allergies", "text"),
          f("hipaa_consent", "HIPAA consent", "boolean"),
        ],
        stages: [s("intake", "Intake", C.blue), s("active", "Active", C.green), s("follow_up", "Follow-up", C.amber), s("discharged", "Discharged", C.gray)],
        views: { tableColumns: ["chief_complaint", "contact_phone", "hipaa_consent"], cardFields: ["chief_complaint"] },
        copilot_prompt:
          "You are a clinical operations assistant. Summarise intake notes, flag missing consent or allergy info, and suggest follow-up actions. Never give a diagnosis; keep PHI inside this workspace.",
      },
      {
        slug: "appointments",
        name: "Appointments",
        icon: "calendar",
        description: "Scheduled visits with reason, provider and outcome.",
        fields: [
          f("patient", "Patient", "contact_ref"),
          f("scheduled_at", "Scheduled at", "date", { required: true }),
          f("provider", "Provider", "text"),
          f("reason", "Reason", "textarea"),
          f("visit_type", "Visit type", "select", { options: ["In person", "Telehealth", "Phone"] }),
          f("outcome", "Outcome notes", "textarea"),
        ],
        stages: [s("scheduled", "Scheduled", C.blue), s("confirmed", "Confirmed", C.purple), s("completed", "Completed", C.green), s("no_show", "No-show", C.red), s("cancelled", "Cancelled", C.gray)],
        views: { dueField: "scheduled_at", tableColumns: ["scheduled_at", "provider", "visit_type"], cardFields: ["scheduled_at", "provider"] },
        copilot_prompt: "Help the front desk fill gaps in the schedule, draft reminder messages and spot patients who have missed visits.",
      },
    ],
  },
  {
    slug: "education",
    name: "Education",
    description: "Students, study plans and the courses they are enrolled in.",
    icon: "graduation-cap",
    recordTypes: [
      {
        slug: "students",
        name: "Students",
        icon: "graduation-cap",
        description: "Learners with their goal, subject and progress.",
        fields: [
          f("email", "Email", "email"),
          f("subject", "Subject", "text", { required: true }),
          f("goal", "Goal", "textarea"),
          f("duration_weeks", "Plan length (weeks)", "number"),
          f("progress_pct", "Progress %", "number"),
          f("plan", "Study plan", "textarea"),
        ],
        stages: [s("enrolled", "Enrolled", C.blue), s("in_progress", "In progress", C.amber), s("at_risk", "At risk", C.red), s("completed", "Completed", C.green)],
        views: { tableColumns: ["subject", "duration_weeks", "progress_pct"], cardFields: ["subject", "progress_pct"] },
        copilot_prompt: "You are a learning coach. Build week-by-week study plans, suggest next milestones and flag students whose progress has stalled.",
      },
      {
        slug: "courses",
        name: "Courses",
        icon: "book-open",
        description: "Courses and cohorts you run.",
        fields: [
          f("code", "Course code", "text"),
          f("level", "Level", "select", { options: ["Beginner", "Intermediate", "Advanced"] }),
          f("starts_on", "Starts on", "date"),
          f("seats", "Seats", "number"),
          f("price", "Price", "money"),
          f("syllabus", "Syllabus", "textarea"),
        ],
        stages: [s("draft", "Draft", C.gray), s("open", "Open for enrolment", C.blue), s("running", "Running", C.green), s("archived", "Archived", C.gray)],
        views: { amountField: "price", dueField: "starts_on", tableColumns: ["code", "level", "starts_on", "price"], cardFields: ["level", "starts_on"] },
        copilot_prompt: "Help design syllabi, write course descriptions and plan cohort schedules.",
      },
    ],
  },
  {
    slug: "legal",
    name: "Legal",
    description: "Matters, filings and documents for a law practice.",
    icon: "scale",
    recordTypes: [
      {
        slug: "matters",
        name: "Matters",
        icon: "scale",
        description: "Case files with client, type and billing notes.",
        fields: [
          f("client_name", "Client", "text", { required: true }),
          f("case_type", "Case type", "select", { options: ["civil", "criminal", "corporate", "ip", "family"] }),
          f("opposing_party", "Opposing party", "text"),
          f("court", "Court / venue", "text"),
          f("next_deadline", "Next deadline", "date"),
          f("billed", "Billed to date", "money"),
          f("summary", "Summary", "textarea"),
        ],
        stages: [s("intake", "Intake", C.blue), s("active", "Active", C.green), s("on_hold", "On hold", C.amber), s("settled", "Settled", C.purple), s("won", "Won", C.green), s("closed", "Closed", C.gray)],
        views: { amountField: "billed", dueField: "next_deadline", tableColumns: ["client_name", "case_type", "next_deadline"], cardFields: ["client_name", "next_deadline"] },
        copilot_prompt: "You are a paralegal assistant. Summarise matters, draft timelines, list upcoming deadlines and flag conflicts. Do not give legal advice to clients directly.",
      },
      {
        slug: "documents",
        name: "Documents",
        icon: "file-text",
        description: "Contracts, filings and briefs moving through review.",
        fields: [
          f("matter", "Matter", "text"),
          f("doc_type", "Type", "select", { options: ["Contract", "Filing", "Brief", "Letter", "Other"] }),
          f("due_on", "Due", "date"),
          f("owner", "Owner", "text"),
          f("link", "Link", "url"),
          f("notes", "Notes", "textarea"),
        ],
        stages: [s("drafting", "Drafting", C.blue), s("review", "In review", C.amber), s("signed", "Signed", C.green), s("filed", "Filed", C.purple), s("archived", "Archived", C.gray)],
        views: { dueField: "due_on", tableColumns: ["doc_type", "matter", "due_on"], cardFields: ["doc_type", "due_on"] },
        copilot_prompt: "Help draft and review legal documents, extract key clauses and list what is still missing before filing.",
      },
    ],
  },
  {
    slug: "finance",
    name: "Finance",
    description: "Portfolios, positions and the accounts behind them.",
    icon: "dollar-sign",
    recordTypes: [
      {
        slug: "portfolios",
        name: "Portfolios",
        icon: "trending-up",
        description: "Positions you hold with cost basis and current value.",
        fields: [
          f("asset_type", "Asset type", "select", { options: ["stock", "crypto", "real_estate", "bond", "startup"] }),
          f("ticker", "Ticker", "text"),
          f("quantity", "Quantity", "number"),
          f("buy_price", "Buy price", "money"),
          f("current_price", "Current price", "money"),
          f("notes", "Notes", "textarea"),
        ],
        stages: [s("watching", "Watching", C.gray), s("holding", "Holding", C.green), s("reducing", "Reducing", C.amber), s("exited", "Exited", C.blue)],
        views: { amountField: "current_price", tableColumns: ["asset_type", "ticker", "quantity", "current_price"], cardFields: ["ticker", "quantity"] },
        copilot_prompt: "You are a portfolio analyst assistant. Summarise allocation, compute gains and flag concentration. This is informational, not personalised investment advice.",
      },
      {
        slug: "accounts",
        name: "Accounts",
        icon: "landmark",
        description: "Bank, brokerage and credit accounts.",
        fields: [
          f("institution", "Institution", "text", { required: true }),
          f("account_type", "Type", "select", { options: ["Checking", "Savings", "Brokerage", "Credit", "Loan", "Other"] }),
          f("balance", "Balance", "money"),
          f("statement_day", "Statement day", "number"),
          f("notes", "Notes", "textarea"),
        ],
        stages: [s("open", "Open", C.green), s("review", "Needs review", C.amber), s("closed", "Closed", C.gray)],
        views: { amountField: "balance", tableColumns: ["institution", "account_type", "balance"], cardFields: ["institution", "balance"] },
        copilot_prompt: "Help reconcile balances, spot unusual activity and summarise cash position across accounts.",
      },
    ],
  },
  {
    slug: "realestate",
    name: "Real estate",
    description: "Listings and showings for agents and property managers.",
    icon: "home",
    recordTypes: [
      {
        slug: "properties",
        name: "Properties",
        icon: "home",
        description: "Listings with price, size and status.",
        fields: [
          f("city", "City", "text"),
          f("state", "State", "text"),
          f("property_type", "Type", "select", { options: ["residential", "commercial", "land", "rental"] }),
          f("price", "Price", "money"),
          f("bedrooms", "Bedrooms", "number"),
          f("bathrooms", "Bathrooms", "number"),
          f("sqft", "Square feet", "number"),
          f("description", "Description", "textarea"),
        ],
        stages: [s("coming_soon", "Coming soon", C.gray), s("active", "Active", C.green), s("pending", "Pending", C.amber), s("sold", "Sold", C.blue), s("rented", "Rented", C.purple)],
        views: { amountField: "price", tableColumns: ["city", "property_type", "price", "bedrooms"], cardFields: ["price", "city"] },
        copilot_prompt: "You are a listing assistant. Write compelling property descriptions, compare comps and suggest pricing adjustments.",
      },
      {
        slug: "showings",
        name: "Showings",
        icon: "key",
        description: "Scheduled viewings and buyer feedback.",
        fields: [
          f("buyer", "Buyer", "contact_ref"),
          f("property", "Property", "text"),
          f("scheduled_at", "Scheduled at", "date", { required: true }),
          f("agent", "Agent", "text"),
          f("feedback", "Feedback", "textarea"),
        ],
        stages: [s("requested", "Requested", C.gray), s("scheduled", "Scheduled", C.blue), s("done", "Done", C.green), s("offer", "Offer made", C.purple), s("cancelled", "Cancelled", C.red)],
        views: { dueField: "scheduled_at", tableColumns: ["property", "scheduled_at", "agent"], cardFields: ["property", "scheduled_at"] },
        copilot_prompt: "Help schedule showings, draft follow-ups to buyers and summarise feedback trends per property.",
      },
    ],
  },
  {
    slug: "ecommerce",
    name: "E-commerce",
    description: "Catalog and order flow for an online store.",
    icon: "shopping-bag",
    recordTypes: [
      {
        slug: "products",
        name: "Products",
        icon: "package",
        description: "Catalog items with price and stock.",
        fields: [
          f("sku", "SKU", "text"),
          f("category", "Category", "text"),
          f("price", "Price", "money"),
          f("stock_count", "Stock", "number"),
          f("stock_threshold", "Low-stock threshold", "number"),
          f("description", "Description", "textarea"),
        ],
        stages: [s("draft", "Draft", C.gray), s("live", "Live", C.green), s("low_stock", "Low stock", C.amber), s("out_of_stock", "Out of stock", C.red), s("retired", "Retired", C.gray)],
        views: { amountField: "price", tableColumns: ["sku", "category", "price", "stock_count"], cardFields: ["price", "stock_count"] },
        copilot_prompt: "You are a merchandising assistant. Write product descriptions, summarise reviews and flag items near their low-stock threshold.",
      },
      {
        slug: "orders",
        name: "Orders",
        icon: "shopping-cart",
        description: "Customer orders through fulfilment.",
        fields: [
          f("customer", "Customer", "contact_ref"),
          f("order_number", "Order #", "text"),
          f("total", "Total", "money"),
          f("items", "Items", "textarea"),
          f("ship_by", "Ship by", "date"),
          f("tracking", "Tracking URL", "url"),
        ],
        stages: [s("new", "New", C.blue), s("paid", "Paid", C.purple), s("packed", "Packed", C.amber), s("shipped", "Shipped", C.green), s("delivered", "Delivered", C.green), s("refunded", "Refunded", C.red)],
        views: { amountField: "total", dueField: "ship_by", tableColumns: ["order_number", "total", "ship_by"], cardFields: ["order_number", "total"] },
        copilot_prompt: "Help with order status updates, delayed-shipment outreach and refund decisions.",
      },
    ],
  },
  {
    slug: "nonprofit",
    name: "Non-profit",
    description: "Donor stewardship and fundraising campaigns.",
    icon: "hand-heart",
    recordTypes: [
      {
        slug: "donors",
        name: "Donors",
        icon: "hand-heart",
        description: "Supporters with giving history and causes.",
        fields: [
          f("email", "Email", "email"),
          f("phone", "Phone", "phone"),
          f("total_donated", "Total donated", "money"),
          f("last_donation", "Last donation", "date"),
          f("cause_tags", "Causes", "multiselect", { options: ["Education", "Health", "Environment", "Community", "Arts", "Other"] }),
          f("notes", "Notes", "textarea"),
        ],
        stages: [s("prospect", "Prospect", C.gray), s("active", "Active", C.green), s("major", "Major donor", C.purple), s("lapsed", "Lapsed", C.amber)],
        views: { amountField: "total_donated", tableColumns: ["email", "total_donated", "last_donation"], cardFields: ["total_donated", "last_donation"] },
        copilot_prompt: "You are a development officer assistant. Draft thank-you notes, segment donors by cause and suggest who to re-engage.",
      },
      {
        slug: "campaigns",
        name: "Campaigns",
        icon: "megaphone",
        description: "Fundraising drives with goals and deadlines.",
        fields: [
          f("goal", "Goal", "money"),
          f("raised", "Raised", "money"),
          f("ends_on", "Ends on", "date"),
          f("channel", "Channel", "multiselect", { options: ["Email", "Social", "Events", "Grants", "Direct mail"] }),
          f("description", "Description", "textarea"),
        ],
        stages: [s("planning", "Planning", C.gray), s("live", "Live", C.green), s("wrap_up", "Wrap-up", C.amber), s("closed", "Closed", C.blue)],
        views: { amountField: "goal", dueField: "ends_on", tableColumns: ["goal", "raised", "ends_on"], cardFields: ["raised", "ends_on"] },
        copilot_prompt: "Help plan campaign timelines, write appeals and report progress toward goal.",
      },
    ],
  },
  {
    slug: "startup",
    name: "Startup",
    description: "Investor pipeline and fundraising rounds.",
    icon: "rocket",
    recordTypes: [
      {
        slug: "investors",
        name: "Investors",
        icon: "briefcase",
        description: "Investor outreach from first touch to close.",
        fields: [
          f("firm", "Firm", "text"),
          f("email", "Email", "email"),
          f("check_size", "Check size", "text"),
          f("focus_areas", "Focus areas", "text"),
          f("intro_via", "Intro via", "text"),
          f("notes", "Notes", "textarea"),
        ],
        stages: [s("identified", "Identified", C.gray), s("contacted", "Contacted", C.blue), s("meeting", "Meeting", C.amber), s("term_sheet", "Term sheet", C.purple), s("closed", "Closed", C.green), s("passed", "Passed", C.red)],
        views: { tableColumns: ["firm", "check_size", "focus_areas"], cardFields: ["firm", "check_size"] },
        copilot_prompt: "You are a fundraising chief of staff. Draft investor updates, prioritise outreach and summarise meeting notes.",
      },
      {
        slug: "fundraising",
        name: "Fundraising",
        icon: "trending-up",
        description: "Rounds you are raising, with target and commitments.",
        fields: [
          f("round", "Round", "select", { options: ["Pre-seed", "Seed", "Series A", "Series B", "Bridge", "Other"] }),
          f("target", "Target", "money"),
          f("committed", "Committed", "money"),
          f("close_by", "Close by", "date"),
          f("lead", "Lead investor", "text"),
          f("notes", "Notes", "textarea"),
        ],
        stages: [s("preparing", "Preparing", C.gray), s("raising", "Raising", C.blue), s("closing", "Closing", C.amber), s("closed", "Closed", C.green)],
        views: { amountField: "target", dueField: "close_by", tableColumns: ["round", "target", "committed", "close_by"], cardFields: ["round", "committed"] },
        copilot_prompt: "Help model the round, track commitments against target and draft the closing timeline.",
      },
    ],
  },
  {
    slug: "agency",
    name: "Agency",
    description: "Clients and retainers for a services agency.",
    icon: "briefcase",
    recordTypes: [
      {
        slug: "clients",
        name: "Clients",
        icon: "building",
        description: "Accounts you serve, with primary contact and value.",
        fields: [
          f("contact", "Primary contact", "contact_ref"),
          f("industry", "Industry", "text"),
          f("website", "Website", "url"),
          f("monthly_value", "Monthly value", "money"),
          f("services", "Services", "multiselect", { options: ["Design", "Development", "Marketing", "Consulting", "Support"] }),
          f("notes", "Notes", "textarea"),
        ],
        stages: [s("lead", "Lead", C.gray), s("proposal", "Proposal", C.blue), s("active", "Active", C.green), s("paused", "Paused", C.amber), s("churned", "Churned", C.red)],
        views: { amountField: "monthly_value", tableColumns: ["industry", "monthly_value", "services"], cardFields: ["monthly_value", "industry"] },
        copilot_prompt: "You are an account manager assistant. Draft proposals, summarise client health and suggest upsell opportunities.",
      },
      {
        slug: "retainers",
        name: "Retainers",
        icon: "repeat",
        description: "Recurring engagements and their renewal dates.",
        fields: [
          f("client", "Client", "text", { required: true }),
          f("amount", "Monthly amount", "money"),
          f("hours", "Hours included", "number"),
          f("renews_on", "Renews on", "date"),
          f("scope", "Scope", "textarea"),
        ],
        stages: [s("draft", "Draft", C.gray), s("active", "Active", C.green), s("renewal_due", "Renewal due", C.amber), s("ended", "Ended", C.blue)],
        views: { amountField: "amount", dueField: "renews_on", tableColumns: ["client", "amount", "renews_on"], cardFields: ["client", "renews_on"] },
        copilot_prompt: "Help track retainer utilisation, draft renewal emails and flag scope creep.",
      },
    ],
  },
  {
    slug: "projects",
    name: "Projects",
    description: "A simple project tracker for any team.",
    icon: "folder-kanban",
    recordTypes: [
      {
        slug: "projects",
        name: "Projects",
        icon: "folder-kanban",
        description: "Projects with owner, budget and due date.",
        fields: [
          f("owner", "Owner", "text"),
          f("client", "Client", "contact_ref"),
          f("budget", "Budget", "money"),
          f("due_on", "Due", "date"),
          f("priority", "Priority", "select", { options: ["Low", "Medium", "High"] }),
          f("description", "Description", "textarea"),
        ],
        stages: [s("backlog", "Backlog", C.gray), s("planned", "Planned", C.blue), s("in_progress", "In progress", C.amber), s("review", "Review", C.purple), s("done", "Done", C.green)],
        views: { amountField: "budget", dueField: "due_on", tableColumns: ["owner", "priority", "due_on", "budget"], cardFields: ["owner", "due_on"] },
        copilot_prompt: "You are a project coordinator. Summarise status, list blockers and suggest what to do next.",
      },
    ],
  },
  {
    slug: "hiring",
    name: "Applicants (hiring)",
    description: "A hiring pipeline from application to offer.",
    icon: "users",
    recordTypes: [
      {
        slug: "applicants",
        name: "Applicants",
        icon: "users",
        description: "Candidates moving through your hiring process.",
        fields: [
          f("email", "Email", "email", { required: true }),
          f("phone", "Phone", "phone"),
          f("role", "Role", "text", { required: true }),
          f("source", "Source", "select", { options: ["Referral", "Job board", "LinkedIn", "Inbound", "Agency", "Other"] }),
          f("resume_url", "Resume URL", "url"),
          f("expected_salary", "Expected salary", "money"),
          f("notes", "Notes", "textarea"),
        ],
        stages: [s("applied", "Applied", C.gray), s("screening", "Screening", C.blue), s("interview", "Interview", C.amber), s("offer", "Offer", C.purple), s("hired", "Hired", C.green), s("rejected", "Rejected", C.red)],
        views: { amountField: "expected_salary", tableColumns: ["role", "source", "email"], cardFields: ["role", "source"] },
        copilot_prompt: "You are a recruiting coordinator. Screen resumes against the role, draft interview questions and write candidate updates.",
      },
    ],
  },
  {
    slug: "fleet",
    name: "Vehicles (fleet)",
    description: "Vehicles, maintenance and assignment for a fleet.",
    icon: "truck",
    recordTypes: [
      {
        slug: "vehicles",
        name: "Vehicles",
        icon: "truck",
        description: "Vehicles with plate, mileage and service schedule.",
        fields: [
          f("plate", "Plate", "text", { required: true }),
          f("make_model", "Make / model", "text"),
          f("year", "Year", "number"),
          f("mileage", "Mileage", "number"),
          f("driver", "Assigned driver", "text"),
          f("next_service", "Next service", "date"),
          f("notes", "Notes", "textarea"),
        ],
        stages: [s("available", "Available", C.green), s("in_use", "In use", C.blue), s("maintenance", "Maintenance", C.amber), s("retired", "Retired", C.gray)],
        views: { dueField: "next_service", tableColumns: ["plate", "make_model", "driver", "next_service"], cardFields: ["plate", "driver"] },
        copilot_prompt: "You are a fleet manager assistant. Flag overdue services, balance vehicle assignment and summarise utilisation.",
      },
    ],
  },
  {
    slug: "field-service",
    name: "Jobs (field service)",
    description: "Work orders from request to invoice.",
    icon: "wrench",
    recordTypes: [
      {
        slug: "jobs",
        name: "Jobs",
        icon: "wrench",
        description: "Field jobs with site, technician and quote.",
        fields: [
          f("customer", "Customer", "contact_ref"),
          f("address", "Site address", "text", { required: true }),
          f("scheduled_at", "Scheduled at", "date"),
          f("technician", "Technician", "text"),
          f("quote", "Quoted amount", "money"),
          f("job_type", "Job type", "select", { options: ["Install", "Repair", "Inspection", "Maintenance", "Other"] }),
          f("notes", "Notes", "textarea"),
        ],
        stages: [s("requested", "Requested", C.gray), s("quoted", "Quoted", C.blue), s("scheduled", "Scheduled", C.purple), s("in_progress", "In progress", C.amber), s("done", "Done", C.green), s("invoiced", "Invoiced", C.green)],
        views: { amountField: "quote", dueField: "scheduled_at", contactField: "customer", tableColumns: ["address", "technician", "scheduled_at", "quote"], cardFields: ["address", "scheduled_at"] },
        copilot_prompt: "You are a dispatcher assistant. Schedule technicians, draft customer updates and summarise open jobs by area.",
      },
    ],
  },
];

export function getPack(slug: string): Pack | undefined {
  return PACKS.find((p) => p.slug === slug);
}

export interface PackListing extends Pack {
  installed: boolean;
  /** Slugs from this pack that already exist in the workspace. */
  installedTypes: string[];
}

export async function listPacks(dataId: string): Promise<PackListing[]> {
  const types = await listTypes(dataId);
  const have = new Set(types.map((t) => t.slug));
  return PACKS.map((p) => {
    const installedTypes = p.recordTypes.filter((t) => have.has(t.slug)).map((t) => t.slug);
    return { ...p, installed: installedTypes.length === p.recordTypes.length, installedTypes };
  });
}

function toInput(t: PackTypeTemplate) {
  return {
    slug: t.slug,
    name: t.name,
    icon: t.icon,
    description: t.description,
    fields: t.fields,
    stages: t.stages,
    views: t.views ?? {},
    copilot_prompt: t.copilot_prompt,
  };
}

/**
 * Install a pack: creates each record type unless one with the same slug
 * already exists. Returns the resulting types (existing + created) in pack order.
 */
export async function installPack(dataId: string, packSlug: string): Promise<RecordType[]> {
  const pack = getPack(packSlug);
  if (!pack) throw new Error(`Pack not found: ${packSlug}`);
  const out: RecordType[] = [];
  for (const tpl of pack.recordTypes) {
    const existing = await getType(dataId, tpl.slug);
    if (existing) {
      out.push(existing);
      continue;
    }
    try {
      out.push(await createType(dataId, toInput(tpl), { pack_slug: pack.slug }));
    } catch (err) {
      // Race with a concurrent install: unique (user_id, slug) wins; re-read.
      const again = await getType(dataId, tpl.slug);
      if (!again) throw err;
      out.push(again);
    }
  }
  return out;
}

/** The legacy hub slugs map onto pack slugs (business → startup). */
export const LEGACY_HUB_TO_PACK: Record<string, string> = {
  healthcare: "healthcare",
  education: "education",
  legal: "legal",
  finance: "finance",
  realestate: "realestate",
  ecommerce: "ecommerce",
  nonprofit: "nonprofit",
  business: "startup",
  agency: "agency",
};

/* ─── Legacy migration ─────────────────────────────────────────────────── */

interface LegacySpec {
  table: string;
  pack: string;
  typeSlug: string;
  cols: string[];
  map: (row: Record<string, unknown>) => { title: string; stage?: string; data: Record<string, unknown>; summary?: string | null };
}

const str = (v: unknown) => (v === null || v === undefined ? "" : String(v));
const num = (v: unknown) => (v === null || v === undefined || v === "" ? undefined : Number(v));
const arr = (v: unknown): string[] => {
  if (Array.isArray(v)) return v.map(String);
  if (typeof v === "string") {
    try {
      const p = JSON.parse(v);
      return Array.isArray(p) ? p.map(String) : [];
    } catch {
      return [];
    }
  }
  return [];
};

const LEGACY: LegacySpec[] = [
  {
    table: "healthcare_patients",
    pack: "healthcare",
    typeSlug: "patients",
    cols: ["id", "full_name", "dob", "contact_email", "contact_phone", "chief_complaint", "medical_history", "medications", "allergies", "hipaa_consent", "ai_summary"],
    map: (r) => ({
      title: str(r.full_name) || "Patient",
      stage: "intake",
      summary: str(r.ai_summary) || null,
      data: {
        dob: str(r.dob) || undefined,
        contact_email: str(r.contact_email) || undefined,
        contact_phone: str(r.contact_phone) || undefined,
        chief_complaint: str(r.chief_complaint) || "(none recorded)",
        medical_history: str(r.medical_history) || undefined,
        medications: str(r.medications) || undefined,
        allergies: str(r.allergies) || undefined,
        hipaa_consent: Boolean(r.hipaa_consent),
      },
    }),
  },
  {
    table: "education_study_plans",
    pack: "education",
    typeSlug: "students",
    cols: ["id", "subject", "goal", "duration_weeks", "ai_plan", "progress_pct"],
    map: (r) => {
      const pct = num(r.progress_pct) ?? 0;
      return {
        title: `${str(r.subject) || "Study plan"}${r.goal ? ` – ${str(r.goal).slice(0, 60)}` : ""}`,
        stage: pct >= 100 ? "completed" : pct > 0 ? "in_progress" : "enrolled",
        data: { subject: str(r.subject) || "General", goal: str(r.goal) || undefined, duration_weeks: num(r.duration_weeks), progress_pct: pct, plan: str(r.ai_plan) || undefined },
      };
    },
  },
  {
    table: "legal_cases",
    pack: "legal",
    typeSlug: "matters",
    cols: ["id", "case_name", "client_name", "case_type", "status", "ai_summary"],
    map: (r) => {
      const st = str(r.status);
      const stage = ["active", "on_hold", "settled", "won", "closed"].includes(st) ? st : "active";
      const ct = str(r.case_type);
      return {
        title: str(r.case_name) || "Matter",
        stage,
        summary: str(r.ai_summary) || null,
        data: { client_name: str(r.client_name) || "Unknown", case_type: ["civil", "criminal", "corporate", "ip", "family"].includes(ct) ? ct : undefined },
      };
    },
  },
  {
    table: "finance_portfolios",
    pack: "finance",
    typeSlug: "portfolios",
    cols: ["id", "name", "asset_type", "ticker", "quantity", "buy_price", "current_price", "notes"],
    map: (r) => {
      const at = str(r.asset_type);
      return {
        title: str(r.name) || str(r.ticker) || "Position",
        stage: "holding",
        data: {
          asset_type: ["stock", "crypto", "real_estate", "bond", "startup"].includes(at) ? at : undefined,
          ticker: str(r.ticker) || undefined,
          quantity: num(r.quantity),
          buy_price: num(r.buy_price),
          current_price: num(r.current_price),
          notes: str(r.notes) || undefined,
        },
      };
    },
  },
  {
    table: "realestate_properties",
    pack: "realestate",
    typeSlug: "properties",
    cols: ["id", "address", "city", "state", "property_type", "price", "status", "bedrooms", "bathrooms", "sqft", "ai_description"],
    map: (r) => {
      const st = str(r.status);
      const pt = str(r.property_type);
      return {
        title: str(r.address) || "Property",
        stage: ["active", "pending", "sold", "rented"].includes(st) ? st : "active",
        data: {
          city: str(r.city) || undefined,
          state: str(r.state) || undefined,
          property_type: ["residential", "commercial", "land", "rental"].includes(pt) ? pt : undefined,
          price: num(r.price),
          bedrooms: num(r.bedrooms),
          bathrooms: num(r.bathrooms),
          sqft: num(r.sqft),
          description: str(r.ai_description) || undefined,
        },
      };
    },
  },
  {
    table: "ecommerce_products",
    pack: "ecommerce",
    typeSlug: "products",
    cols: ["id", "name", "category", "sku", "price", "stock_count", "stock_threshold", "ai_description", "review_summary"],
    map: (r) => {
      const stock = num(r.stock_count) ?? 0;
      const threshold = num(r.stock_threshold) ?? 5;
      return {
        title: str(r.name) || "Product",
        stage: stock <= 0 ? "out_of_stock" : stock <= threshold ? "low_stock" : "live",
        summary: str(r.review_summary) || null,
        data: {
          sku: str(r.sku) || undefined,
          category: str(r.category) || undefined,
          price: num(r.price),
          stock_count: stock,
          stock_threshold: threshold,
          description: str(r.ai_description) || undefined,
        },
      };
    },
  },
  {
    table: "nonprofit_donors",
    pack: "nonprofit",
    typeSlug: "donors",
    cols: ["id", "full_name", "email", "phone", "total_donated", "last_donation", "cause_tags", "status", "notes"],
    map: (r) => {
      const allowed = ["Education", "Health", "Environment", "Community", "Arts", "Other"];
      const tags = arr(r.cause_tags).map((t) => allowed.find((a) => a.toLowerCase() === t.toLowerCase()) ?? "Other");
      return {
        title: str(r.full_name) || "Donor",
        stage: str(r.status) === "lapsed" ? "lapsed" : "active",
        data: {
          email: str(r.email) || undefined,
          phone: str(r.phone) || undefined,
          total_donated: num(r.total_donated),
          last_donation: str(r.last_donation) || undefined,
          cause_tags: Array.from(new Set(tags)),
          notes: str(r.notes) || undefined,
        },
      };
    },
  },
  {
    table: "business_investors",
    pack: "startup",
    typeSlug: "investors",
    cols: ["id", "investor_name", "firm", "email", "check_size", "focus_areas", "stage", "notes"],
    map: (r) => {
      const st = str(r.stage);
      return {
        title: str(r.investor_name) || "Investor",
        stage: ["identified", "contacted", "meeting", "term_sheet", "closed", "passed"].includes(st) ? st : "contacted",
        data: {
          firm: str(r.firm) || undefined,
          email: str(r.email) || undefined,
          check_size: str(r.check_size) || undefined,
          focus_areas: str(r.focus_areas) || undefined,
          notes: str(r.notes) || undefined,
        },
      };
    },
  },
];

export interface MigrateResult {
  table: string;
  type: string;
  scanned: number;
  created: number;
  skipped: number;
  errors: string[];
}

/**
 * Copy rows from the legacy vertical tables into records. Idempotent: each
 * record carries `data._legacy_id = "<table>:<id>"`, and rows already
 * migrated are skipped. Installs each pack first.
 */
export async function migrateLegacy(dataId: string, only?: string[]): Promise<MigrateResult[]> {
  const results: MigrateResult[] = [];
  for (const spec of LEGACY) {
    if (only && only.length && !only.includes(spec.table)) continue;
    const res: MigrateResult = { table: spec.table, type: spec.typeSlug, scanned: 0, created: 0, skipped: 0, errors: [] };
    results.push(res);
    let rows: Record<string, unknown>[] = [];
    try {
      rows = await query<Record<string, unknown>>(
        `SELECT ${spec.cols.join(", ")} FROM ${spec.table} WHERE user_id = $1 ORDER BY created_at ASC LIMIT 2000`,
        [dataId]
      );
    } catch (err) {
      res.errors.push(`read failed: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    res.scanned = rows.length;
    if (rows.length === 0) continue;

    const types = await installPack(dataId, spec.pack);
    const type = types.find((t) => t.slug === spec.typeSlug);
    if (!type) {
      res.errors.push(`type ${spec.typeSlug} missing after install`);
      continue;
    }
    const existing = await query<{ data: string }>(
      `SELECT data FROM records WHERE user_id = $1 AND type_id = $2 AND data LIKE '%"_legacy_id"%'`,
      [dataId, type.id]
    );
    const done = new Set<string>();
    for (const e of existing) {
      try {
        const d = JSON.parse(e.data) as { _legacy_id?: string };
        if (d._legacy_id) done.add(d._legacy_id);
      } catch {
        /* ignore */
      }
    }

    for (const row of rows) {
      const legacyId = `${spec.table}:${str(row.id)}`;
      if (done.has(legacyId)) {
        res.skipped++;
        continue;
      }
      try {
        const m = spec.map(row);
        await createRecord(dataId, type, {
          title: m.title,
          stage: m.stage,
          summary: m.summary ?? null,
          data: { ...m.data, _legacy_id: legacyId },
          silent: true,
        });
        res.created++;
      } catch (err) {
        res.errors.push(`${legacyId}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
  return results;
}
