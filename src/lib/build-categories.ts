// Category-driven build flow. Each category has its own intake questions,
// themes, and curated top-features. The LLM specializes the curated features
// to the user's specific niche at suggest time.

export type IntakeField = {
  id: string;
  label: string;
  type: "text" | "textarea" | "chips" | "multichips" | "file";
  placeholder?: string;
  options?: string[];
  hint?: string;
  optional?: boolean;
  accept?: string; // for file
};

export type Theme = {
  id: string;
  label: string;
  brief: string; // injected into the generation prompt
  swatch: string; // tailwind gradient classes (legacy; not relied on)
  /** Explicit hex palette: [primary, secondary, background]. Rendered as the card preview + dot row. */
  colors: [string, string, string];
  fonts?: string; // optional font hint
};

export type CuratedFeature = {
  title: string;
  why: string;
};

export type Category = {
  id: string;
  label: string;
  emoji: string;
  hint: string;
  /** Singular noun used in headlines, e.g. "trailer-manufacturing site" */
  niche: string;
  intake: IntakeField[];
  themes: Theme[];
  topFeatures: CuratedFeature[];
  /** Whether the resume-upload step is offered. */
  supportsResume?: boolean;
};

const CONTACT_OPTIONS = [
  "Phone call",
  "Text message",
  "Email",
  "Contact form",
  "Online booking",
  "WhatsApp",
];

export const CATEGORIES: Category[] = [
  {
    id: "small-business",
    label: "Small business",
    emoji: "🏪",
    hint: "Trades, services, local shops",
    niche: "small business",
    intake: [
      {
        id: "businessName",
        label: "Business name",
        type: "text",
        placeholder: "e.g. Phoenix Family Trailers",
      },
      {
        id: "goal",
        label: "What does the business do?",
        type: "textarea",
        placeholder:
          "e.g. We manufacture custom utility trailers in Phoenix, AZ. Family-owned since 1998. Sell direct to contractors and ranchers.",
        hint: "Be specific about the niche — this is what we'll research.",
      },
      {
        id: "location",
        label: "Where are you based?",
        type: "text",
        placeholder: "City, region, or 'online only'",
      },
      {
        id: "services",
        label: "Main services or products",
        type: "textarea",
        placeholder: "List 3–6 things customers buy from you, one per line.",
      },
      {
        id: "yearsInBusiness",
        label: "Years in business",
        type: "chips",
        options: ["Just starting", "1–3 years", "3–10 years", "10+ years"],
        optional: true,
      },
      {
        id: "contact",
        label: "How can customers reach you?",
        type: "multichips",
        options: CONTACT_OPTIONS,
      },
    ],
    themes: [
      {
        id: "trustworthy-local",
        label: "Trustworthy Local",
        brief:
          "Warm, professional tone. Earth tones (deep blue or forest green primary, cream background). Real photo-style hero with strong USP. Trust badges row, big phone CTA in header.",
        swatch: "from-emerald-600 to-teal-700",
      },
      {
        id: "bold-confident",
        label: "Bold & Confident",
        brief:
          "Strong primary color (red, orange, or navy), big bold headline (clamp(3rem,6vw,5rem)), oversized CTA button. Industrial / no-nonsense feel.",
        swatch: "from-orange-500 to-red-600",
      },
      {
        id: "family-warm",
        label: "Family & Warm",
        brief:
          "Cream background, hand-drawn-feel SVG accents, amber or burgundy primary. Story-led hero ('Three generations of...'), testimonial-heavy, soft serif headings.",
        swatch: "from-amber-400 to-rose-500",
      },
      {
        id: "modern-minimal",
        label: "Modern & Minimal",
        brief:
          "Clean white/near-white. Single accent color. Grid-based layout. Sans-serif everything. Subtle micro-animations on scroll.",
        swatch: "from-slate-600 to-slate-900",
      },
    ],
    topFeatures: [
      { title: "Hero with phone CTA pinned in header", why: "Top local businesses make calling unmissable on every scroll." },
      { title: "Service grid with starting prices", why: "Transparent pricing reduces friction and builds trust." },
      { title: "Service-area map", why: "Shows the radius you cover so visitors know if you serve them." },
      { title: "Customer testimonials with names + photos", why: "Specific, human reviews convert far better than star averages." },
      { title: "Before/after photo gallery", why: "Trade and service businesses live and die on visual proof." },
      { title: "FAQ accordion answering pricing & timing", why: "Cuts the most common 'are they right for me?' questions." },
      { title: "Trust badges row (years, licenses, BBB, insured)", why: "Top sites surface credentials within the first scroll." },
      { title: "'Get a quote' multi-step form", why: "Higher completion than one big form, gets richer leads." },
      { title: "Sticky 'Call now' bar on mobile", why: "Mobile is 60%+ of traffic for local — this doubles call-throughs." },
      { title: "Recent jobs / case studies section", why: "Concrete recent work beats generic claims of experience." },
      { title: "Service-area towns/zip list", why: "SEO win — visitors find you by typing 'X near me'." },
      { title: "Owner bio with photo", why: "Local trust comes from a face, not a logo." },
      { title: "Schema.org LocalBusiness microdata", why: "Wins Google's local pack and rich results." },
      { title: "Hours + holiday closures block", why: "Reduces 'are they open?' calls and bounce rate." },
      { title: "Emergency / after-hours contact line", why: "Makes you the obvious choice for urgent jobs." },
    ],
  },
  {
    id: "ecommerce",
    label: "E-commerce",
    emoji: "🛒",
    hint: "Sell products online",
    niche: "online store",
    intake: [
      {
        id: "businessName",
        label: "Store name",
        type: "text",
        placeholder: "e.g. Lumen Candle Co.",
      },
      {
        id: "goal",
        label: "What do you sell?",
        type: "textarea",
        placeholder:
          "e.g. Hand-poured soy candles in small-batch scents inspired by hiking trails. Direct-to-consumer, ship anywhere in the US.",
      },
      {
        id: "productCount",
        label: "How many products?",
        type: "chips",
        options: ["1–10", "11–50", "50–200", "200+"],
      },
      {
        id: "audience",
        label: "Who buys from you?",
        type: "chips",
        options: ["Direct-to-consumer", "Wholesale / B2B", "Both"],
      },
      {
        id: "shippingScope",
        label: "Where do you ship?",
        type: "chips",
        options: ["Local only", "Country-wide", "Global"],
      },
      {
        id: "priceRange",
        label: "Typical price point",
        type: "chips",
        options: ["Budget ($)", "Mid-range ($$)", "Premium ($$$)", "Luxury ($$$$)"],
        optional: true,
      },
      {
        id: "contact",
        label: "How can customers reach support?",
        type: "multichips",
        options: CONTACT_OPTIONS,
      },
    ],
    themes: [
      {
        id: "bold-catalog",
        label: "Bold Catalog",
        brief:
          "Saturated brand color, oversized product imagery, big SHOP NOW CTAs, dense featured-product grid. Drop-shipping / fashion energy.",
        swatch: "from-fuchsia-500 to-pink-600",
      },
      {
        id: "editorial-boutique",
        label: "Editorial Boutique",
        brief:
          "Magazine-feel. Large serif display headings, tons of whitespace, ultra-clean cream/off-white background. Premium boutique aesthetic.",
        swatch: "from-stone-300 to-stone-700",
        fonts: "serif display (Playfair / Cormorant) + clean sans body",
      },
      {
        id: "flash-sale",
        label: "Flash-Sale Energy",
        brief:
          "Bright accent (yellow/red), countdown timer in hero, badge-heavy ('NEW', 'BESTSELLER'), urgency copy, full-bleed sale strip across the top.",
        swatch: "from-yellow-400 to-orange-500",
      },
      {
        id: "calm-premium",
        label: "Calm Premium",
        brief:
          "Muted earth palette (clay, sage, bone). Generous whitespace, slow scroll-reveals, large product photography that breathes. Apple/Aesop feel.",
        swatch: "from-stone-500 to-emerald-700",
      },
    ],
    topFeatures: [
      { title: "Hero product carousel with one-click CTA", why: "Top stores let you start shopping within 1 second of landing." },
      { title: "Featured collections grid", why: "Surfaces curated bundles ('Gifts under $50', 'New arrivals')." },
      { title: "Bestsellers row with social proof", why: "'#1 bestseller' tags lift conversion measurably." },
      { title: "Customer review cards with photos", why: "User-generated photos sell harder than studio shots." },
      { title: "Free-shipping threshold bar", why: "Pushes average order value up by ~10–15% on most stores." },
      { title: "Sticky 'add to cart' on product detail", why: "Removes scroll-to-buy friction on long product pages." },
      { title: "Size / variant selector with stock state", why: "Tells the buyer instantly if their size is available." },
      { title: "Trust strip (returns, secure, ships fast)", why: "Cuts checkout abandonment from new shoppers." },
      { title: "Press / featured-in logo row", why: "Borrowed credibility from publications you've appeared in." },
      { title: "Email capture with first-purchase discount", why: "Best-in-class first-touch list-building tactic." },
      { title: "Instagram-feed style lifestyle gallery", why: "Shows products in real life — what UGC-driven brands win on." },
      { title: "FAQ for shipping, returns, sizing", why: "Pre-empts the questions that kill 30% of carts." },
      { title: "About / brand story section", why: "Modern shoppers buy from brands they understand, not catalogs." },
      { title: "Footer mega-menu with category deep links", why: "SEO win plus discoverability for niche product lines." },
      { title: "Live chat / WhatsApp button", why: "Premium and DTC stores all use real-time help to close sales." },
    ],
  },
  {
    id: "saas",
    label: "SaaS / tech product",
    emoji: "💻",
    hint: "Software, apps, startups",
    niche: "SaaS product",
    intake: [
      {
        id: "businessName",
        label: "Product name",
        type: "text",
        placeholder: "e.g. Linear, Notion, Stripe",
      },
      {
        id: "goal",
        label: "What does it do? (one sentence)",
        type: "textarea",
        placeholder:
          "e.g. The fastest way for engineering teams to plan and ship software, replacing Jira.",
      },
      {
        id: "targetUser",
        label: "Who's it for?",
        type: "chips",
        options: [
          "Developers",
          "Designers",
          "Marketers",
          "Sales teams",
          "SMB owners",
          "Enterprises",
          "Consumers",
        ],
      },
      {
        id: "pricingModel",
        label: "Pricing model",
        type: "chips",
        options: ["Free", "Freemium", "Subscription", "One-time", "Usage-based"],
      },
      {
        id: "mainCTA",
        label: "Main call-to-action",
        type: "chips",
        options: ["Sign up free", "Start trial", "Book a demo", "Join waitlist", "Download"],
      },
      {
        id: "contact",
        label: "How can users reach support?",
        type: "multichips",
        options: ["Email", "Live chat", "Contact form", "Slack community", "Docs / help center"],
      },
    ],
    themes: [
      {
        id: "linear-dark",
        label: "Linear-style Dark",
        brief:
          "Pure dark background (#08090a), thin neutral borders, indigo/violet accent gradient on CTA, monospaced labels, blurred glow behind hero, ultra-tight letter-spacing on headlines.",
        swatch: "from-indigo-500 to-violet-700",
      },
      {
        id: "stripe-gradient",
        label: "Stripe Gradient",
        brief:
          "Iridescent multi-stop gradient hero (purple→blue→teal), white card-grid sections below, small badge labels above each section, generous spacing.",
        swatch: "from-blue-500 via-violet-500 to-pink-500",
      },
      {
        id: "notion-soft",
        label: "Notion Soft",
        brief:
          "Off-white background, friendly emoji-led sections, hand-drawn-feel SVG illustrations, soft grays and a single accent color, chunky rounded buttons.",
        swatch: "from-stone-300 to-zinc-500",
      },
      {
        id: "apple-hero",
        label: "Apple Hero",
        brief:
          "Massive headline (clamp(3rem,7vw,6rem)), white background, tiny subhead, single product image / SVG centered. Section transitions are full-bleed color blocks.",
        swatch: "from-zinc-100 to-zinc-700",
      },
    ],
    topFeatures: [
      { title: "Hero with one-line value prop + product screenshot", why: "Every category-leading SaaS opens with what + a visual in <2s." },
      { title: "'Trusted by' logo wall (customers / press)", why: "Logos are the fastest credibility signal a B2B buyer sees." },
      { title: "Feature trio with icons", why: "Three benefit cards anchor the 'how it works' story." },
      { title: "Animated product preview (loop video / Lottie)", why: "Shows the actual product in motion — crushes static screenshots." },
      { title: "Comparison table vs. competitors", why: "Buyers actively look for this — owning the comparison wins." },
      { title: "Pricing tiers with 'Most popular' highlight", why: "Anchors decision-making toward the recommended plan." },
      { title: "Customer testimonials with name/role/company", why: "Specific job titles beat anonymous quotes for B2B." },
      { title: "ROI / outcome stats row ('saves 8hrs/week')", why: "Quantified outcomes are what drive buy-in conversations." },
      { title: "Integrations grid", why: "Buyers check 'does it work with our stack' early." },
      { title: "Security & compliance badges (SOC2, GDPR)", why: "Mid-market and up filter on this before they even demo." },
      { title: "FAQ targeting buyer objections", why: "Best PMs build FAQs from real sales-call objections." },
      { title: "Final CTA section with no nav", why: "Removing distractions on the closer lifts trial signups." },
      { title: "Docs / changelog link in footer", why: "Signals an active, credible engineering team." },
      { title: "Newsletter / product-updates signup", why: "Owns the relationship even when they don't convert today." },
      { title: "Status page link in footer", why: "Tiny detail that says 'we're an adult-grade product'." },
    ],
  },
  {
    id: "portfolio",
    label: "Portfolio / artist",
    emoji: "🎨",
    hint: "Creators, freelancers, designers",
    niche: "portfolio",
    supportsResume: true,
    intake: [
      {
        id: "businessName",
        label: "Your name",
        type: "text",
        placeholder: "e.g. Maya Patel",
      },
      {
        id: "role",
        label: "What do you do?",
        type: "chips",
        options: [
          "Designer",
          "Developer",
          "Photographer",
          "Writer",
          "Illustrator",
          "Filmmaker",
          "Architect",
          "Musician",
          "Other",
        ],
      },
      {
        id: "goal",
        label: "Short bio",
        type: "textarea",
        placeholder:
          "e.g. Brand designer based in Lisbon, working with food and hospitality startups since 2018. Available for new projects.",
        hint: "Or upload your resume below and I'll write this for you.",
      },
      {
        id: "resume",
        label: "Upload resume (PDF) — optional",
        type: "file",
        accept: "application/pdf",
        optional: true,
        hint: "I'll extract your skills, projects, and recommend themes that fit you.",
      },
      {
        id: "featuredProjects",
        label: "Notable projects (optional)",
        type: "textarea",
        placeholder:
          "Up to 6, one per line. e.g. 'Brand identity for Aether Coffee — 2024'.",
        optional: true,
      },
      {
        id: "contact",
        label: "How can people reach you?",
        type: "multichips",
        options: ["Email", "Contact form", "LinkedIn", "Twitter / X", "Instagram", "Behance", "Dribbble"],
      },
    ],
    themes: [
      {
        id: "big-type-awwwards",
        label: "Big-Type Awwwards",
        brief:
          "Massive editorial display type as the hero (single name across the screen). Cursor-led interactions, monochrome with one accent color, project grid with hover-reveals.",
        swatch: "from-zinc-900 to-zinc-700",
        fonts: "tight display sans (e.g. Inter Tight, Sohne) at 12rem+",
      },
      {
        id: "editorial-magazine",
        label: "Editorial Magazine",
        brief:
          "Serif headlines, two-column body copy, drop-caps on bio, large numbered project list, cream paper background. Long-form-friendly.",
        swatch: "from-amber-200 to-stone-600",
        fonts: "serif (Playfair, Tiempos) headings + serif body",
      },
      {
        id: "minimal-grid",
        label: "Minimal Grid",
        brief:
          "Pure white, thin grid lines, monospaced project labels, 3-column project grid, no animations, ultimate restraint. Designer-favorite.",
        swatch: "from-white to-zinc-300",
        fonts: "geometric sans + monospaced labels",
      },
      {
        id: "cinematic-dark",
        label: "Cinematic Dark",
        brief:
          "Black background, fullscreen project covers, autoplaying muted video hero, very thin sans-serif type, white-on-black throughout. Filmmaker / photographer favorite.",
        swatch: "from-black to-zinc-700",
      },
      {
        id: "playful-color",
        label: "Playful Color",
        brief:
          "Bright unexpected color combos (acid green + magenta), wobbly-rotated SVG shapes in the background, oversized rounded buttons, friendly imperfect feel.",
        swatch: "from-lime-400 to-pink-500",
      },
    ],
    topFeatures: [
      { title: "Big-type hero with name + role", why: "Award-winning portfolios open with identity, not navigation." },
      { title: "Featured projects grid (3 large cards)", why: "Lead with your strongest work, not a wall of thumbnails." },
      { title: "Case-study layout for one signature project", why: "Hiring managers want depth on one piece more than breadth." },
      { title: "About section with portrait photo", why: "Personal sites without a face feel like agencies in disguise." },
      { title: "Selected client logo wall", why: "Quick credibility signal even before clicking a project." },
      { title: "Press / awards / publications strip", why: "External validation buys you trust before any project loads." },
      { title: "Services / 'what I do' list", why: "Tells inbound clients whether to write to you in the first place." },
      { title: "Testimonials from clients or collaborators", why: "Quotes from named people convert leads dramatically more." },
      { title: "Process / how-I-work section", why: "Removes the 'is this person a pro?' uncertainty for first-time buyers." },
      { title: "Inline CV / resume timeline", why: "Recruiters skim for years/companies — make it scannable." },
      { title: "'Currently' / now block", why: "Hot-rising portfolio convention; signals you're active and reachable." },
      { title: "Contact CTA with email + booking link", why: "One-click contact beats a 5-field form for portfolio leads." },
      { title: "Project archive / index page", why: "Lets the curious go deep without cluttering the home page." },
      { title: "Social proof: follower counts / talks given", why: "Numbers around audience signal authority in the field." },
      { title: "Newsletter / 'get my next drop' signup", why: "Lets visitors who can't hire today stay in your orbit." },
    ],
  },
  {
    id: "event",
    label: "Event / community",
    emoji: "🎉",
    hint: "Weddings, conferences, meetups",
    niche: "event",
    intake: [
      {
        id: "businessName",
        label: "Event or community name",
        type: "text",
        placeholder: "e.g. Build Conf 2026",
      },
      {
        id: "eventType",
        label: "What kind of event?",
        type: "chips",
        options: [
          "Conference",
          "Wedding",
          "Meetup / community",
          "Workshop / class",
          "Festival",
          "Webinar",
          "Concert",
          "Fundraiser",
          "Other",
        ],
      },
      {
        id: "goal",
        label: "What's it about?",
        type: "textarea",
        placeholder:
          "e.g. A 2-day conference for indie makers shipping AI products. 30 speakers, single track, 600 attendees in Lisbon.",
      },
      {
        id: "when",
        label: "When?",
        type: "text",
        placeholder: "e.g. June 12–13, 2026 — or 'every Thursday'",
      },
      {
        id: "where",
        label: "Where?",
        type: "text",
        placeholder: "Venue, city — or 'online'",
      },
      {
        id: "ticketing",
        label: "Ticketing",
        type: "chips",
        options: ["Free", "Paid", "Invite only", "RSVP only"],
      },
      {
        id: "contact",
        label: "How can people reach the organizers?",
        type: "multichips",
        options: ["Email", "Contact form", "Discord", "Twitter / X", "Instagram"],
      },
    ],
    themes: [
      {
        id: "conference-bold",
        label: "Conference Bold",
        brief:
          "Tight grid, oversized date hero, speaker portrait grid, schedule timeline, bright-on-black sponsor logos. Clarity > decoration.",
        swatch: "from-blue-600 to-indigo-700",
      },
      {
        id: "wedding-elegant",
        label: "Wedding Elegant",
        brief:
          "Soft cream + blush palette, romantic serif display, hand-drawn floral SVG accents, generous whitespace, RSVP form as the closer.",
        swatch: "from-rose-200 to-rose-500",
        fonts: "elegant serif (Cormorant, Playfair)",
      },
      {
        id: "festival-vibrant",
        label: "Festival Vibrant",
        brief:
          "High-saturation gradient hero, big lineup-poster-style typography, sticker-style badges, animated marquee strip with dates/cities.",
        swatch: "from-violet-500 via-orange-400 to-yellow-300",
      },
      {
        id: "meetup-friendly",
        label: "Meetup Friendly",
        brief:
          "Approachable casual tone, soft pastel background, big 'Join the next one' CTA, recent-events recap section, friendly emoji headers.",
        swatch: "from-teal-300 to-sky-500",
      },
    ],
    topFeatures: [
      { title: "Hero with event name + dates + location", why: "The three things every visitor checks first — surface them instantly." },
      { title: "Countdown timer to event start", why: "Drives urgency for last-minute ticket buyers." },
      { title: "Speaker / lineup grid with portraits", why: "Names + faces are the #1 reason people forward an event link." },
      { title: "Day-by-day schedule timeline", why: "Lets attendees imagine themselves there before buying." },
      { title: "Ticketing tiers with 'sold out' state", why: "Scarcity signals work — show what's left, mark what's gone." },
      { title: "Past-event highlight reel / photo grid", why: "If this isn't the first one, visual proof closes the doubt." },
      { title: "FAQ for travel, refunds, dress code", why: "Reduces the support email pile organizers wake up to." },
      { title: "Sponsor / partner logo wall", why: "Sponsors want visibility; attendees infer legitimacy from logos." },
      { title: "Venue map + travel info block", why: "Pragmatic detail that converts 'maybe' into 'booked'." },
      { title: "Email signup for next-event waitlist", why: "Even people who can't make this one are valuable for the next." },
      { title: "Code-of-conduct link in footer", why: "Modern community events are expected to publish one." },
      { title: "Press / coverage strip", why: "Borrowed credibility, especially for 2nd-edition events." },
      { title: "Sticky 'Get tickets' bar on mobile", why: "Mobile RSVP-rate climbs significantly with persistent CTA." },
      { title: "Testimonials / quotes from past attendees", why: "Word-of-mouth proof that the event is worth the trip." },
      { title: "Social-share preview meta with poster image", why: "Events spread on group chats — make the link unfurl beautifully." },
    ],
  },
  {
    id: "other",
    label: "Something else",
    emoji: "✨",
    hint: "I'll describe it",
    niche: "site",
    intake: [
      {
        id: "businessName",
        label: "Site name (or your name)",
        type: "text",
        placeholder: "Anything you'd like",
      },
      {
        id: "goal",
        label: "What is this site for?",
        type: "textarea",
        placeholder:
          "Describe it like you'd describe it to a friend. The more specific, the better.",
      },
      {
        id: "contact",
        label: "How can visitors reach you?",
        type: "multichips",
        options: CONTACT_OPTIONS,
      },
    ],
    themes: [
      {
        id: "modern",
        label: "Modern",
        brief: "Clean, modern sans-serif, neutral palette, single accent color, generous whitespace.",
        swatch: "from-slate-700 to-slate-900",
      },
      {
        id: "warm",
        label: "Warm",
        brief: "Warm amber/orange palette, friendly serif, soft backgrounds.",
        swatch: "from-amber-400 to-orange-500",
      },
      {
        id: "playful",
        label: "Playful",
        brief: "Bright color combos, rounded shapes, casual tone, soft animations.",
        swatch: "from-pink-400 to-purple-500",
      },
      {
        id: "professional",
        label: "Professional",
        brief: "Deep blue/navy, conservative type, structured grid layout.",
        swatch: "from-blue-700 to-indigo-700",
      },
    ],
    topFeatures: [
      { title: "Hero with clear value statement", why: "Visitors decide in <2s whether to keep scrolling." },
      { title: "About / who-we-are section", why: "Context turns strangers into trusters." },
      { title: "What we do / services list", why: "Tells visitors whether they're in the right place." },
      { title: "Testimonials / proof", why: "Social proof outperforms self-claims at every stage." },
      { title: "FAQ accordion", why: "Pre-empts the questions that cause bounces." },
      { title: "Email newsletter signup", why: "Owns the relationship past today's visit." },
      { title: "Contact form with named fields", why: "Lower friction than email-only contact." },
      { title: "Footer with full sitemap", why: "SEO + trust signal." },
    ],
  },
];

export function getCategory(id: string): Category | undefined {
  return CATEGORIES.find((c) => c.id === id);
}

export function getTheme(categoryId: string, themeId: string): Theme | undefined {
  return getCategory(categoryId)?.themes.find((t) => t.id === themeId);
}
