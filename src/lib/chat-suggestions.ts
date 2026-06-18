export type BusinessDna = {
  company_name?: string | null;
  industry?: string | null;
  stage?: string | null;
  product_desc?: string | null;
  target_market?: string | null;
  challenge?: string | null;
  geography?: string | null;
};

const DEFAULT_SUGGESTIONS = [
  "Summarize my uploaded documents into action items for this week.",
  "What should our team prioritize on the production board?",
  "Draft a follow-up email for a key customer or partner.",
  "Outline risks in our current pipeline and suggest next steps.",
  "Create a brief competitive overview for our industry.",
  "What automations would save our team the most time?",
  "Help me prepare talking points for a stakeholder meeting.",
  "Turn these notes into a clear ops checklist for the team.",
];

/** Business-focused starter prompts — personalized when Business DNA exists. */
export function buildChatSuggestions(profile: BusinessDna | null | undefined): string[] {
  if (!profile?.company_name?.trim()) {
    return DEFAULT_SUGGESTIONS;
  }

  const company = profile.company_name.trim();
  const industry = profile.industry?.trim() || "our industry";
  const market = profile.target_market?.trim() || "our customers";
  const product = profile.product_desc?.trim() || "our offering";

  const challenge = profile.challenge?.trim();
  const challengePrompt = challenge
    ? `How can we improve ${challenge.replace(/_/g, " ")} for ${company}?`
    : `What are the top 3 priorities ${company} should focus on this quarter?`;

  return [
    `Summarize my uploaded files into action items for ${company}.`,
    challengePrompt,
    `Draft a professional update email for ${market}.`,
    `What production or ops metrics should ${company} track in ${industry}?`,
    `Outline a 90-day growth plan for ${product}.`,
    `Create stakeholder talking points for ${company}'s next review.`,
    `What automations would help ${company} move faster?`,
    `Compare our positioning in ${industry} and suggest improvements.`,
  ];
}

export function chatPlaceholder(profile: BusinessDna | null | undefined): string {
  if (profile?.company_name?.trim()) {
    return `Ask about ${profile.company_name} — strategy, ops, production, customers, or your files…`;
  }
  return "Ask about strategy, operations, production, customers, or your uploaded files…";
}

export function chatEmptySubtitle(profile: BusinessDna | null | undefined): string {
  if (profile?.company_name?.trim()) {
    const industry = profile.industry?.trim();
    return industry
      ? `Grounded in your Business DNA (${profile.company_name} · ${industry}) and uploaded files.`
      : `Grounded in your Business DNA for ${profile.company_name} and uploaded files.`;
  }
  return "Complete Business DNA in onboarding for sharper answers — your uploaded files add context too.";
}
