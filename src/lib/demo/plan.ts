/**
 * Demo workspace plan — a pure, deterministic description of the sample
 * dataset. `seedDemoWorkspace` (./seed.ts) executes it through the real lib
 * functions so events, numbering and SLA timers behave like production data.
 * Client-safe: no DB imports.
 */

export const DEMO_TAG = "demo";

export type DemoIndustry = string;

export interface DemoContact {
  ref: string;
  full_name: string;
  email: string;
  phone: string;
  company: string;
  role: string;
  lifecycle: "lead" | "prospect" | "customer";
  deal_value: number;
  /** Days ago the contact was last touched; null = never (feeds the stalled-deal detector). */
  lastContactDaysAgo: number | null;
  notes: string;
}

export interface DemoLine {
  description: string;
  quantity: number;
  unit_price_minor: number;
  tax_rate_bp: number;
}

export type DemoQuoteStatus = "draft" | "sent" | "viewed" | "accepted" | "declined";

export interface DemoQuote {
  ref: string;
  contactRef: string;
  status: DemoQuoteStatus;
  items: DemoLine[];
  validInDays: number;
  /** For accepted quotes: whether the resulting invoice is paid via the simulated provider. */
  invoicePaid?: boolean;
  /** For accepted quotes: invoice due offset in days (negative = overdue). */
  invoiceDueInDays?: number;
}

export interface DemoBooking {
  ref: string;
  contactRef: string;
  /** Offset from "today" in days (−14..+14). */
  dayOffset: number;
  hour: number;
  durationMinutes: number;
  notes: string;
  /** Past bookings end up completed or no_show. */
  outcome?: "completed" | "no_show";
}

export type DemoSlaState = "fresh" | "at_risk" | "breached" | "resolved" | "pending";

export interface DemoTicket {
  ref: string;
  contactRef: string;
  subject: string;
  body: string;
  priority: "low" | "normal" | "high" | "urgent";
  sla: DemoSlaState;
  tags: string[];
}

export interface DemoProduct {
  ref: string;
  sku: string;
  name: string;
  kind: "product" | "service";
  unit_price_minor: number;
  cost_minor: number;
  stock_on_hand: number;
  reorder_point: number;
}

export interface DemoExpense {
  category: string;
  vendor: string;
  description: string;
  amount_minor: number;
  daysAgo: number;
}

export interface DemoTimeEntry {
  description: string;
  minutes: number;
  rate_minor: number;
  daysAgo: number;
}

export interface DemoPlan {
  industry: DemoIndustry;
  currency: string;
  contacts: DemoContact[];
  quotes: DemoQuote[];
  bookings: DemoBooking[];
  tickets: DemoTicket[];
  tasks: string[];
  /** Record titles for the first type of the industry pack. */
  records: Array<{ title: string; summary: string }>;
  products: DemoProduct[];
  expenses: DemoExpense[];
  timeEntries: DemoTimeEntry[];
  outboxEmail: { recipientRef: string; subject: string; body: string };
}

const PEOPLE: Array<[string, string, string]> = [
  ["Maya Patel", "Northwind Studio", "Owner"],
  ["Liam O'Connor", "Harbor & Finch", "Operations lead"],
  ["Sofia Alvarez", "Alvarez Family Trust", "Director"],
  ["Noah Kim", "Brightline Dental", "Practice manager"],
  ["Amara Okafor", "Okafor Logistics", "Founder"],
  ["Ethan Brooks", "Brooks Landscaping", "Owner"],
  ["Chloe Dubois", "Dubois Interiors", "Principal designer"],
  ["Mateo Rossi", "Rossi Bakery", "Owner"],
  ["Hana Suzuki", "Suzuki Architects", "Partner"],
  ["Daniel Mensah", "Mensah Consulting", "Managing partner"],
  ["Isabella Costa", "Costa Events", "Event director"],
  ["Oliver Schmidt", "Schmidt Autohaus", "General manager"],
];

const LIFECYCLES: DemoContact["lifecycle"][] = [
  "customer", "customer", "customer", "customer", "prospect", "prospect",
  "prospect", "lead", "lead", "lead", "customer", "prospect",
];

function slugEmail(name: string, company: string): string {
  const first = name.split(" ")[0].toLowerCase().replace(/[^a-z]/g, "");
  const domain = company.toLowerCase().replace(/[^a-z0-9]+/g, "").slice(0, 18);
  return `${first}@${domain}.example.com`;
}

/** Industry-flavoured line items and record titles. */
function flavour(industry: string): { service: string; addon: string; records: Array<{ title: string; summary: string }>; products: DemoProduct[] } {
  const base = (service: string, addon: string, records: string[], products: Array<[string, string, number, number, number]>) => ({
    service,
    addon,
    records: records.map((title, i) => ({ title, summary: `Sample ${industry} record ${i + 1}` })),
    products: products.map(([sku, name, price, cost, stock], i) => ({
      ref: `product-${i + 1}`,
      sku,
      name,
      kind: i === 3 ? ("service" as const) : ("product" as const),
      unit_price_minor: price,
      cost_minor: cost,
      stock_on_hand: stock,
      reorder_point: 5,
    })),
  });
  switch (industry) {
    case "healthcare":
      return base("Initial consultation", "Follow-up visit", ["Routine check-up — Patel", "Post-op review — Kim", "New patient intake — Okafor", "Allergy screening — Dubois", "Annual physical — Rossi", "Referral follow-up — Suzuki"],
        [["GLV-100", "Nitrile gloves (box)", 1899, 1100, 42], ["MSK-50", "Surgical masks (50)", 1299, 700, 3], ["THM-01", "Digital thermometer", 2499, 1400, 12], ["CON-30", "Consultation (30 min)", 9000, 0, 0]]);
    case "agency":
      return base("Brand strategy sprint", "Social content retainer (month)", ["Northwind rebrand", "Harbor & Finch launch campaign", "Brightline website refresh", "Costa Events social retainer", "Okafor pitch deck", "Dubois lookbook"],
        [["TPL-01", "Landing page template", 49900, 0, 25], ["STK-02", "Stock photo bundle", 14900, 9000, 4], ["PRT-03", "Print run (500 flyers)", 22000, 15000, 10], ["HRS-04", "Design hour", 12000, 0, 0]]);
    case "field-service":
    case "fleet":
      return base("Site service call", "Preventive maintenance", ["HVAC service — Northwind", "Generator inspection — Harbor", "Compressor repair — Brooks", "Annual boiler check — Rossi", "Pump replacement — Suzuki", "Fleet tyre rotation — Okafor"],
        [["FLT-01", "Air filter (standard)", 2400, 1200, 30], ["BLT-02", "Drive belt", 3900, 2100, 2], ["OIL-03", "Lubricant (5L)", 5600, 3200, 14], ["LAB-04", "Labour hour", 9500, 0, 0]]);
    case "realestate":
      return base("Property valuation", "Staging package", ["12 Harbor View — listing", "Oak St duplex — viewing", "Lakeside condo — offer", "Mill Road farmhouse — survey", "City loft — lease renewal", "Birch Ave bungalow — closing"],
        [["SGN-01", "For-sale sign", 4500, 2000, 18], ["LCK-02", "Lockbox", 6900, 4000, 3], ["PHO-03", "Photo package", 24900, 12000, 10], ["VAL-04", "Valuation visit", 15000, 0, 0]]);
    default:
      return base("Consulting day", "Implementation support (10 h)", ["Northwind onboarding", "Harbor & Finch quarterly review", "Brightline process audit", "Okafor expansion plan", "Rossi systems migration", "Suzuki retainer renewal"],
        [["KIT-01", "Starter kit", 12900, 6000, 20], ["LIC-02", "Annual licence", 49900, 0, 4], ["ACC-03", "Accessory pack", 3900, 1800, 2], ["SUP-04", "Support hour", 11000, 0, 0]]);
  }
}

/** Build the plan. Deterministic for a given industry so tests can snapshot it. */
export function buildDemoPlan(industry: DemoIndustry, currency = "USD"): DemoPlan {
  const fl = flavour(industry);
  const contacts: DemoContact[] = PEOPLE.map(([full_name, company, role], i) => ({
    ref: `contact-${i + 1}`,
    full_name,
    email: slugEmail(full_name, company),
    phone: `+1555010${String(i + 10).padStart(2, "0")}`,
    company,
    role,
    lifecycle: LIFECYCLES[i],
    deal_value: [4800, 12500, 3200, 9900, 15000, 2600, 7400, 1800, 5600, 22000, 8800, 3900][i],
    // Two stalled prospects (never contacted, old) feed the stalled-deal detector.
    lastContactDaysAgo: i === 4 || i === 6 ? null : i % 3 === 0 ? 2 : 9,
    notes: `${DEMO_TAG}: sample contact for the ${industry} workspace.`,
  }));

  const line = (description: string, quantity: number, unit_price_minor: number, tax_rate_bp = 0): DemoLine => ({ description, quantity, unit_price_minor, tax_rate_bp });

  const quotes: DemoQuote[] = [
    { ref: "quote-1", contactRef: "contact-1", status: "accepted", validInDays: 30, invoicePaid: true, invoiceDueInDays: 14, items: [line(fl.service, 1, 180000, 1000), line(fl.addon, 2, 45000, 1000)] },
    { ref: "quote-2", contactRef: "contact-2", status: "accepted", validInDays: 30, invoicePaid: false, invoiceDueInDays: -6, items: [line(fl.service, 2, 180000, 1000)] },
    { ref: "quote-3", contactRef: "contact-5", status: "sent", validInDays: 21, items: [line(fl.service, 1, 180000, 1000), line(fl.addon, 1, 45000, 1000)] },
    { ref: "quote-4", contactRef: "contact-6", status: "viewed", validInDays: 14, items: [line(fl.addon, 3, 45000, 1000)] },
    { ref: "quote-5", contactRef: "contact-7", status: "draft", validInDays: 30, items: [line(fl.service, 1, 180000, 1000)] },
    { ref: "quote-6", contactRef: "contact-12", status: "declined", validInDays: 10, items: [line(fl.addon, 1, 45000, 1000)] },
  ];

  const bookings: DemoBooking[] = [
    { ref: "booking-1", contactRef: "contact-1", dayOffset: -12, hour: 10, durationMinutes: 60, notes: "Kick-off", outcome: "completed" },
    { ref: "booking-2", contactRef: "contact-2", dayOffset: -8, hour: 14, durationMinutes: 45, notes: "Site walk-through", outcome: "completed" },
    { ref: "booking-3", contactRef: "contact-4", dayOffset: -3, hour: 9, durationMinutes: 30, notes: "Intro call", outcome: "no_show" },
    { ref: "booking-4", contactRef: "contact-3", dayOffset: 0, hour: 11, durationMinutes: 60, notes: "Quarterly review" },
    { ref: "booking-5", contactRef: "contact-5", dayOffset: 0, hour: 15, durationMinutes: 30, notes: "Quote walkthrough" },
    { ref: "booking-6", contactRef: "contact-8", dayOffset: 2, hour: 13, durationMinutes: 30, notes: "Discovery call" },
    { ref: "booking-7", contactRef: "contact-9", dayOffset: 6, hour: 10, durationMinutes: 90, notes: "Workshop" },
    { ref: "booking-8", contactRef: "contact-11", dayOffset: 13, hour: 16, durationMinutes: 30, notes: "Follow-up" },
  ];

  const tickets: DemoTicket[] = [
    { ref: "ticket-1", contactRef: "contact-1", subject: "Invoice shows the wrong billing address", body: "Hi — the address on our last invoice is our old office. Could you re-issue it?", priority: "normal", sla: "fresh", tags: ["billing"] },
    { ref: "ticket-2", contactRef: "contact-2", subject: "No one showed up for the scheduled visit", body: "We waited an hour this morning. Please call me back today.", priority: "urgent", sla: "breached", tags: ["scheduling"] },
    { ref: "ticket-3", contactRef: "contact-4", subject: "Question about the add-on pricing", body: "Is the add-on priced per month or one-off?", priority: "normal", sla: "at_risk", tags: ["sales"] },
    { ref: "ticket-4", contactRef: "contact-3", subject: "Thanks — issue resolved", body: "The fix you sent worked. Closing this one.", priority: "low", sla: "resolved", tags: [] },
    { ref: "ticket-5", contactRef: "contact-11", subject: "Waiting on your confirmation for the event date", body: "Can you confirm the 14th works for your team?", priority: "high", sla: "pending", tags: ["events"] },
  ];

  const tasks = [
    "Call Maya about the signed quote",
    "Send Liam the revised schedule",
    "Prepare slides for Thursday workshop",
    "Reorder low-stock items",
    "Review this month's expenses",
    "Follow up with Amara (stalled)",
    "Draft newsletter for next week",
    "Update booking page availability",
    "Chase overdue invoice",
    "Plan Q-end review with the team",
  ];

  const expenses: DemoExpense[] = [
    { category: "software", vendor: "CloudSuite", description: "Monthly subscription", amount_minor: 4900, daysAgo: 3 },
    { category: "software", vendor: "CloudSuite", description: "Monthly subscription", amount_minor: 4900, daysAgo: 33 },
    { category: "travel", vendor: "City Cabs", description: "Client visit", amount_minor: 3200, daysAgo: 7 },
    { category: "supplies", vendor: "OfficeMart", description: "Printer paper and toner", amount_minor: 8600, daysAgo: 12 },
    { category: "marketing", vendor: "AdNetwork", description: "Local ads", amount_minor: 15000, daysAgo: 20 },
  ];

  const timeEntries: DemoTimeEntry[] = [
    { description: "Kick-off prep", minutes: 90, rate_minor: 12000, daysAgo: 12 },
    { description: "Site walk-through", minutes: 60, rate_minor: 12000, daysAgo: 8 },
    { description: "Proposal writing", minutes: 120, rate_minor: 12000, daysAgo: 4 },
    { description: "Support call", minutes: 30, rate_minor: 9000, daysAgo: 1 },
  ];

  return {
    industry,
    currency,
    contacts,
    quotes,
    bookings,
    tickets,
    tasks,
    records: fl.records,
    products: fl.products,
    expenses,
    timeEntries,
    outboxEmail: {
      recipientRef: "contact-3",
      subject: "Your quarterly review is booked",
      body: "Hi Sofia — confirming our quarterly review today at 11:00. Reply to this email if you need to reschedule.",
    },
  };
}

/** Counts used by tests and the seed summary. */
export function planCounts(plan: DemoPlan): Record<string, number> {
  return {
    contacts: plan.contacts.length,
    quotes: plan.quotes.length,
    invoices: plan.quotes.filter((q) => q.status === "accepted").length,
    bookings: plan.bookings.length,
    tickets: plan.tickets.length,
    tasks: plan.tasks.length,
    records: plan.records.length,
    products: plan.products.length,
    expenses: plan.expenses.length,
    timeEntries: plan.timeEntries.length,
    outbox: 1,
  };
}
