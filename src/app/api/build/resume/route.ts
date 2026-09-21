import { NextResponse } from "next/server";
import { requireScope, scopeErrorResponse } from "@/lib/auth/scope";
import { completeJson } from "@/lib/llm";
import { llmNotConfiguredResponse } from "@/lib/llm-response";
import { RESUME_ANALYSIS_SYS } from "@/lib/build-prompts";

export const runtime = "nodejs";
export const maxDuration = 30;

const MAX_BYTES = 5 * 1024 * 1024; // 5MB

type ResumeProfile = {
  name?: string;
  role?: string;
  shortBio?: string;
  skills?: string[];
  projects?: { title: string; desc: string }[];
  experience?: { company: string; role: string; years: string }[];
  suggestedThemes?: string[];
  themeReason?: string;
};

export async function POST(req: Request) {
  try {
    await requireScope({ area: "sites", edit: true });
  } catch (err) {
    return scopeErrorResponse(err) ?? NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ error: "expected multipart form" }, { status: 400 });
  }

  const file = form.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "missing file" }, { status: 400 });
  }
  if (file.size > MAX_BYTES) {
    return NextResponse.json({ error: "file too large (max 5MB)" }, { status: 413 });
  }
  if (!/pdf$/i.test(file.type) && !file.name.toLowerCase().endsWith(".pdf")) {
    return NextResponse.json({ error: "PDF only" }, { status: 400 });
  }

  const buf = Buffer.from(await file.arrayBuffer());

  let text = "";
  try {
    // dynamic import — pdf-parse pulls in fs at module-eval time which Next dislikes at build
    const mod = (await import("pdf-parse")) as unknown as {
      default: (b: Buffer) => Promise<{ text: string }>;
    };
    const out = await mod.default(buf);
    text = (out.text ?? "").trim();
  } catch (err) {
    console.error("[resume] failed to read PDF:", err);
    return NextResponse.json({ error: "Failed to read PDF" }, { status: 500 });
  }

  if (!text || text.length < 80) {
    return NextResponse.json(
      { error: "couldn't extract enough text from this PDF" },
      { status: 422 }
    );
  }

  // Cap to keep prompts cheap.
  const trimmed = text.slice(0, 12000);

  let profile: ResumeProfile | null = null;
  try {
    profile = await completeJson<ResumeProfile>(
    [
      { role: "system", content: RESUME_ANALYSIS_SYS },
      { role: "user", content: trimmed },
    ],
    `{"name":string,"role":string,"shortBio":string,"skills":string[],"projects":[{"title":string,"desc":string}],"experience":[{"company":string,"role":string,"years":string}],"suggestedThemes":string[],"themeReason":string}`
  );
  } catch (err) {
    const notConfigured = llmNotConfiguredResponse(err);
    if (notConfigured) return notConfigured;
    console.error("[resume] LLM analysis failed:", err);
    return NextResponse.json({ error: "couldn't analyze resume" }, { status: 502 });
  }

  if (!profile) {
    return NextResponse.json({ error: "couldn't analyze resume" }, { status: 502 });
  }

  return NextResponse.json({ profile });
}
