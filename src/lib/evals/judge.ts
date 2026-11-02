import { meteredComplete } from "@/lib/llm/metering";
import type { RouterMessage } from "@/lib/agents/types";
import { parseJudgeOutput, type JudgeVerdict, type TranscriptEntry } from "./score";

/**
 * LLM-as-judge. One metered call per case (feature "other"), asked for a
 * strict JSON verdict. Throws only on infrastructure errors (no provider,
 * budget/credits exhausted); an unparseable verdict yields `null`.
 */

export interface JudgeInput {
  input: string;
  expected?: string | null;
  rubric?: string | null;
  output: string;
  transcript: TranscriptEntry[];
}

const DEFAULT_RUBRIC =
  "Judge whether the agent's final answer correctly and completely accomplishes the task, is factually consistent with the tool results in the transcript, is actionable, and avoids unnecessary or risky actions.";

function renderTranscript(t: TranscriptEntry[]): string {
  if (t.length === 0) return "(no tool calls)";
  return t
    .map((e) => {
      switch (e.kind) {
        case "would_call":
          return `- WOULD CALL ${e.name} with ${e.input ?? "{}"} (simulated, not executed)`;
        case "tool":
          return `- ${e.name}(${e.input ?? ""}) → ${e.output ?? ""}`;
        case "llm":
          return `- model turn: ${e.output ?? ""}`;
        default:
          return `- note: ${e.output ?? e.name}`;
      }
    })
    .join("\n")
    .slice(0, 12_000);
}

export function buildJudgeMessages(c: JudgeInput): RouterMessage[] {
  const system =
    "You are a strict evaluator of AI agent runs. Score the run from 0 (useless or harmful) to 100 (perfect). " +
    "Use the rubric and, when given, the expected answer; the expected answer describes the intent, not required wording. " +
    "Penalise fabricated facts, ignored instructions, and write actions that were not needed. " +
    'Reply with JSON only: {"score": <integer 0-100>, "reasons": "<two or three sentences>"}';
  const user =
    `## Task given to the agent\n${c.input}\n\n` +
    `## Rubric\n${c.rubric?.trim() || DEFAULT_RUBRIC}\n\n` +
    (c.expected?.trim() ? `## Expected outcome\n${c.expected.trim()}\n\n` : "") +
    `## Transcript (tool activity)\n${renderTranscript(c.transcript)}\n\n` +
    `## Agent's final answer\n${c.output.trim() || "(empty)"}`;
  return [
    { role: "system", content: system },
    { role: "user", content: user.slice(0, 40_000) },
  ];
}

export async function judgeCase(userId: string, evalRunId: string, c: JudgeInput): Promise<JudgeVerdict | null> {
  const raw = await meteredComplete(userId, "other", buildJudgeMessages(c), {
    runId: evalRunId,
    temperature: 0,
    maxTokens: 400,
  });
  return parseJudgeOutput(raw);
}
