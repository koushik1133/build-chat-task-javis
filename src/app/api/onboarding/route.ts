import { NextResponse } from "next/server";
import { z } from "zod";
import { requireScope, scopeErrorResponse } from "@/lib/auth/scope";
import { query, queryOne } from "@/lib/dsql";
import { readCappedText } from "@/lib/request-limits";

/** Legacy business-profile upsert (the wizard posts here). Every field is bounded; unknown keys are rejected. */
const Str = (max: number) => z.string().trim().max(max);
const ProfileBody = z
  .object({
    company_name: Str(200).min(1),
    industry: Str(80).default(""),
    stage: Str(80).default(""),
    team_size: Str(40).default(""),
    geography: Str(120).default(""),
    product_desc: Str(2000).default(""),
    target_market: Str(2000).default(""),
    challenge: Str(2000).default(""),
    revenue_range: Str(80).default(""),
    modules: z.array(Str(40)).max(40).default([]),
  })
  .strict();

export async function GET() {
  let scope;
  try { scope = await requireScope({ area: "settings", edit: false }); }
  catch (err) { return scopeErrorResponse(err) ?? NextResponse.json({ error: "unauthorized" }, { status: 401 }); }
  const profile = await queryOne(
    "SELECT * FROM business_profile WHERE user_id = $1",
    [scope.dataId]
  ).catch(() => null);
  return NextResponse.json({ profile });
}

export async function POST(req: Request) {
  let scope;
  try { scope = await requireScope({ area: "settings", edit: true }); }
  catch (err) { return scopeErrorResponse(err) ?? NextResponse.json({ error: "unauthorized" }, { status: 401 }); }

  const raw = await readCappedText(req, 16_384);
  if (raw === null) return NextResponse.json({ error: "payload too large" }, { status: 413 });
  let json: unknown;
  try {
    json = JSON.parse(raw || "{}");
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  const parsed = ProfileBody.safeParse(json);
  if (!parsed.success) return NextResponse.json({ error: "bad request", issues: parsed.error.issues }, { status: 400 });
  const {
    company_name, industry, stage, team_size, geography,
    product_desc, target_market, challenge, revenue_range, modules,
  } = parsed.data;

  // Upsert profile
  try {
    await query(
      `INSERT INTO business_profile
         (user_id, company_name, industry, stage, team_size, geography,
          product_desc, target_market, challenge, revenue_range, modules, completed)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,true)
       ON CONFLICT (user_id) DO UPDATE SET
         company_name=$2, industry=$3, stage=$4, team_size=$5, geography=$6,
         product_desc=$7, target_market=$8, challenge=$9, revenue_range=$10,
         modules=$11, completed=true`,
      [scope.dataId, company_name, industry, stage, team_size, geography,
       product_desc, target_market, challenge, revenue_range, JSON.stringify(modules)]
    );
  } catch (err) {
    console.warn("[onboarding] business_profile upsert non-fatal error:", err);
  }

  // Auto-create a board config matched to the company type
  try {
    const template = pickTemplate(industry, stage);
    const existing = await queryOne(
      "SELECT id FROM board_configs WHERE user_id = $1",
      [scope.dataId]
    ).catch(() => null);
    if (!existing) {
      await query(
        `INSERT INTO board_configs (user_id, name, template, columns, card_fields)
         VALUES ($1, $2, $3, $4, $5)`,
        [scope.dataId, `${company_name} Board`, template.id,
         JSON.stringify(template.columns),
         JSON.stringify(["priority", "due_date", "tags"])]
      ).catch(() => null);
    }
  } catch (err) {
    console.warn("[onboarding] board_configs create non-fatal error:", err);
  }

  return NextResponse.json({ ok: true });
}

/**
 * Map the onboarding industry/stage to a board template.
 * Onboarding stores lowercase domain keys ("agency", "ecommerce"), so match
 * case-insensitively on substrings rather than on display labels.
 */
function pickTemplate(industry: unknown, stage: unknown) {
  const ind = typeof industry === "string" ? industry.toLowerCase() : "";
  const stg = typeof stage === "string" ? stage.toLowerCase() : "";

  if (/agency|consult/.test(ind)) return TEMPLATES.agency;
  if (/saas|software|startup|business|tech/.test(ind)) return TEMPLATES.software_dev;
  if (/ecommerce|e-commerce|retail|shopify|realestate|real estate|finance|fintech/.test(ind)) {
    return TEMPLATES.sales_pipeline;
  }
  if (/pre-revenue|early/.test(stg)) return TEMPLATES.sales_pipeline;
  return TEMPLATES.default;
}

const TEMPLATES = {
  default: {
    id: "default",
    columns: [
      { id: "pending_approval", label: "Pending Approval", hitl: true, color: "#f59e0b" },
      { id: "todo", label: "To Do", hitl: false, color: "#6366f1" },
      { id: "done", label: "Done", hitl: false, color: "#22c55e" },
    ],
  },
  software_dev: {
    id: "software_dev",
    columns: [
      { id: "backlog", label: "Backlog", hitl: false, color: "#94a3b8" },
      { id: "sprint", label: "In Sprint", hitl: false, color: "#6366f1" },
      { id: "review", label: "In Review", hitl: true, color: "#f59e0b" },
      { id: "staging", label: "Staging", hitl: false, color: "#f97316" },
      { id: "done", label: "Done", hitl: false, color: "#22c55e" },
    ],
  },
  sales_pipeline: {
    id: "sales_pipeline",
    columns: [
      { id: "lead", label: "Lead", hitl: false, color: "#94a3b8" },
      { id: "qualified", label: "Qualified", hitl: false, color: "#6366f1" },
      { id: "proposal", label: "Proposal", hitl: true, color: "#f59e0b" },
      { id: "negotiation", label: "Negotiation", hitl: true, color: "#f97316" },
      { id: "won", label: "Won", hitl: false, color: "#22c55e" },
    ],
  },
  agency: {
    id: "agency",
    columns: [
      { id: "brief", label: "Brief", hitl: false, color: "#94a3b8" },
      { id: "production", label: "In Production", hitl: false, color: "#6366f1" },
      { id: "review", label: "Client Review", hitl: true, color: "#f59e0b" },
      { id: "revision", label: "Revision", hitl: false, color: "#f97316" },
      { id: "delivered", label: "Delivered", hitl: false, color: "#22c55e" },
    ],
  },
};
