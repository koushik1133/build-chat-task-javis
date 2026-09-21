import { NextResponse } from "next/server";
import { requireScope, scopeErrorResponse } from "@/lib/auth/scope";
import { query } from "@/lib/dsql";
import { complete } from "@/lib/llm";
import { llmNotConfiguredResponse } from "@/lib/llm-response";
import { parseModelJson } from "@/lib/model-json";

export async function POST(req: Request) {
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
    const unreadable = () =>
      NextResponse.json({ error: "The model returned an unreadable response. Please try again." }, { status: 502 });

    if (action === "create_study_plan") {
      const { subject, goal, duration_weeks, exam_date } = body;
      
      const prompt = `Create a detailed weekly study plan for the following:
Subject: ${subject}
Goal: ${goal}
Duration: ${duration_weeks} weeks
Exam Date (if any): ${exam_date || 'N/A'}

Respond with JSON in this exact format:
{
  "study_plan": [
    {
      "week": 1,
      "focus": "Topic name",
      "tasks": ["Task 1", "Task 2"]
    }
  ]
}`;
      
      const response = await complete([{ role: "user", content: prompt }]);
      const planData = parseModelJson(response);
      if (!planData) return unreadable();

      await query(
        `INSERT INTO education_study_plans (user_id, subject, goal, duration_weeks, plan_data) VALUES ($1, $2, $3, $4, $5)`,
        [scope.dataId, subject, goal, duration_weeks, JSON.stringify(planData)]
      );

      return NextResponse.json(planData);
    }

    if (action === "summarize_research") {
       const { topic } = body;
       const notes_text = text(body.notes_text);
       const prompt = `Act as an AI research assistant. Summarize the following research notes on the topic: "${topic}".
Notes:
${notes_text}

Respond with JSON in this exact format:
{
  "summary": {
    "key_points": ["point 1", "point 2"],
    "open_questions": ["question 1", "question 2"],
    "citations_needed": ["citation need 1"]
  }
}`;
       const response = await complete([{ role: "user", content: prompt }]);
       const parsed = parseModelJson(response);
       if (!parsed) return unreadable();
       return NextResponse.json(parsed);
    }

    if (action === "grade_assignment") {
       const { rubric, subject } = body;
       const assignment_text = text(body.assignment_text);
       const prompt = `Grade the following assignment for the subject: ${subject}.
Rubric/Guidelines: ${rubric || 'Standard academic grading'}
Assignment Text:
${assignment_text}

Respond with JSON in this exact format:
{
  "grade": "Letter grade (e.g. A, B+)",
  "score_out_of_100": 85,
  "feedback": "Detailed feedback text"
}`;
       const response = await complete([{ role: "user", content: prompt }]);
       const parsed = parseModelJson(response);
       if (!parsed) return unreadable();
       return NextResponse.json(parsed);
    }

    if (action === "generate_quiz") {
       const { topic, difficulty } = body;
       const rawNum = Number(body.num_questions ?? 5);
       const num_questions = Number.isFinite(rawNum) ? Math.min(30, Math.max(1, Math.floor(rawNum))) : 5;
       const prompt = `Generate a ${difficulty} multiple-choice quiz about ${topic} with ${num_questions} questions.
Respond with JSON in this exact format:
{
  "quiz": [
    {
      "question": "Question text?",
      "options": ["A) option 1", "B) option 2", "C) option 3", "D) option 4"],
      "answer": "A) option 1"
    }
  ]
}`;
       const response = await complete([{ role: "user", content: prompt }]);
       const parsed = parseModelJson(response);
       if (!parsed) return unreadable();
       return NextResponse.json(parsed);
    }

    return NextResponse.json({ error: "Invalid action" }, { status: 400 });

  } catch (err) {
    const notConfigured = llmNotConfiguredResponse(err);
    if (notConfigured) return notConfigured;
    console.error("[domains/education] POST error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

export async function GET(req: Request) {
  try {
    let scope;
    try {
      scope = await requireScope({ area: "knowledge", edit: false });
    } catch (err) {
      return scopeErrorResponse(err) ?? NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }

    const { searchParams } = new URL(req.url);
    const action = searchParams.get('action');

    if (action === "study_plans") {
      const plans = await query(
        `SELECT * FROM education_study_plans WHERE user_id = $1 ORDER BY created_at DESC`,
        [scope.dataId]
      );
      
      return NextResponse.json({ plans });

    }

    return NextResponse.json({ error: "Invalid action" }, { status: 400 });
  } catch (err) {
    console.error("[domains/education] GET error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
