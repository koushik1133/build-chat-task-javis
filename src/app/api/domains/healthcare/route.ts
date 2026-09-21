import { NextRequest, NextResponse } from "next/server";
import { query } from "@/lib/dsql";
import { requireScope, scopeErrorResponse } from "@/lib/auth/scope";
import { complete } from "@/lib/llm";
import { llmNotConfiguredResponse } from "@/lib/llm-response";
import { parseModelJson } from "@/lib/model-json";

// ─── Healthcare Domain API ──────────────────────────────────────────────────

export async function GET(req: NextRequest) {
  try {
    let scope;
    try {
      scope = await requireScope({ area: "knowledge", edit: false });
    } catch (err) {
      return scopeErrorResponse(err) ?? NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }

    const { searchParams } = new URL(req.url);
    const action = searchParams.get("action") ?? "patients";

    if (action === "patients") {
      const rows = await query(
        `SELECT * FROM healthcare_patients WHERE user_id = $1 ORDER BY created_at DESC LIMIT 100`,
        [scope.dataId]
      );
      return NextResponse.json({ patients: rows });
    }

    return NextResponse.json({ error: "Unknown action" }, { status: 400 });
  } catch (err: unknown) {
    console.error("[domains/healthcare] GET error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    let scope;
    try {
      scope = await requireScope({ area: "knowledge", edit: true });
    } catch (err) {
      return scopeErrorResponse(err) ?? NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }

    const rawBody = await req.json().catch(() => null);
    if (!rawBody || typeof rawBody !== "object") return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    const body = rawBody;
    const { action } = body;
    const text = (v: unknown, max = 8000) => (typeof v === "string" ? v.slice(0, max) : "");

    // ── Patient Intake ──────────────────────────────────────────────────────
    if (action === "patient_intake") {
      const { full_name, dob, contact_email, contact_phone, chief_complaint, medical_history, medications, allergies, hipaa_consent } = body;

      if (!full_name?.trim() || !chief_complaint?.trim()) {
        return NextResponse.json({ error: "full_name and chief_complaint required" }, { status: 400 });
      }

      // Generate AI summary of patient intake
      let ai_summary: string | null = null;
      try {
        ai_summary = await complete([
          { role: "user", content: `You are a clinical intake assistant. Based on the following patient information, generate a concise clinical intake summary (3–5 sentences) suitable for a physician. Be factual, professional, and neutral.

Patient: ${full_name}
Chief Complaint: ${chief_complaint}
Medical History: ${medical_history || "Not provided"}
Current Medications: ${medications || "None reported"}
Allergies: ${allergies || "NKDA"}

Generate ONLY the summary, no additional formatting.` }
        ]);
      } catch { /* AI optional */ }

      const rows = await query(
        `INSERT INTO healthcare_patients (user_id, full_name, dob, contact_email, contact_phone, chief_complaint, medical_history, medications, allergies, hipaa_consent, ai_summary)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
        [scope.dataId, full_name.trim(), dob ?? null, contact_email ?? null, contact_phone ?? null, chief_complaint.trim(), medical_history ?? null, medications ?? null, allergies ?? null, !!hipaa_consent, ai_summary]
      );
      return NextResponse.json({ patient: rows[0] }, { status: 201 });
    }

    // ── Clinical Note Summarizer ────────────────────────────────────────────
    if (action === "summarize_note") {
      const note_text = text(body.note_text);
      if (!note_text.trim()) return NextResponse.json({ error: "note_text required" }, { status: 400 });

      const summary = await complete([
        { role: "user", content: `You are a medical documentation assistant. Summarize the following clinical note into a structured SOAP format (Subjective, Objective, Assessment, Plan). Be concise and precise.

Clinical Note:
${note_text}

Output ONLY the SOAP summary.` }
      ]);
      return NextResponse.json({ summary });
    }

    // ── HIPAA Compliance Checker ────────────────────────────────────────────
    if (action === "hipaa_check") {
      const text_to_check = text(body.text_to_check);
      if (!text_to_check.trim()) return NextResponse.json({ error: "text_to_check required" }, { status: 400 });

      const result = await complete([
        { role: "user", content: `You are a HIPAA compliance expert. Analyze the following text and identify any potential HIPAA violations or Protected Health Information (PHI) that should be de-identified. List specific issues found and recommendations.

Text to analyze:
${text_to_check}

Output a JSON object with: { "violations": [string], "phi_found": [string], "recommendations": [string], "risk_level": "low" | "medium" | "high" }` }
      ]);

      const parsed = parseModelJson(result) ?? { violations: [], phi_found: [], recommendations: [result], risk_level: "low" };

      return NextResponse.json({ hipaa_check: parsed });
    }

    // ── Health Analytics Insights ───────────────────────────────────────────
    if (action === "health_insights") {
      const patients = await query(
        `SELECT chief_complaint, medical_history FROM healthcare_patients WHERE user_id = $1 LIMIT 50`,
        [scope.dataId]
      );
      
      if (patients.length === 0) {
        return NextResponse.json({ insights: "No patient data available yet. Add patient records to generate health analytics insights." });
      }

      const complaints = patients.map((p: Record<string, unknown>) => p.chief_complaint as string).filter(Boolean).join(", ");
      const insights = await complete([
        { role: "user", content: `As a healthcare analytics AI, analyze the following chief complaints from a clinical practice and provide: 
1. Top 3 most common conditions seen
2. Patient volume trends
3. Recommendations for practice optimization
4. Any concerning patterns

Chief Complaints: ${complaints}

Keep the response concise and actionable (under 300 words).` }
      ]);
      return NextResponse.json({ insights });
    }

    return NextResponse.json({ error: "Unknown action" }, { status: 400 });
  } catch (err: unknown) {
    const notConfigured = llmNotConfiguredResponse(err);
    if (notConfigured) return notConfigured;
    console.error("[domains/healthcare] POST error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
