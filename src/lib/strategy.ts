/** Strategy Hub — prompts, types, and helpers. */

export type BusinessContext = {
  company_name: string;
  industry: string;
  product_desc: string;
  target_market: string;
  stage: string;
  geography: string;
  challenge: string;
  revenue_range: string;
};

export type StrategyType =
  | "competitor"
  | "tam"
  | "growth"
  | "gtm"
  | "roadmap"
  | "fundraising";

export const STRATEGY_TYPES: {
  type: StrategyType;
  label: string;
  desc: string;
  emoji: string;
}[] = [
  { type: "competitor", label: "Competitor Benchmarking", desc: "Market leaders and your competitive delta.", emoji: "📊" },
  { type: "tam", label: "TAM/SAM Analysis", desc: "Reachable market segments and scalability.", emoji: "🌍" },
  { type: "growth", label: "Growth Forecasting", desc: "Revenue projections and growth levers.", emoji: "📈" },
  { type: "gtm", label: "Go-to-Market", desc: "ICP, channels, messaging, and launch plan.", emoji: "🎯" },
  { type: "roadmap", label: "Product Roadmap", desc: "Prioritized features and themes.", emoji: "🗺️" },
  { type: "fundraising", label: "Fundraising Narrative", desc: "Investor-ready story and ask.", emoji: "💰" },
];

export const STRATEGY_PROMPTS: Record<StrategyType, (ctx: BusinessContext) => string> = {
  competitor: (ctx) => `
You are a senior strategy consultant. Generate a comprehensive Competitor Benchmarking report for the following company.

COMPANY CONTEXT:
- Company: ${ctx.company_name}
- Industry: ${ctx.industry}
- Product: ${ctx.product_desc}
- Target Market: ${ctx.target_market}
- Stage: ${ctx.stage}
- Geography: ${ctx.geography}

Generate a detailed competitive analysis with this exact structure in Markdown:

# Competitor Benchmarking — ${ctx.company_name}

## Executive Summary
[2-3 sentences on the competitive landscape]

## Market Position
[Where ${ctx.company_name} sits relative to competitors]

## Top Competitors
| Competitor | Strengths | Weaknesses | Est. Market Share |
(List 4-5 realistic competitors for this industry and target market)

## Feature & Capability Gap Analysis
[Table comparing key features/capabilities]

## Competitive Advantages
[3 bullet points: what ${ctx.company_name} can win on]

## Competitive Threats
[3 bullet points: biggest threats to watch]

## Strategic Recommendations
1. [Specific, actionable recommendation]
2. [Specific, actionable recommendation]
3. [Specific, actionable recommendation]

## Key Metrics to Track
- [Metric 1]
- [Metric 2]
- [Metric 3]

## Suggested Production Tasks
- [ ] Research top 3 competitor pricing pages
- [ ] Conduct 5 win/loss interviews
- [ ] Set up competitor monitoring alerts
`,

  tam: (ctx) => `
You are a market analyst. Generate a TAM/SAM/SOM analysis for this company.

COMPANY CONTEXT:
- Company: ${ctx.company_name}
- Industry: ${ctx.industry}
- Product: ${ctx.product_desc}
- Target Market: ${ctx.target_market}
- Stage: ${ctx.stage}
- Geography: ${ctx.geography}
- Revenue Range: ${ctx.revenue_range || "early stage"}

Generate a detailed market sizing analysis:

# TAM/SAM/SOM Analysis — ${ctx.company_name}

## Executive Summary
[Market opportunity overview]

## Total Addressable Market (TAM)
- **Market Size:** $X billion globally
- **Methodology:** [How calculated]
- **Growth Rate:** X% CAGR
- **Key Drivers:** [2-3 drivers]

## Serviceable Addressable Market (SAM)
- **Market Size:** $X billion
- **Geographic Focus:** ${ctx.geography || "Target region"}
- **Segment Focus:** ${ctx.target_market}
- **Rationale:** [Why this is the realistic slice]

## Serviceable Obtainable Market (SOM)
- **3-Year Target:** $X million
- **Market Share Target:** X%
- **Revenue Implication:** $X ARR potential
- **Key Assumptions:** [Assumptions made]

## Market Segments
| Segment | Size | Fit | Priority |
(List 4-5 segments)

## Growth Trajectory
- Year 1: $X
- Year 2: $X
- Year 3: $X

## Go-to-Market Implications
[How market size shapes GTM approach]

## Key Risks & Mitigants
1. [Risk + mitigation]
2. [Risk + mitigation]

## Suggested Production Tasks
- [ ] Validate SAM assumptions with 10 customer interviews
- [ ] Model 3 revenue scenarios in a spreadsheet
- [ ] Identify top 2 segments to target first
`,

  growth: (ctx) => `
You are a growth strategy consultant. Generate a comprehensive growth forecast for this company.

COMPANY CONTEXT:
- Company: ${ctx.company_name}
- Industry: ${ctx.industry}
- Product: ${ctx.product_desc}
- Stage: ${ctx.stage}
- Revenue: ${ctx.revenue_range || "early stage"}
- Challenge: ${ctx.challenge}

Generate a growth forecasting document:

# Growth Forecasting — ${ctx.company_name}

## Executive Summary
[Current trajectory and growth opportunity]

## Current Baseline
- Revenue Stage: ${ctx.revenue_range || "Early"}
- Primary Growth Challenge: ${ctx.challenge}
- Key Growth Levers Available: [List 3]

## 3 Scenarios — 12 Month Projection

### Conservative (Base Case)
| Month | MRR | Growth Driver |
(Show 3-month intervals: M3, M6, M9, M12)
- **Key Assumption:** [Main assumption]
- **Required Actions:** [2 actions]

### Moderate (Target Case)
| Month | MRR | Growth Driver |
- **Key Assumption:** [Main assumption]
- **Required Actions:** [2 actions]

### Aggressive (Upside Case)
| Month | MRR | Growth Driver |
- **Key Assumption:** [Main assumption]
- **Required Actions:** [2 actions]

## Growth Levers Ranked by Impact
1. **[Lever]** — Est. impact: +X% MoM growth
2. **[Lever]** — Est. impact: +X% MoM growth
3. **[Lever]** — Est. impact: +X% MoM growth

## Unit Economics Targets
- CAC Target: $X
- LTV Target: $X
- LTV:CAC Ratio: X:1
- Payback Period: X months

## 90-Day Growth Sprint Plan
Week 1-4: [Focus]
Week 5-8: [Focus]
Week 9-12: [Focus]

## Suggested Production Tasks
- [ ] Define and instrument 3 North Star metrics
- [ ] Run 2 acquisition channel experiments
- [ ] Set up weekly growth review cadence
`,

  gtm: (ctx) => `
You are a go-to-market strategist. Generate a comprehensive GTM strategy.

COMPANY CONTEXT:
- Company: ${ctx.company_name}
- Industry: ${ctx.industry}
- Product: ${ctx.product_desc}
- Target Market: ${ctx.target_market}
- Stage: ${ctx.stage}
- Geography: ${ctx.geography}

Generate a GTM strategy document:

# Go-to-Market Strategy — ${ctx.company_name}

## Executive Summary
[GTM approach and rationale]

## Ideal Customer Profile (ICP)
- **Company Profile:** [Size, industry, tech stack, etc.]
- **Decision Maker:** [Title, responsibilities]
- **Pain Points:** [Top 3 specific pains]
- **Success Metrics:** [What they measure]
- **Buying Triggers:** [What prompts them to buy now]

## Value Proposition
**Headline:** [One sentence value prop]
**Supporting Points:**
1. [Benefit 1 with proof point]
2. [Benefit 2 with proof point]
3. [Benefit 3 with proof point]

## Channel Strategy
| Channel | Priority | CAC Est. | Timeline |
(List 4-5 channels: content, paid, outbound, partnerships, PLG, etc.)

## Messaging Framework
- **Awareness:** [Message for cold audience]
- **Consideration:** [Message for evaluating audience]
- **Decision:** [Message to close]

## Sales Motion
[Self-serve PLG / Sales-assisted / Enterprise sales - which and why]

## Launch Plan — 90 Days
Phase 1 (Days 1-30): [Focus]
Phase 2 (Days 31-60): [Focus]
Phase 3 (Days 61-90): [Focus]

## KPIs & Success Metrics
- Pipeline: [Target]
- Conversion Rate: [Target]
- CAC: [Target]
- Time to First Revenue: [Target]

## Suggested Production Tasks
- [ ] Write ICP one-pager and get team alignment
- [ ] Build outbound sequence for top 100 accounts
- [ ] Launch content calendar for top 2 channels
`,

  roadmap: (ctx) => `
You are a product strategist. Generate a product roadmap framework.

COMPANY CONTEXT:
- Company: ${ctx.company_name}
- Industry: ${ctx.industry}
- Product: ${ctx.product_desc}
- Stage: ${ctx.stage}
- Challenge: ${ctx.challenge}

Generate a product roadmap document:

# Product Roadmap — ${ctx.company_name}

## Executive Summary
[Product direction and prioritization approach]

## Strategic Themes (Next 12 Months)
1. **[Theme]:** [Why this theme matters now]
2. **[Theme]:** [Why this theme matters now]
3. **[Theme]:** [Why this theme matters now]

## Now (Q1) — Must-Have
| Feature | Impact | Effort | Owner |
(List 4-6 items, score Impact/Effort: H/M/L)

## Next (Q2) — Should-Have
| Feature | Impact | Effort | Owner |
(List 4-6 items)

## Later (Q3-Q4) — Nice-to-Have
| Feature | Impact | Effort | Owner |
(List 4-6 items)

## Prioritization Framework
**Impact/Effort Matrix:**
- **Quick Wins** (High Impact, Low Effort): [List]
- **Big Bets** (High Impact, High Effort): [List]
- **Fill-ins** (Low Impact, Low Effort): [List]
- **Avoid** (Low Impact, High Effort): [List]

## Success Metrics per Theme
[How to measure progress on each strategic theme]

## Risks & Dependencies
1. [Risk + mitigation]
2. [Dependency + plan]

## Suggested Production Tasks
- [ ] Run customer discovery for Q2 features (5 interviews)
- [ ] Create technical spec for top Q1 item
- [ ] Set up weekly product review meeting
`,

  fundraising: (ctx) => `
You are a venture capital advisor. Generate a fundraising narrative framework.

COMPANY CONTEXT:
- Company: ${ctx.company_name}
- Industry: ${ctx.industry}
- Product: ${ctx.product_desc}
- Target Market: ${ctx.target_market}
- Stage: ${ctx.stage}
- Revenue: ${ctx.revenue_range || "early"}

Generate a fundraising narrative:

# Fundraising Narrative — ${ctx.company_name}

## Executive Summary
[The single most compelling sentence about this company]

## The Problem
[3-4 sentences: who has this problem, why it's painful, what the cost is]

## The Solution
[How ${ctx.company_name} solves it uniquely]

## Why Now?
[Market timing: technology shift, regulatory change, behavioral change]

## Traction & Proof Points
- Revenue: ${ctx.revenue_range || "Pre-revenue"}
- Key Metrics: [Fill with realistic early-stage metrics]
- Customer Proof: [Type of customers, key testimonials structure]

## Market Opportunity
[TAM/SAM summary — tie to the market analysis]

## Business Model
[How you make money, unit economics, path to profitability]

## Competitive Advantage (Moats)
1. [Moat 1: technology/data/network/brand]
2. [Moat 2]
3. [Moat 3]

## Team
[What makes this team uniquely positioned to win]

## The Ask
- **Round Size:** $X
- **Use of Funds:** [% breakdown: product, sales, ops]
- **Milestones This Unlocks:** [What $X gets you to]
- **Target Investors:** [Stage, sector, geography]

## Suggested Production Tasks
- [ ] Build financial model (3-year P&L)
- [ ] Create 10-slide pitch deck
- [ ] List 50 target investors and warm intro paths
`,
};

export function buildBusinessContext(
  profile: Partial<BusinessContext> | null,
  custom?: Partial<BusinessContext>
): BusinessContext {
  return {
    company_name: custom?.company_name || profile?.company_name || "Your Company",
    industry: custom?.industry || profile?.industry || "Technology",
    product_desc: custom?.product_desc || profile?.product_desc || "",
    target_market: custom?.target_market || profile?.target_market || "",
    stage: custom?.stage || profile?.stage || "early",
    geography: custom?.geography || profile?.geography || "Global",
    challenge: custom?.challenge || profile?.challenge || "",
    revenue_range: custom?.revenue_range || profile?.revenue_range || "",
  };
}

export function getStrategyPrompt(type: string, ctx: BusinessContext): string {
  const fn = STRATEGY_PROMPTS[type as StrategyType] ?? STRATEGY_PROMPTS.growth;
  return fn(ctx);
}

/** Extract checkbox tasks from "## Suggested Production Tasks" section. */
export function parseProductionTasks(content: string): string[] {
  const match = content.match(/## Suggested Production Tasks[\s\S]*/i);
  if (!match) return [];

  const lines = match[0].split("\n").slice(1);
  const tasks: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    const taskMatch = trimmed.match(/^[-*]\s*\[[ xX]?\]\s*(.+)$/);
    if (taskMatch) {
      tasks.push(taskMatch[1].trim());
      continue;
    }
    if (trimmed.startsWith("- ") && !trimmed.startsWith("- [")) {
      tasks.push(trimmed.slice(2).trim());
    }
    if (tasks.length >= 10) break;
  }

  return tasks.filter(Boolean);
}

export function defaultTitle(type: StrategyType, companyName: string): string {
  const label = STRATEGY_TYPES.find(t => t.type === type)?.label ?? "Strategy";
  return `${companyName} — ${label}`;
}
