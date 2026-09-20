"use client";

import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";

type Tab = "study_planner" | "research_assistant" | "assignment_grader" | "quiz_generator";

interface StudyWeek {
  week?: number | string;
  focus?: string;
}

interface StudyPlanData {
  study_plan?: StudyWeek[];
}

interface StudyPlan {
  id?: string;
  subject?: string;
  goal?: string;
  duration_weeks?: number | string;
  plan_data?: string | StudyPlanData | null;
}

interface ResearchSummary {
  key_points?: string[];
  open_questions?: string[];
}

interface GradeResult {
  grade?: string;
  score_out_of_100?: number | string;
  feedback?: string;
  error?: string;
}

interface QuizQuestion {
  question?: string;
  options?: string[];
  answer?: string;
}

function parsePlanData(raw: StudyPlan["plan_data"]): StudyPlanData | null {
  if (!raw) return null;
  if (typeof raw !== "string") return raw;
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as StudyPlanData) : null;
  } catch {
    return null;
  }
}

export default function EducationHub() {
  const [activeTab, setActiveTab] = useState<Tab>("study_planner");
  const [loading, setLoading] = useState(false);

  // Study Planner State
  const [subject, setSubject] = useState("");
  const [goal, setGoal] = useState("");
  const [duration, setDuration] = useState("4");
  const [plans, setPlans] = useState<StudyPlan[]>([]);

  // Research State
  const [researchTopic, setResearchTopic] = useState("");
  const [notes, setNotes] = useState("");
  const [researchSummary, setResearchSummary] = useState<ResearchSummary | null>(null);

  // Grader State
  const [assignment, setAssignment] = useState("");
  const [rubric, setRubric] = useState("");
  const [gradeResult, setGradeResult] = useState<GradeResult | null>(null);

  // Quiz State
  const [quizTopic, setQuizTopic] = useState("");
  const [difficulty, setDifficulty] = useState("intermediate");
  const [quizResult, setQuizResult] = useState<QuizQuestion[] | null>(null);

  useEffect(() => {
    fetchPlans();
  }, []);

  const fetchPlans = async () => {
    try {
      const res = await fetch("/api/domains/education?action=study_plans");
      const data = await res.json();
      if (Array.isArray(data.plans)) setPlans(data.plans);
    } catch (e) {
      console.error(e);
    }
  };

  const createPlan = async () => {
    setLoading(true);
    try {
      await fetch("/api/domains/education", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "create_study_plan",
          subject,
          goal,
          duration_weeks: parseInt(duration) || 4,
        })
      });
      await fetchPlans();
    } catch (e) {
      console.error(e);
    }
    setLoading(false);
  };

  const summarizeResearch = async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/domains/education", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "summarize_research",
          topic: researchTopic,
          notes_text: notes,
        })
      });
      const data = await res.json().catch(() => null);
      if (res.ok && !data?.error && data?.summary) {
        setResearchSummary(data.summary);
      } else {
        setResearchSummary(null);
        alert(data?.error ?? "Research synthesis failed");
      }
    } catch (e) {
      console.error(e);
    }
    setLoading(false);
  };

  const gradeAssignment = async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/domains/education", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "grade_assignment",
          subject: "General",
          assignment_text: assignment,
          rubric
        })
      });
      const data = await res.json().catch(() => null);
      if (res.ok && !data?.error) {
        setGradeResult(data);
      } else {
        setGradeResult(null);
        alert(data?.error ?? "Grading failed");
      }
    } catch (e) {
      console.error(e);
    }
    setLoading(false);
  };

  const generateQuiz = async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/domains/education", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "generate_quiz",
          topic: quizTopic,
          num_questions: 5,
          difficulty
        })
      });
      const data = await res.json().catch(() => null);
      if (res.ok && !data?.error && Array.isArray(data?.quiz)) {
        setQuizResult(data.quiz);
      } else {
        setQuizResult(null);
        alert(data?.error ?? "Quiz generation failed");
      }
    } catch (e) {
      console.error(e);
    }
    setLoading(false);
  };

  return (
    <div className="h-full overflow-y-auto overflow-x-hidden p-4 sm:p-6 lg:p-8 max-w-6xl mx-auto space-y-8">
      <div className="space-y-2">
        <h1 className="text-3xl font-bold tracking-tight">🎓 Education Hub</h1>
        <p className="text-muted-foreground">AI-powered study tools for students & educators</p>
      </div>

      {/* Tabs */}
      <div className="flex flex-wrap gap-2 pb-4 border-b border-border">
        {(["study_planner", "research_assistant", "assignment_grader", "quiz_generator"] as Tab[]).map((t) => (
          <button
            key={t}
            onClick={() => setActiveTab(t)}
            className={`px-4 py-2 rounded-full text-sm font-medium transition-colors ${
              activeTab === t 
                ? "bg-primary text-primary-foreground" 
                : "bg-muted text-muted-foreground hover:bg-muted/80"
            }`}
          >
            {t.split("_").map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(" ")}
          </button>
        ))}
      </div>

      {/* Content */}
      <div className="grid gap-6">
        
        {activeTab === "study_planner" && (
          <div className="grid md:grid-cols-2 gap-6">
            <div className="rounded-xl border border-border bg-card p-5 space-y-4">
              <h2 className="text-xl font-semibold">Create Study Plan</h2>
              <div className="space-y-3">
                <input 
                  type="text" placeholder="Subject (e.g. Organic Chemistry)" 
                  className="w-full p-2 rounded-md border border-input bg-background"
                  value={subject} onChange={e => setSubject(e.target.value)}
                />
                <input 
                  type="text" placeholder="Goal (e.g. Ace the final exam)" 
                  className="w-full p-2 rounded-md border border-input bg-background"
                  value={goal} onChange={e => setGoal(e.target.value)}
                />
                <input 
                  type="number" placeholder="Duration (weeks)" 
                  className="w-full p-2 rounded-md border border-input bg-background"
                  value={duration} onChange={e => setDuration(e.target.value)}
                />
                <Button onClick={createPlan} disabled={loading} className="w-full">
                  {loading ? "Generating..." : "Generate AI Plan"}
                </Button>
              </div>
            </div>
            
            <div className="space-y-4">
              <h2 className="text-xl font-semibold">Your Plans</h2>
              {plans.map((p, i) => {
                const planData = parsePlanData(p.plan_data);
                return (
                  <div key={i} className="rounded-xl border border-border bg-card p-5 space-y-2">
                    <h3 className="font-bold text-indigo-500">{p.subject}</h3>
                    <p className="text-sm text-muted-foreground">{p.goal} • {p.duration_weeks} weeks</p>
                    <div className="mt-2 space-y-2">
                      {planData?.study_plan?.slice(0, 2).map((week, j) => (
                        <div key={j} className="text-sm p-2 bg-muted rounded-md">
                          <span className="font-semibold">Week {week.week}:</span> {week.focus}
                        </div>
                      ))}
                      {(planData?.study_plan?.length ?? 0) > 2 && (
                        <p className="text-xs text-muted-foreground italic">+{(planData?.study_plan?.length ?? 0) - 2} more weeks...</p>
                      )}
                    </div>
                  </div>
                );
              })}
              {plans.length === 0 && <p className="text-muted-foreground">No plans created yet.</p>}
            </div>
          </div>
        )}

        {activeTab === "research_assistant" && (
          <div className="grid md:grid-cols-2 gap-6">
            <div className="rounded-xl border border-border bg-card p-5 space-y-4">
              <h2 className="text-xl font-semibold">Analyze Notes</h2>
              <input 
                type="text" placeholder="Topic" 
                className="w-full p-2 rounded-md border border-input bg-background"
                value={researchTopic} onChange={e => setResearchTopic(e.target.value)}
              />
              <textarea 
                placeholder="Paste your raw notes here..." 
                className="w-full p-2 rounded-md border border-input bg-background min-h-[200px]"
                value={notes} onChange={e => setNotes(e.target.value)}
              />
              <Button onClick={summarizeResearch} disabled={loading} className="w-full">
                {loading ? "Analyzing..." : "Synthesize Research"}
              </Button>
            </div>
            {researchSummary && (
              <div className="rounded-xl border border-border bg-card p-5 space-y-4">
                <h2 className="text-xl font-semibold text-blue-500">Structured Summary</h2>
                <div>
                  <h3 className="font-semibold">Key Points</h3>
                  <ul className="list-disc pl-5 text-sm space-y-1 mt-1">
                    {researchSummary.key_points?.map((p: string, i: number) => <li key={i}>{p}</li>)}
                  </ul>
                </div>
                <div>
                  <h3 className="font-semibold text-amber-500">Open Questions</h3>
                  <ul className="list-disc pl-5 text-sm space-y-1 mt-1">
                    {researchSummary.open_questions?.map((q: string, i: number) => <li key={i}>{q}</li>)}
                  </ul>
                </div>
              </div>
            )}
          </div>
        )}

        {activeTab === "assignment_grader" && (
          <div className="grid md:grid-cols-2 gap-6">
            <div className="rounded-xl border border-border bg-card p-5 space-y-4">
              <h2 className="text-xl font-semibold">Grade Assignment</h2>
              <textarea 
                placeholder="Paste assignment text here..." 
                className="w-full p-2 rounded-md border border-input bg-background min-h-[150px]"
                value={assignment} onChange={e => setAssignment(e.target.value)}
              />
              <textarea 
                placeholder="Grading rubric (optional)..." 
                className="w-full p-2 rounded-md border border-input bg-background min-h-[100px]"
                value={rubric} onChange={e => setRubric(e.target.value)}
              />
              <Button onClick={gradeAssignment} disabled={loading} className="w-full">
                {loading ? "Grading..." : "Grade with AI"}
              </Button>
            </div>
            {gradeResult && (
              <div className="rounded-xl border border-border bg-card p-5 space-y-4">
                <div className="flex items-center justify-between">
                  <h2 className="text-xl font-semibold">Results</h2>
                  <div className="text-2xl font-bold text-indigo-500">{gradeResult.grade}</div>
                </div>
                <div className="text-sm font-medium">Score: {gradeResult.score_out_of_100}/100</div>
                <div className="p-4 bg-muted rounded-md text-sm whitespace-pre-wrap">
                  {gradeResult.feedback}
                </div>
              </div>
            )}
          </div>
        )}

        {activeTab === "quiz_generator" && (
          <div className="grid md:grid-cols-2 gap-6">
            <div className="rounded-xl border border-border bg-card p-5 space-y-4">
              <h2 className="text-xl font-semibold">Generate Quiz</h2>
              <input 
                type="text" placeholder="Topic (e.g. French Revolution)" 
                className="w-full p-2 rounded-md border border-input bg-background"
                value={quizTopic} onChange={e => setQuizTopic(e.target.value)}
              />
              <select 
                className="w-full p-2 rounded-md border border-input bg-background"
                value={difficulty} onChange={e => setDifficulty(e.target.value)}
              >
                <option value="beginner">Beginner</option>
                <option value="intermediate">Intermediate</option>
                <option value="advanced">Advanced</option>
              </select>
              <Button onClick={generateQuiz} disabled={loading} className="w-full">
                {loading ? "Generating..." : "Create Quiz"}
              </Button>
            </div>
            
            {quizResult && (
              <div className="rounded-xl border border-border bg-card p-5 space-y-6">
                <h2 className="text-xl font-semibold">Interactive Quiz</h2>
                <div className="space-y-4">
                  {(Array.isArray(quizResult) ? quizResult : []).map((q, i) => (
                    <div key={i} className="space-y-2 pb-4 border-b border-border last:border-0">
                      <p className="font-medium text-sm">{i + 1}. {q.question}</p>
                      <div className="space-y-1">
                        {q.options?.map((opt, j) => (
                          <div key={j} className="text-sm p-2 rounded-md bg-muted cursor-pointer hover:bg-muted/80">
                            {opt}
                          </div>
                        ))}
                      </div>
                      <details className="text-xs mt-2">
                        <summary className="text-indigo-500 cursor-pointer">Show Answer</summary>
                        <p className="mt-1 font-semibold text-green-600">{q.answer}</p>
                      </details>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

      </div>
    </div>
  );
}
