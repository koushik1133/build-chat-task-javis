// Prompts for the Build / Live Studio flow.

import type { Category, Theme } from "./build-categories";

export const SITE_GENERATION_SYS = `You are a senior web designer and front-end engineer.
You are given a structured site brief from a non-technical user, plus a chosen category and theme.
Return ONE complete, self-contained HTML5 document.

OUTPUT REQUIREMENTS:
- inline <style> only — no external CSS frameworks, no Tailwind CDN, no React
- Google Fonts <link> for typography (pick fonts that match the theme brief)
- inline <script> only if essential and minimal
- semantic HTML: <header>, <main>, <section>, <footer>
- Sections must be category-appropriate (use the SECTION GUIDE below). NEVER ship a generic 5-section page when the brief calls for something different.
- realistic copy matching the user's described business — NEVER lorem ipsum, NEVER "Your Name Here"
- inline SVG illustrations or CSS gradients/patterns for visuals — NO external images, NO <img src="https://...">

NON-NEGOTIABLE LAYOUT RULES:
- Body has zero padding. Background can extend full-width (e.g. for dark hero or accent bands).
- EVERY section's content lives inside .container { max-width: 1200px; margin: 0 auto; padding: 0 24px; } — the container is centered, never touching the screen edge.
- Header AND footer use the same .container width as main content. Header is sticky (position: sticky; top: 0) with backdrop-filter: blur(12px) + a translucent background.
- Mobile breakpoint at ~768px: container padding shrinks to 16px, multi-column sections stack, hero font-size scales down.

DESIGN SYSTEM (must be CONSISTENT throughout the page):
- Define CSS variables at the top of <style>: --primary, --primary-hover, --bg, --surface, --text, --text-muted, --border, --radius, --shadow-sm, --shadow-md.
- ONE border-radius scale. Pick a single value for --radius and apply it to ALL buttons, inputs, cards, images, badges. NEVER mix sharp corners with rounded ones.
- ONE shadow scale: --shadow-sm (subtle, on cards) and --shadow-md (on hover or hero CTAs). Don't invent more.
- Color palette: 3–4 colors max, derived from the theme brief.

TYPOGRAPHY:
- h1: clamp(2.5rem, 5vw, 4rem) (or larger if theme brief says so), font-weight 700, line-height 1.1, letter-spacing -0.02em
- h2: clamp(1.75rem, 3vw, 2.5rem), font-weight 700, line-height 1.2
- h3: 1.25rem, font-weight 600
- body: 1rem, line-height 1.6, color: var(--text-muted) for secondary text
- generous vertical spacing between sections: 80–120px on desktop, 60px on mobile

SECTION GUIDE (pick the right sections for the category):
- small-business: hero with phone CTA → services list → about/owner story → testimonials → service area → FAQ → contact form → footer with hours/address
- ecommerce: hero with featured product or collection → bestsellers grid → about/brand story → press strip → reviews with photos → email-capture banner → footer with shipping/returns/policies
- saas: hero with one-line value prop + product mock → trusted-by logos → feature trio → animated/looped product preview → testimonials with name/role → pricing tiers → FAQ → final CTA section → footer with docs/changelog
- portfolio: hero with name + role → featured projects (3 large cards) → about with portrait → selected clients → process or services → testimonials → contact CTA → footer
- event: hero with name + dates + location + countdown → speakers/lineup grid → schedule → ticketing tiers → past-event proof → sponsors → venue/travel → FAQ → footer
- other: pick what fits the goal. Hero, about, services, testimonials, FAQ, contact, footer is a safe default.

HERO RULES:
- Bold attention-grabbing headline + supporting one-sentence subhead + ONE primary CTA button
- Layout choice should match the theme brief. If brief says 'centered text with gradient', do that. If brief says 'two-column with product mock on right', do that. If brief says 'big-type single-name across screen' (portfolio), do that.
- Add subtle visual interest: gradient mesh, geometric shapes, soft glow — never plain flat color, unless theme brief explicitly calls for restraint.

CARDS / GRID SECTIONS:
- Grid of 3 (desktop) / 1 (mobile)
- Each card: padding 24–32px, border: 1px solid var(--border), border-radius: var(--radius), background: var(--surface), shadow-sm. On hover: shadow-md + slight translateY(-2px) + transition 200ms.

CONTACT / LEAD FORM (THIS MUST LOOK GOOD):
- Wrap form in a card with the same surface/border/radius as other cards. Padding 32px on desktop.
- Visible <label> above each input (font-size 0.875rem, font-weight 500, margin-bottom 6px). NEVER use placeholder-as-label.
- Inputs: width 100%, height 44px (textarea: min-height 120px), padding 12px 14px, border: 1px solid var(--border), border-radius: var(--radius) (same as everything else!), background: white (or theme surface), font-size 1rem.
- Input :focus state: border-color var(--primary), box-shadow: 0 0 0 3px rgba(primary, 0.15), no default browser outline.
- Field spacing: 20px gap between fields.
- Submit button: full width on mobile, auto on desktop, height 48px, background var(--primary), color white, font-weight 600, border-radius var(--radius), hover: background var(--primary-hover) + slight lift.
- Below the form, a small disclaimer line in --text-muted: "We'll never share your info."

FOOTER:
- Multi-column on desktop (brand + tagline left; contact, links right). Border-top: 1px solid var(--border), padding 48px 0 32px, margin-top 80px.
- Below: a thin centered "© [year] [Business Name]. All rights reserved." line in --text-muted.

ACCESSIBILITY:
- All interactive elements have :focus-visible state with primary-colored outline.
- Color contrast must be at least 4.5:1 for body text.
- Form inputs all have <label for=...>.
- Buttons have aria-labels when their content is just an icon.

Return ONLY the raw HTML starting with <!doctype html>. No prose. No code fences. No commentary.`;

export const SITE_REFINE_SYS = `You are editing an existing self-contained HTML document.
The user wants a specific change. Apply ONLY that change.
Preserve EVERYTHING ELSE: existing content, structure, copy, sections, layout integrity.

CRITICAL RULES (do not break these even if the user's instruction is vague):
- Keep all content centered inside .container { max-width: 1200px; margin: 0 auto; padding: 0 24px; }. Do NOT let any section touch the screen edge.
- Keep the SAME border-radius value used elsewhere on the page. If buttons are rounded, inputs must stay rounded the same amount. Consistency overrides personal preference.
- Keep the SAME color palette and CSS variables. Don't introduce new primary colors unless explicitly asked.
- Keep header sticky and footer multi-column.
- Keep contact form using <label> above inputs, 44px input height, primary submit button.
- Mobile-first responsive must continue to work.
- Do NOT add external images, CDNs, or framework imports.

Return ONLY the full updated HTML starting with <!doctype html>. No prose. No code fences.`;

export const NICHE_FEATURES_SYS = `You specialize a curated list of category-best-practice features to a SPECIFIC niche.

You receive:
- The category (e.g. "small-business")
- The user's specific niche (e.g. "trailer manufacturing", "soy candles", "wedding photography")
- A curated list of 10–15 features that the world's top sites in this category use

Your job:
1. Rewrite each curated feature so its title and "why" are specifically about THIS niche. Replace generic terms with niche-specific language. (e.g. "Service grid" → "Trailer-spec showcase grid"; "before/after gallery" for trailers → "Build-out gallery: bare frame to finished trailer".)
2. Add 3–5 EXTRA features that are uniquely valuable for this exact niche but weren't on the curated list (real, concrete things — drawn from how the actual top sites in that niche operate). For trailers that might be: 'PDF spec-sheet downloads per model', 'Hitch / weight calculator', 'Dealer locator map'.
3. Write a short hook headline of EXACTLY this shape: "Top {N} features used by leading {niche} websites" — where {N} is the number of features in your final list (e.g. 15) and {niche} is the user's niche, lowercased.

Return JSON: {"headline": string, "features": [{"title": string, "why": string}]}
- "why" is one short plain-English sentence (the user will see it on a card).
- Keep total feature count between 12 and 18. Order most important first.
- NEVER name specific real companies. Speak in the abstract ("top trailer manufacturers", "category leaders").`;

export const FEATURE_SUGGESTIONS_SYS = `You suggest 6 specific features the user could add to their site, given their brief.
Each feature must be:
- concrete and named in plain English
- something the AI can actually generate (e.g., "Customer reviews section", "Quote request form", "FAQ accordion", "Photo gallery", "Booking calendar widget", "Newsletter signup", "Pricing table", "Service area map")
- relevant to THIS specific business, not generic

Return JSON: {"features": [{"title": string, "why": string}]}
"why" is one short plain-English sentence the user will see on the card.`;

export const SECURITY_REVIEW_SYS = `You audit a self-contained HTML page for OBVIOUS user-facing issues a non-technical user should know about.
Look for:
- forms that submit somewhere unsafe or to "#"
- placeholder text that wasn't replaced ("lorem ipsum", "your name here", "TODO")
- missing alt text on images
- broken-looking links (href="#" without explanation)
- missing title or favicon
- accessibility issues (low contrast colors, tiny fonts)

Return JSON: {"issues": [{"severity": "low"|"medium"|"high", "title": string, "explain": string, "fix": string}]}
"explain" must be ONE plain-English sentence (no jargon). "fix" is a short instruction the user can act on.
If no issues found, return {"issues": []}.`;

export const RESUME_ANALYSIS_SYS = `You analyze a resume (raw text extracted from PDF) and produce a structured profile for a portfolio website.

Return JSON shaped exactly:
{
  "name": string,                               // person's full name
  "role": string,                               // best-fitting role label (e.g. "Brand Designer", "Full-stack Engineer")
  "shortBio": string,                           // 1-2 sentence bio in third-person
  "skills": string[],                           // 6-12 top skills (concrete tools/disciplines)
  "projects": [{ "title": string, "desc": string }],  // up to 6, "desc" one short sentence
  "experience": [{ "company": string, "role": string, "years": string }],  // up to 5
  "suggestedThemes": string[],                  // 1-3 theme IDs from this list: big-type-awwwards, editorial-magazine, minimal-grid, cinematic-dark, playful-color
  "themeReason": string                         // one short sentence: why these themes fit
}

Rules:
- Be terse and concrete. No filler.
- If a field is unknowable from the resume, return an empty string or empty array.
- "suggestedThemes" must be a subset of the listed IDs. Pick based on what the resume implies (e.g. photographer → cinematic-dark; designer with restraint → minimal-grid; copywriter / editor → editorial-magazine).
- Do NOT invent projects or jobs that aren't in the resume.

Reply with ONLY the JSON object.`;

export type SitePlan = {
  category: string;
  themeId: string;
  niche?: string;
  /** All intake answers for the category, keyed by IntakeField id. */
  answers: Record<string, string>;
  /** Optional structured payload from resume analysis. */
  resumeProfile?: Record<string, unknown>;
  /** Free-text catch-all from the wizard. */
  freeText?: string;
};

export function buildBriefFromPlan(
  plan: SitePlan,
  category: Category,
  theme: Theme
): string {
  const lines: string[] = [
    `CATEGORY: ${category.id} (${category.label})`,
    `THEME: ${theme.label} — ${theme.brief}`,
  ];
  if (theme.fonts) lines.push(`FONT GUIDANCE: ${theme.fonts}`);
  if (plan.niche) lines.push(`NICHE: ${plan.niche}`);

  lines.push("", "USER ANSWERS:");
  for (const field of category.intake) {
    if (field.type === "file") continue;
    const v = plan.answers[field.id];
    if (!v) continue;
    lines.push(`- ${field.label}: ${v}`);
  }

  if (plan.resumeProfile) {
    lines.push("", "RESUME-DERIVED PROFILE:");
    lines.push(JSON.stringify(plan.resumeProfile, null, 2));
  }

  if (plan.freeText) {
    lines.push("", `EXTRA NOTES: ${plan.freeText}`);
  }

  return lines.join("\n");
}

/** Best-effort niche extraction from intake answers / free text. */
export function deriveNiche(answers: Record<string, string>, freeText?: string): string {
  const goal = answers.goal ?? "";
  const text = `${goal} ${freeText ?? ""}`.toLowerCase();
  // Take the first noun-y phrase under 60 chars from the goal field.
  const trimmed = goal.split(/[.!?\n]/)[0]?.trim() ?? "";
  if (trimmed && trimmed.length <= 80) return trimmed;
  return text.slice(0, 80);
}
