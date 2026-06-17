import { NextResponse } from "next/server";
import { requireUser } from "@/lib/supabase/server";
import { query, queryOne } from "@/lib/dsql";

export async function GET() {
  let user;
  try { ({ user } = await requireUser()); }
  catch { return NextResponse.json({ error: "unauthorized" }, { status: 401 }); }
  const profile = await queryOne(
    "SELECT * FROM business_profile WHERE user_id = $1",
    [user.id]
  ).catch(() => null);
  return NextResponse.json({ profile });
}

export async function POST(req: Request) {
  let user;
  try { ({ user } = await requireUser()); }
  catch { return NextResponse.json({ error: "unauthorized" }, { status: 401 }); }

  const body = await req.json();
  const {
    company_name, industry, stage, team_size, geography,
    product_desc, target_market, challenge, revenue_range, modules,
  } = body;

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
      [user.id, company_name, industry, stage, team_size, geography ?? "",
       product_desc ?? "", target_market ?? "", challenge ?? "",
       revenue_range ?? "", JSON.stringify(modules ?? [])]
    );
  } catch (err) {
    console.error("[onboarding] business_profile upsert failed:", err);
    return NextResponse.json({ error: "Failed to save profile", detail: String(err) }, { status: 500 });
  }

  // Auto-create a board config matched to the company type
  const template = pickTemplate(industry, stage);
  const existing = await queryOne(
    "SELECT id FROM board_configs WHERE user_id = $1",
    [user.id]
  ).catch(() => null);
  if (!existing) {
    await query(
      `INSERT INTO board_configs (user_id, name, template, columns, card_fields)
       VALUES ($1, $2, $3, $4, $5)`,
      [user.id, `${company_name} Board`, template.id,
       JSON.stringify(template.columns),
       JSON.stringify(["priority", "due_date", "tags"])]
    );
  }

  return NextResponse.json({ ok: true });
}

function pickTemplate(industry: string, stage: string) {
  if (industry?.includes("SaaS") || industry?.includes("Software")) {
    return TEMPLATES.software_dev;
  }
  if (industry?.includes("Agency") || industry?.includes("Consulting")) {
    return TEMPLATES.agency;
  }
  if (industry?.includes("E-commerce") || industry?.includes("Retail")) {
    return TEMPLATES.sales_pipeline;
  }
  if (stage === "pre-revenue" || stage === "early") {
    return TEMPLATES.sales_pipeline;
  }
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
