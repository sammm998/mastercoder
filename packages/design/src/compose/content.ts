import { z } from "zod";
import { getModels, structured, type LLMProvider } from "@forge/llm";
import { briefTags, hashString } from "../curated.js";
import { DesignBriefSchema, type DesignBrief, type DesignBriefInput } from "../types.js";

const Link = z.object({ label: z.string().min(1), href: z.string().min(1) });

export const SiteContentSchema = z.object({
  /** Who wrote the copy: "llm" or "mock-copywriter (rule-based)". */
  generatedBy: z.string().default("llm"),
  meta: z.object({ title: z.string().min(1).max(70), description: z.string().min(1).max(170) }),
  brand: z.string().min(1),
  nav: z.array(Link).max(6).default([]),
  hero: z.object({
    eyebrow: z.string(),
    headline: z.string().min(1),
    /** A word or phrase of the headline to emphasise (italic accent). */
    emphasis: z.string().optional(),
    lede: z.string(),
    primaryCta: Link,
    secondaryCta: Link.optional(),
  }),
  statement: z.object({ text: z.string().min(1), emphasis: z.array(z.number().int().nonnegative()).default([]) }),
  features: z.object({
    title: z.string(),
    intro: z.string().default(""),
    items: z.array(z.object({ title: z.string(), body: z.string(), kicker: z.string().optional() })).min(3).max(7),
  }),
  story: z.object({
    title: z.string(),
    intro: z.string().default(""),
    steps: z.array(z.object({ kicker: z.string().optional(), title: z.string(), body: z.string() })).min(3).max(6),
  }),
  horizontal: z.object({
    title: z.string(),
    intro: z.string().default(""),
    items: z.array(z.object({ title: z.string(), body: z.string(), meta: z.string().optional() })).min(3).max(8),
  }),
  stats: z
    .object({
      title: z.string().optional(),
      items: z.array(z.object({ value: z.number(), prefix: z.string().optional(), suffix: z.string().optional(), decimals: z.number().int().min(0).max(3).optional(), label: z.string() })).max(4),
    })
    .default({ items: [] }),
  marquee: z.array(z.string()).min(3).max(12),
  cta: z.object({ title: z.string(), body: z.string(), button: Link }),
  footer: z.object({ tagline: z.string(), links: z.array(Link).max(6).default([]), legal: z.string() }),
  projects: z
    .array(
      z.object({
        slug: z.string().regex(/^[a-z0-9-]+$/),
        title: z.string(),
        year: z.string(),
        role: z.string(),
        location: z.string().optional(),
        summary: z.string(),
        body: z.string(),
        tags: z.array(z.string()).default([]),
      }),
    )
    .default([]),
});
export type SiteContent = z.infer<typeof SiteContentSchema>;
export type SiteContentInput = z.input<typeof SiteContentSchema>;

export const COPY_SYSTEM = `You are a senior brand copywriter for award-winning websites. Write specific, confident, concrete copy
for the brief: no clichés ("unlock", "revolutionize", "seamless", "next-level"), no lorem ipsum, no invented
statistics — stats only from facts stated in the brief (omit the stats items otherwise). Short headlines
(max 8 words), ledes under 30 words, body copy under 35 words. Write in the brief's locale.`;

export function copyPrompt(brief: DesignBrief, sections: string[]): string {
  return `<brief>${JSON.stringify(brief)}</brief>\n<sections>${JSON.stringify(sections)}</sections>\nReturn SiteContent JSON with keys: meta, brand, nav, hero, statement, features, story, horizontal, stats, marquee, cta, footer${
    brief.kind === "portfolio" ? ", projects (4-6 projects with slug/title/year/role/location/summary/body/tags)" : ""
  }.`;
}

/** Generate site copy with an LLM (purpose "design.copy", MODEL_BUILDER). */
export async function generateContent(llm: LLMProvider, briefIn: DesignBriefInput, sections: string[] = [], opts: { model?: string } = {}): Promise<SiteContent> {
  const brief = DesignBriefSchema.parse(briefIn);
  const { value } = await structured(
    llm,
    { purpose: "design.copy", model: opts.model ?? getModels().builder, system: COPY_SYSTEM, messages: [{ role: "user", content: copyPrompt(brief, sections) }], maxTokens: 6000 },
    SiteContentSchema,
  );
  return SiteContentSchema.parse(value);
}

// ---------------------------------------------------------------------------------------------------
// Rule-based copywriter (mock handler for "design.copy"). Deterministic; uses the brief's own words and
// facts. Stats are only produced from numbers stated in the brief.

export interface BriefFact {
  value: number;
  suffix: string;
  label: string;
  decimals: number;
}

const UNIT = String.raw`(%|\+|km|kg|g|h|min|kWh|W|m²|m2|x|k|M)?`;

/** Extract numeric facts like "120 km range" or "38 projects" from the brief text. */
export function extractFacts(text: string): BriefFact[] {
  const re = new RegExp(String.raw`(\d+(?:[.,]\d+)?)\s?${UNIT}[\s-]+([A-Za-zÀ-ž][A-Za-zÀ-ž\s-]{2,40}?)(?=[,.;:)]|\s+and\s|$)`, "g");
  const out: BriefFact[] = [];
  for (const m of text.matchAll(re)) {
    const raw = m[1]!.replace(",", ".");
    const value = Number(raw);
    if (!Number.isFinite(value) || (value > 1900 && value < 2100 && !m[2])) continue; // skip years
    const unit = m[2] ?? "";
    const label = m[3]!.trim().replace(/\s+/g, " ");
    if (/^(of|in|at|to|the)$/i.test(label)) continue;
    out.push({ value, suffix: unit ? (unit === "%" || unit === "+" || unit === "x" ? unit : ` ${unit}`) : "", label, decimals: raw.includes(".") ? raw.split(".")[1]!.length : 0 });
  }
  return out.slice(0, 4);
}

type Kind = "mobility" | "architecture" | "fintech" | "nature" | "tech" | "culture" | "generic";

function kindOf(tags: string[], brief: DesignBrief): Kind {
  const order: Array<[Kind, string[]]> = [
    ["architecture", ["architecture", "interior", "studio"]],
    ["mobility", ["mobility", "electric", "bike", "automotive"]],
    ["fintech", ["fintech", "finance", "payments", "crypto"]],
    ["nature", ["nature", "wellness", "food", "organic", "sustainable"]],
    ["culture", ["music", "art", "festival", "fashion", "culture"]],
    ["tech", ["tech", "saas", "ai", "developer", "data"]],
  ];
  for (const t of tags) for (const [k, ts] of order) if (ts.includes(t)) return k;
  return brief.kind === "portfolio" ? "architecture" : "generic";
}

const pickBy = <T,>(list: T[], seed: number, salt = 0): T => list[(seed + salt) % list.length]!;

function firstSentence(s: string): string {
  const m = /^(.+?[.!?])(\s|$)/.exec(s.trim());
  return (m?.[1] ?? s).trim();
}

interface CopyKit {
  eyebrow: string;
  headlines: Array<[string, string]>;
  statement: string[];
  featuresTitle: string;
  features: Array<[string, string, string]>;
  storyTitle: string;
  story: Array<[string, string, string]>;
  hTitle: string;
  hItems: Array<[string, string, string]>;
  marquee: string[];
  cta: [string, string, string];
}

function kit(kind: Kind, name: string, product: string, audience: string): CopyKit {
  switch (kind) {
    case "mobility":
      return {
        eyebrow: `${product} · designed for ${audience}`,
        headlines: [["The city, rewired around you.", "rewired"], ["Silent torque for loud streets.", "Silent"], ["Distance is a feeling now.", "feeling"]],
        statement: [`${name} is for the short trips that used to need a car — the school run, the late shift, the long way home along the water.`],
        featuresTitle: "Built for the miles nobody photographs",
        features: [
          ["Torque that reads the road", "A torque sensor meters assistance from your own effort, so hills feel like flats and starts feel natural.", "Drive"],
          ["Battery you can carry upstairs", "The pack clicks out with one hand and charges from any socket at home or at work.", "Power"],
          ["Lights that make you seen", "Integrated front and rear lights run from the main battery and stay on for the whole ride.", "Safety"],
          ["Service without the shop", "Diagnostics run in the app; most fixes are a five-minute guided job with standard tools.", "Care"],
          ["A frame that fits", "Sizes and a low step-through option, tuned so riders of most heights sit upright and relaxed.", "Fit"],
        ],
        storyTitle: "From first pedal stroke to the hundredth commute",
        story: [
          ["01 — Unlock", "Wake it with your phone", "Proximity unlock and a single button. No keys, no fuss, no warm-up."],
          ["02 — Climb", "Hills stop being a route decision", "Assistance rises with every push, so the steep way becomes the short way."],
          ["03 — Glide", "Traffic thins, you don't slow down", "A quiet hub motor and wide tyres keep the ride calm over cobbles and tram lines."],
          ["04 — Park", "Locked, tracked, charged", "Built-in lock and location tracking, and the battery comes inside with you."],
        ],
        hTitle: "Pick your line through the city",
        hItems: [
          ["Commuter", "Fenders, rack and lights fitted. Ready for rain and Monday mornings.", "Everyday"],
          ["Cargo", "A long tail that carries two kids or a week of groceries without drama.", "Family"],
          ["Sport", "Lighter frame and sharper geometry for riders who still like to sweat.", "Weekend"],
          ["Fold", "Folds in seconds for the train, the boot or a small hallway.", "Compact"],
          ["Fleet", "Shared bikes with remote locking and service dashboards for teams.", "Business"],
        ],
        marquee: ["Quiet", "Torque", "Range", "Light", "Repairable", "Urban", "Electric", "Yours"],
        cta: ["Book a test ride", `Twenty minutes on a ${name} explains it better than this page can.`, "Book a ride"],
      };
    case "architecture":
      return {
        eyebrow: `${product} · ${audience}`,
        headlines: [["Rooms that hold the light.", "light"], ["Built slowly. Meant to stay.", "stay"], ["Quiet buildings, long shadows.", "Quiet"]],
        statement: [`${name} designs buildings around the way light, weather and people move through a site — then removes everything that doesn't need to be there.`],
        featuresTitle: "How the studio works",
        features: [
          ["Site first", "Every project starts with weeks on site: sun paths, wind, sound and the routes people already walk.", "Method"],
          ["Material honesty", "Timber, brick and lime chosen for how they age, not how they render.", "Craft"],
          ["Small team, whole project", "The architects who sketch the first plan are the ones on site at handover.", "Studio"],
          ["Low-carbon by default", "Retrofit before rebuild, bio-based materials and lifecycle numbers on every drawing set.", "Carbon"],
        ],
        storyTitle: "Selected work",
        story: [
          ["Residential", "A house that turns with the sun", "Plan rotated fifteen degrees to catch the low winter light across every room."],
          ["Cultural", "A library cut into the hillside", "Reading rooms step down the slope; the roof becomes a public meadow."],
          ["Workplace", "An office around a courtyard", "Every desk within six metres of daylight, with a planted void at the centre."],
          ["Retrofit", "A warehouse kept, not cleared", "Original brick and steel retained; new timber floors slot inside the shell."],
        ],
        hTitle: "Process, in five drawings",
        hItems: [
          ["Listen", "Briefing walks with the people who will use the building every day.", "Weeks 1–3"],
          ["Survey", "Measured drawings, daylight studies and a full material inventory.", "Weeks 3–6"],
          ["Sketch", "Hand drawings and card models before anything is digital.", "Weeks 6–10"],
          ["Detail", "Junctions drawn at full size so builders never have to guess.", "Months 3–6"],
          ["Build", "Weekly site visits until the last door handle is fitted.", "On site"],
        ],
        marquee: ["Light", "Timber", "Brick", "Courtyards", "Retrofit", "Landscape", "Silence", "Craft"],
        cta: ["Start a project", "Tell us about your site, your brief and your timeline. We reply to every enquiry within a week.", "Write to the studio"],
      };
    case "fintech":
      return {
        eyebrow: `${product} for ${audience}`,
        headlines: [["Money that moves at your speed.", "your"], ["Finance without the waiting room.", "waiting"], ["Every transfer, accounted for.", "accounted"]],
        statement: [`${name} turns the slow, opaque parts of money — transfers, reconciliation, approvals — into something you can see in real time and trust.`],
        featuresTitle: "Clarity on every line",
        features: [
          ["Real-time ledger", "Every payment appears the moment it settles, already categorised and matched.", "Ledger"],
          ["Approvals in one tap", "Set rules once; the right person approves from their phone with full context.", "Control"],
          ["Multi-currency by default", "Hold, send and receive in local currencies with the rate shown before you confirm.", "FX"],
          ["Audit trail you can export", "Every change is logged and exportable for your accountant in one click.", "Compliance"],
          ["Bank-grade security", "Strong customer authentication, encryption at rest and granular roles.", "Security"],
        ],
        storyTitle: "From sign-up to first payout",
        story: [
          ["Step 01", "Open an account in minutes", "Verify your company online; no branch visit, no paper forms."],
          ["Step 02", "Connect what you already use", "Sync your accounting tool and bank feeds so nothing is typed twice."],
          ["Step 03", "Pay and get paid", "Send invoices with a payment link and watch them reconcile themselves."],
          ["Step 04", "See the whole picture", "Cash flow, runway and upcoming bills on one calm screen."],
        ],
        hTitle: "Built for every part of the money flow",
        hItems: [
          ["Accounts", "Business accounts with local details in the currencies you trade in.", "Hold"],
          ["Cards", "Virtual and physical cards with per-card limits and instant freeze.", "Spend"],
          ["Invoicing", "Branded invoices with payment links and automatic reminders.", "Earn"],
          ["Payouts", "Batch payouts to suppliers and contractors with one approval.", "Send"],
          ["Insights", "Forecasts built from your real transactions, not spreadsheets.", "Plan"],
        ],
        marquee: ["Transparent", "Real-time", "Multi-currency", "Auditable", "Secure", "Fast", "Calm", "Clear"],
        cta: ["Join the launch", `Early access to ${name} opens in waves. Reserve your place and we'll be in touch.`, "Get early access"],
      };
    case "nature":
      return {
        eyebrow: `${product} · for ${audience}`,
        headlines: [["Grown slowly, on purpose.", "slowly"], ["Rooted in the season.", "season"], ["Good things take weather.", "weather"]],
        statement: [`${name} follows the seasons instead of fighting them — fewer things, made carefully, from sources we can visit.`],
        featuresTitle: "What we care about",
        features: [
          ["Traceable sources", "Every ingredient and material traced to the farm, forest or workshop it came from.", "Origin"],
          ["Seasonal rhythm", "What we offer changes with the year, so nothing is forced out of season.", "Season"],
          ["Low-waste by design", "Refillable, compostable or returnable packaging on everything we ship.", "Waste"],
          ["Fair partners", "Long contracts and fair prices for the small producers we work with.", "People"],
        ],
        storyTitle: "A year in four chapters",
        story: [
          ["Spring", "Planting", "We choose what to grow with our partners before the first frost lifts."],
          ["Summer", "Tending", "Long days, careful work and very little machinery."],
          ["Autumn", "Harvest", "Picked at peak and processed within hours, close to the field."],
          ["Winter", "Rest", "The land rests; we repair, plan and visit every partner."],
        ],
        hTitle: "The range",
        hItems: [
          ["Essentials", "The everyday staples, always in stock, always traceable.", "Core"],
          ["Seasonal", "Small batches that exist for a few weeks a year.", "Limited"],
          ["Gifts", "Boxed sets wrapped in recycled paper, no plastic.", "Share"],
          ["Subscriptions", "Delivered each season; pause or skip any time.", "Ongoing"],
        ],
        marquee: ["Seasonal", "Traceable", "Slow", "Local", "Fair", "Organic", "Careful", "Honest"],
        cta: ["Taste the season", `See what ${name} is harvesting right now.`, "Explore the range"],
      };
    case "culture":
      return {
        eyebrow: `${product} · ${audience}`,
        headlines: [["Louder than the room.", "Louder"], ["Made for the front row.", "front"], ["Turn it all the way up.", "all"]],
        statement: [`${name} is a stage for work that refuses to sit politely in the background.`],
        featuresTitle: "What's on",
        features: [
          ["Live", "Performances in rooms small enough to feel the bass in your chest.", "Stage"],
          ["Exhibitions", "Work by artists we'd queue to see ourselves.", "Walls"],
          ["Talks", "Makers explaining the decisions behind the work.", "Voices"],
          ["Late", "Doors open until the last person leaves.", "Night"],
        ],
        storyTitle: "How a night unfolds",
        story: [
          ["19:00", "Doors", "Arrive early; the bar and the first room open together."],
          ["20:30", "Openers", "New names we think you'll talk about next year."],
          ["22:00", "Headline", "The set you came for, in full."],
          ["Late", "After", "DJs until close, lights down, phones away."],
        ],
        hTitle: "Upcoming",
        hItems: [
          ["Season opening", "The first night of the season, with every room open.", "Opening"],
          ["Open studio", "Artists at work, questions welcome.", "Daytime"],
          ["Late session", "Extended hours with guest selectors.", "Night"],
          ["Closing party", "The last night of the season.", "Finale"],
        ],
        marquee: ["Live", "Late", "Loud", "Local", "Art", "Sound", "Night", "Now"],
        cta: ["Get on the list", `Hear about every ${name} night before tickets go public.`, "Join the list"],
      };
    case "tech":
    case "generic":
    default:
      return {
        eyebrow: `${product} · for ${audience}`,
        headlines: [["Less setup. More shipping.", "shipping"], ["The shortest path to done.", "done"], ["Built for teams who ship.", "ship"]],
        statement: [`${name} removes the busywork between an idea and a result, so ${audience} spend their days on the part that matters.`],
        featuresTitle: "Everything you need, nothing you don't",
        features: [
          ["Fast by default", "Opens instantly and stays fast as your workspace grows.", "Speed"],
          ["Works with your stack", "Connects to the tools your team already uses in a few clicks.", "Integrations"],
          ["Private by design", "Your data is encrypted, exportable and never used to train anything.", "Privacy"],
          ["Made for teams", "Roles, comments and history so everyone stays in sync.", "Together"],
          ["Automation", "Turn repeated steps into rules that run on their own.", "Flow"],
        ],
        storyTitle: "How it works",
        story: [
          ["Step 01", "Connect", "Sign in and connect your existing tools in under five minutes."],
          ["Step 02", "Shape", "Pick a starting point and adjust it to how your team works."],
          ["Step 03", "Run", "Let the routine work run itself while you focus on decisions."],
          ["Step 04", "Learn", "See what's working and improve it every week."],
        ],
        hTitle: "Use cases",
        hItems: [
          ["Product", "Plan, build and ship features with less coordination overhead.", "Teams"],
          ["Operations", "Automate the handoffs between people and systems.", "Ops"],
          ["Support", "Answer faster with context from every tool in one place.", "Service"],
          ["Leadership", "See progress without asking for status updates.", "Insight"],
        ],
        marquee: ["Fast", "Private", "Connected", "Reliable", "Simple", "Secure", "Open", "Yours"],
        cta: ["Try it today", `Set up ${name} in minutes and see the difference this week.`, "Get started"],
      };
  }
}

/** Deterministic rule-based copy for a brief (mock handler for "design.copy"). */
export function mockCopy(brief: DesignBrief): SiteContent {
  const tags = briefTags(brief);
  const seed = hashString(brief.name + brief.description);
  const kind = kindOf(tags, brief);
  const product = brief.industry ?? brief.keywords[0] ?? (brief.kind === "portfolio" ? "Studio" : "Product");
  const audience = brief.audience ?? "people who care about details";
  const k = kit(kind, brief.name, product, audience);
  const [headline, emphasis] = pickBy(k.headlines, seed);
  const lede = firstSentence(brief.description);
  const facts = extractFacts(brief.description);
  const statement = pickBy(k.statement, seed);
  const statementWords = statement.split(/\s+/);
  const nameWords = brief.name.toLowerCase().split(/\s+/);
  const clean = (w: string) => w.replace(/[^\p{L}\p{N}]/gu, "").toLowerCase();
  const start = statementWords.findIndex((_, i) => nameWords.every((n, j) => clean(statementWords[i + j] ?? "") === n));
  const emphasisIdx = start >= 0 ? nameWords.map((_, j) => start + j) : [];
  const isPortfolio = brief.kind === "portfolio";
  const projects = isPortfolio
    ? k.story.map(([kicker, title, body], i) => ({
        slug: title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, ""),
        title,
        year: String(2025 - i * 2),
        role: "Architecture & interiors",
        location: kicker,
        summary: body,
        body: `${body} The brief asked for ${firstSentence(brief.description).toLowerCase().replace(/\.$/, "")}; the design answers it with a restrained palette of materials and a plan organised around daylight.`,
        tags: [kicker.toLowerCase(), "concept", "drawings"],
      }))
    : [];
  const nav = isPortfolio
    ? [{ label: "Work", href: "#work" }, { label: "Studio", href: "#studio" }, { label: "Process", href: "#process" }, { label: "Contact", href: "#contact" }]
    : [{ label: "Product", href: "#features" }, { label: "Story", href: "#story" }, { label: "Range", href: "#range" }, { label: "Contact", href: "#contact" }];
  return SiteContentSchema.parse({
    generatedBy: "mock-copywriter (rule-based)",
    meta: { title: `${brief.name} — ${headline.replace(/\.$/, "")}`.slice(0, 70), description: lede.slice(0, 160) },
    brand: brief.name,
    nav,
    hero: {
      eyebrow: k.eyebrow,
      headline,
      emphasis,
      lede,
      primaryCta: { label: k.cta[2], href: "#contact" },
      secondaryCta: { label: isPortfolio ? "See the work" : "How it works", href: isPortfolio ? "#work" : "#story" },
    },
    statement: { text: statement, emphasis: emphasisIdx },
    features: { title: k.featuresTitle, intro: "", items: k.features.map(([title, body, kicker]) => ({ title, body, kicker })) },
    story: { title: k.storyTitle, intro: "", steps: k.story.map(([kicker, title, body]) => ({ kicker, title, body })) },
    horizontal: { title: k.hTitle, intro: "", items: k.hItems.map(([title, body, meta]) => ({ title, body, meta })) },
    stats: { title: facts.length ? "By the numbers" : undefined, items: facts.map((f) => ({ value: f.value, suffix: f.suffix, decimals: f.decimals, label: f.label })) },
    marquee: k.marquee,
    cta: { title: k.cta[0], body: k.cta[1], button: { label: k.cta[2], href: `mailto:hello@${brief.name.toLowerCase().replace(/[^a-z0-9]+/g, "")}.example` } },
    footer: {
      tagline: statement.split(" — ")[0]!.slice(0, 120),
      links: nav,
      legal: `© ${new Date().getUTCFullYear()} ${brief.name}`,
    },
    projects,
  });
}
