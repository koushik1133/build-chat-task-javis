import type { RetrievedChunk } from "./pinecone";
import type { BusinessContext } from "./strategy";

export const SYSTEM_BASE = `You are KernelHub, an AI business operating assistant for founders and operators.
Help with strategy, operations, production planning, customer communication, competitive analysis,
team priorities, automations, and decisions grounded in the user's Business DNA and uploaded files.
Be direct, practical, and action-oriented. Prefer concrete next steps over generic advice.
When citing a user-uploaded file, name it inline like (from notes.md). Never invent file content.
If Business DNA is missing or incomplete, answer from context and files; suggest completing onboarding when relevant.
If unsure, say so and ask one focused follow-up question.`;

export function buildBusinessDnaBlock(profile: Partial<BusinessContext> | null): string {
  if (!profile?.company_name?.trim()) return "";
  const lines = [
    "## Business DNA (from onboarding)",
    `- Company: ${profile.company_name}`,
  ];
  if (profile.industry) lines.push(`- Industry: ${profile.industry}`);
  if (profile.stage) lines.push(`- Stage: ${profile.stage}`);
  if (profile.product_desc) lines.push(`- Product/Service: ${profile.product_desc}`);
  if (profile.target_market) lines.push(`- Target market: ${profile.target_market}`);
  if (profile.geography) lines.push(`- Geography: ${profile.geography}`);
  if (profile.challenge) lines.push(`- Key challenge: ${profile.challenge.replace(/_/g, " ")}`);
  if (profile.revenue_range) lines.push(`- Revenue range: ${profile.revenue_range}`);
  return lines.join("\n");
}

export function buildContextBlock(chunks: RetrievedChunk[]): string {
  if (chunks.length === 0) return "";
  const body = chunks
    .map(
      (c, i) =>
        `[#${i + 1} ${c.fileName} | score=${c.score.toFixed(2)}]\n${c.text}`
    )
    .join("\n\n---\n\n");
  return `## Retrieved context from the user's files\n${body}\n\n(End of retrieved context.)`;
}

export const TASK_EXTRACTOR_SYS = `You extract concrete to-do items from a developer's chat message.
Return tasks only when the user expresses an intent to do something (build, fix, write, refactor, debug, ship, finish).
Skip purely informational questions. Each task should be a short imperative phrase under 80 chars.`;

export const REVIEW_SYS = `You are a senior code reviewer. Given a single source file, produce:
1. A 2-line summary of what the file does.
2. Up to 5 issues, ordered by severity. For each: severity (HIGH/MED/LOW), file:line, problem, suggested fix.
3. One concrete refactor opportunity, or "none" if the file is clean.
Keep total output under 250 words.`;

export const README_SYS = `You write production-grade READMEs for GitHub repos.
Output GitHub-flavored markdown only. Sections, in order:
# <repo>, ## Overview, ## Features, ## Tech stack, ## Quick start, ## Project structure, ## License.
Infer from the file tree + selected files. Do not fabricate features that aren't visible in the code.`;
