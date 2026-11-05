/**
 * Rule-based deck/document builders used by the mock LLM handlers (LLM_PROVIDER=mock).
 * They assemble a coherent structure for common deck/document types from the brief's own nouns.
 * They never invent facts: numbers come only from `data`; otherwise explicit "[add …]" placeholders are used.
 */
import type { ContentData } from "./data.js";
import type { DeckOutline, Doc, DocSection, SlideInput } from "./schema.js";

export type DeckType = "pitch" | "report" | "training" | "general";
export type Lang = "en" | "sv";

export interface BriefInfo {
  lang: Lang;
  subject: string;
  description?: string;
  audience?: string;
  keywords: string[];
}

const STOP = new Set(
  (
    "a an the and or of for to in on with by from at as is are be this that these those our your their my we you it its into about over under " +
    "make create build generate want need please deck slides slide presentation pitch investor investors document report doc write draft " +
    "using based new about which who what will can should would could also more most very just than then them they his her " +
    "en ett och att det som med för till av på är inte jag vi de den detta denna våra vårt vår min mitt skapa gör göra bygg presentation " +
    "rapport dokument bild bilder om från hos eller samt kan ska vill behöver analysis analys marknadsanalys market marknad targeting aimed riktad"
  ).split(" "),
);

const SV_HINT = /[åäö]|\b(och|för|med|som|att|en|ett|till|vår|vårt|skapa|rapport|marknadsanalys|investerare|utbildning)\b/i;

export function detectLang(text: string): Lang {
  const hits = text.match(new RegExp(SV_HINT.source, "gi"))?.length ?? 0;
  return hits >= 2 ? "sv" : "en";
}

export function detectDeckType(brief: string): DeckType {
  const b = brief.toLowerCase();
  if (/\b(pitch|investor|investerare|fundrais|seed|series [a-c]|startup|vc\b|riskkapital)/.test(b)) return "pitch";
  if (/\b(training|workshop|onboarding|course|lesson|tutorial|utbildning|kurs|lektion|introduktion till)/.test(b)) return "training";
  if (/\b(report|quarterly|q[1-4]\b|annual|results|review|status|rapport|kvartal|årsrapport|uppföljning)/.test(b)) return "report";
  return "general";
}

function cap(s: string): string {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

const PHRASE_STOP = /^(a|an|the|that|which|who|to|in|on|with|for|from|and|or|targeting|aimed|focused|using|by|en|ett|som|att|i|på|med|för|från|och|eller|riktad|inom)$/i;

/** "Market analysis for Nordic e-bike subscriptions targeting …" → "Nordic e-bike subscriptions". */
function namedPhrase(brief: string): string | undefined {
  const m = brief.match(/\b(?:for|called|named|about|on|för|kallad|som heter|om)\s+([A-ZÅÄÖ][^,.;:\n]*)/u);
  if (!m?.[1]) return undefined;
  const out: string[] = [];
  for (const w of m[1].trim().split(/\s+/)) {
    const clean = w.replace(/[^\p{L}\d&.'-]/gu, "");
    if (!clean || PHRASE_STOP.test(clean) || out.length >= 4) break;
    out.push(clean);
  }
  return out.length ? out.join(" ") : undefined;
}

export function analyzeBrief(brief: string): BriefInfo {
  const lang = detectLang(brief);
  const quoted = brief.match(/["“”«]([^"“”»]{2,40})["“”»]/)?.[1];
  const named = namedPhrase(brief);
  const firstCap = brief
    .split(/\s+/)
    .slice(1)
    .map((w) => w.replace(/[^\p{L}\d&.-]/gu, ""))
    .find((w) => /^[A-ZÅÄÖ]/.test(w) && !STOP.has(w.toLowerCase()) && w.length > 1);
  const words = brief.toLowerCase().replace(/[^\p{L}\d\s-]/gu, " ").split(/\s+/).filter(Boolean);
  // Words right after "that/which/who/to" are usually verbs ("…app that adapts lessons"): not topic nouns.
  const verbish = new Set(words.filter((_, i) => i > 0 && /^(that|which|who|to|som|att)$/.test(words[i - 1] as string)));
  const tokens = words.filter((t) => t.length >= 4 && !STOP.has(t) && !/^\d+$/.test(t) && !verbish.has(t));
  const freq = new Map<string, number>();
  tokens.forEach((t, i) => freq.set(t, (freq.get(t) ?? 0) + 1 + 1 / (i + 10)));
  const subject = (quoted ?? named ?? firstCap ?? cap(tokens[0] ?? (lang === "sv" ? "Vårt företag" : "Our company"))).trim();
  const idx = brief.indexOf(subject);
  const after = idx >= 0 ? brief.slice(idx + subject.length) : "";
  const description = after.match(/^["”»]?\s*[,:–—-]\s*([^.;\n]{5,140})/)?.[1]?.trim();
  const tail = "(?=[,.;]|$| who| that| to| som| att| with| med)";
  const audience = (
    brief.match(new RegExp(`\\b(?:targeting|aimed at|riktad till|riktat till)\\s+([\\p{L}][\\p{L}\\d -]{3,60}?)${tail}`, "u"))?.[1] ??
    (description ?? brief).match(new RegExp(`\\b(?:for|för)\\s+([\\p{L}][\\p{L}\\d -]{3,60}?)${tail}`, "u"))?.[1]
  )?.trim();
  const audienceWords = new Set((audience ?? "").toLowerCase().split(/\s+/));
  const subjectWords = new Set(subject.toLowerCase().split(/\s+/));
  const ranked = [...freq.entries()].sort((a, b) => b[1] - a[1]).map(([t]) => t).filter((t) => !audienceWords.has(t));
  const withoutSubject = ranked.filter((t) => !subjectWords.has(t));
  // Short briefs: fall back to the subject's own nouns ("e-bike", "subscriptions") rather than nothing.
  const keywords = (withoutSubject.length >= 2 ? withoutSubject : ranked.filter((t) => t !== [...subjectWords][0])).slice(0, 8);
  return { lang, subject, description, audience: audience && audience !== subject ? audience : undefined, keywords };
}

const L = (lang: Lang) => (en: string, sv: string) => (lang === "sv" ? sv : en);

type Candidate = { priority: number; slide: SlideInput };

function slug(s: string): string {
  return s.toLowerCase().normalize("NFKD").replace(/[^\w]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "slide";
}

function pick(cands: Candidate[], count: number): SlideInput[] {
  const keep = new Set([...cands].sort((a, b) => a.priority - b.priority).slice(0, count).map((c) => c.slide));
  return cands.filter((c) => keep.has(c.slide)).map((c) => c.slide);
}

function kw(info: BriefInfo, i: number, fallback: string): string {
  return info.keywords[i] ?? fallback;
}

function pitchSlides(info: BriefInfo, data: ContentData): Candidate[] {
  const t = L(info.lang);
  const s = info.subject;
  const who = info.audience ?? t("customers", "kunder");
  const d = info.description;
  const metrics = data.metrics;
  const charts = data.charts ?? [];
  const out: Candidate[] = [
    { priority: 0, slide: { id: "title", layout: "title", title: s, subtitle: d ? cap(d) : t(`${cap(kw(info, 0, "A better way"))}, reimagined`, `${cap(kw(info, 0, "Ett bättre sätt"))}, på nytt`), notes: t(`Open with one sentence on what ${s} does and for whom.`, `Börja med en mening om vad ${s} gör och för vem.`) } },
    {
      priority: 1,
      slide: {
        id: "problem", layout: "bullets", title: t("The problem", "Problemet"),
        bullets: [
          t(`${cap(who)} lose time on ${kw(info, 0, "manual work")} every week`, `${cap(who)} lägger för mycket tid på ${kw(info, 0, "manuellt arbete")} varje vecka`),
          t(`Today's tools for ${kw(info, 1, "this")} are fragmented, slow or expensive`, `Dagens verktyg för ${kw(info, 1, "detta")} är splittrade, långsamma eller dyra`),
          t(`The pain grows as demand for ${kw(info, 2, "better options")} increases`, `Problemet växer i takt med efterfrågan på ${kw(info, 2, "bättre alternativ")}`),
        ],
        notes: t("Tell one concrete customer story that makes the pain tangible.", "Berätta en konkret kundberättelse som gör problemet tydligt."),
      },
    },
    {
      priority: 2,
      slide: {
        id: "solution", layout: "bullets", title: t(`${s}: the solution`, `${s}: lösningen`), subtitle: d ? cap(d) : undefined,
        bullets: [
          t(`One place for ${kw(info, 0, "the whole workflow")}`, `En plats för ${kw(info, 0, "hela flödet")}`),
          t(`Built for ${who} from day one`, `Byggt för ${who} från dag ett`),
          t(`Measurable results in weeks, not months`, `Mätbara resultat på veckor, inte månader`),
        ],
        notes: t("Explain how the product removes each pain point from the previous slide.", "Förklara hur produkten löser varje problem från föregående bild."),
      },
    },
    {
      priority: 3,
      slide: metrics?.length
        ? { id: "market", layout: "stats", title: t("Market opportunity", "Marknadspotential"), stats: metrics.slice(0, 4), notes: t("Walk through the market figures and their sources.", "Gå igenom marknadssiffrorna och deras källor.") }
        : {
            id: "market", layout: "stats", title: t("Market opportunity", "Marknadspotential"),
            stats: [
              { value: "TAM", label: t("Total addressable market — [add sourced figure]", "Total marknad — [lägg till siffra med källa]") },
              { value: "SAM", label: t("Serviceable market — [add sourced figure]", "Adresserbar marknad — [lägg till siffra med källa]") },
              { value: "SOM", label: t("Obtainable in 3 years — [add sourced figure]", "Nåbar på 3 år — [lägg till siffra med källa]") },
            ],
            body: t("Placeholders: add market sizes with sources before presenting.", "Platshållare: lägg till marknadsstorlek med källor innan presentationen."),
            notes: t("Use bottom-up numbers: number of target customers × price.", "Använd bottom-up: antal målkunder × pris."),
          },
    },
    {
      priority: 4,
      slide: {
        id: "product", layout: "image-left", title: t("Product", "Produkten"),
        image: { prompt: `Clean product screenshot of ${s}${d ? `, ${d}` : ""}, modern UI, light background`, alt: t(`${s} product screenshot`, `Skärmbild av ${s}`) },
        bullets: [
          t(`${cap(kw(info, 0, "core"))} in a few clicks`, `${cap(kw(info, 0, "kärnflödet"))} med några klick`),
          t(`Works with the tools ${who} already use`, `Fungerar med verktygen ${who} redan använder`),
          t("Insights and reporting built in", "Insikter och rapporter inbyggt"),
        ],
        notes: t("Demo the key flow; show the moment of value.", "Demonstrera huvudflödet och visa värdet."),
      },
    },
    {
      priority: 5,
      slide: {
        id: "business-model", layout: "two-column", title: t("Business model", "Affärsmodell"),
        columns: [
          { heading: t("How we make money", "Så tjänar vi pengar"), bullets: [t("Subscription per team / seat", "Abonnemang per team / användare"), t("Usage-based add-ons", "Användningsbaserade tillägg"), t("Annual contracts for larger customers", "Årsavtal för större kunder")] },
          { heading: t("Unit economics", "Enhetsekonomi"), bullets: ["CAC: [add]", "LTV: [add]", t("Gross margin: [add]", "Bruttomarginal: [lägg till]"), t("Payback: [add]", "Återbetalningstid: [lägg till]")] },
        ],
        notes: t("Be explicit about pricing and the path to healthy margins.", "Var tydlig med prissättning och vägen till god marginal."),
      },
    },
    {
      priority: 6,
      slide: charts[0]
        ? { id: "traction", layout: "chart", title: charts[0].title ?? t("Traction", "Traction"), chart: charts[0], notes: t("Highlight growth rate and the strongest proof point.", "Lyft tillväxttakten och det starkaste beviset.") }
        : {
            id: "traction", layout: "bullets", title: t("Traction", "Traction"),
            bullets: [t("[Add users / customers to date]", "[Lägg till antal användare / kunder]"), t("[Add revenue or growth rate]", "[Lägg till intäkter eller tillväxttakt]"), t("[Add notable pilots, partners or LOIs]", "[Lägg till piloter, partners eller avsiktsförklaringar]")],
            notes: t("Replace placeholders with real metrics; pass data.charts to get a chart.", "Ersätt platshållarna med riktiga siffror; skicka data.charts för ett diagram."),
          },
    },
    {
      priority: 8,
      slide: {
        id: "competition", layout: "two-column", title: t("Competition", "Konkurrens"),
        columns: [
          { heading: t("Alternatives today", "Alternativ idag"), bullets: data.competitors?.length ? data.competitors.slice(0, 5) : [t("Spreadsheets and manual workflows", "Kalkylark och manuella flöden"), t(`Generic tools not built for ${who}`, `Generella verktyg som inte är byggda för ${who}`), t("Agencies and consultants", "Byråer och konsulter")] },
          { heading: t(`Why ${s} wins`, `Varför ${s} vinner`), bullets: [t(`Purpose-built for ${kw(info, 0, "the job")}`, `Specialbyggt för ${kw(info, 0, "uppgiften")}`), t("Faster time to value", "Snabbare tid till värde"), t("Lower total cost", "Lägre total kostnad")] },
        ],
        notes: t("Be fair to competitors; focus on the dimension where we are clearly better.", "Var rättvis mot konkurrenterna; fokusera på där vi är tydligt bättre."),
      },
    },
    {
      priority: 7,
      slide: {
        id: "team", layout: "bullets", title: t("Team", "Teamet"),
        bullets: data.team?.length ? data.team.map((m) => `${m.name} — ${m.role}`) : [t("[Founder name] — CEO, relevant background", "[Grundare] — vd, relevant bakgrund"), t("[Co-founder name] — CTO, relevant background", "[Medgrundare] — CTO, relevant bakgrund"), t("[Advisor] — domain expertise", "[Rådgivare] — branschkunskap")],
        notes: t("Why is this the team to win this market?", "Varför är det här teamet som vinner marknaden?"),
      },
    },
    {
      priority: 9,
      slide: charts[1]
        ? { id: "ask", layout: "chart", title: t("Financials & the ask", "Finansiering & behov"), subtitle: data.ask ? t(`Raising ${data.ask.amount}`, `Vi tar in ${data.ask.amount}`) : undefined, chart: charts[1], notes: t("Connect the raise to milestones.", "Koppla investeringen till milstolpar.") }
        : {
            id: "ask", layout: "stats", title: t("Financials & the ask", "Finansiering & behov"),
            stats: [
              { value: data.ask?.amount ?? t("[amount]", "[belopp]"), label: t("Raising", "Vi tar in") },
              { value: data.ask?.runway ?? t("[months]", "[månader]"), label: t("Runway", "Runway") },
              { value: t("[milestone]", "[milstolpe]"), label: data.ask?.useOfFunds?.length ? t(`Use of funds: ${data.ask.useOfFunds.join(", ")}`, `Användning: ${data.ask.useOfFunds.join(", ")}`) : t("Use of funds: [add]", "Användning: [lägg till]") },
            ],
            notes: t("State the amount, the milestones it buys and the timeline.", "Ange belopp, vilka milstolpar det ger och tidslinjen."),
          },
    },
    {
      priority: 10,
      slide: { id: "closing", layout: "closing", title: t("Thank you", "Tack"), subtitle: s, body: data.contact ?? t("[Contact email]", "[Kontakt e-post]"), notes: t("Invite questions; restate the ask.", "Bjud in till frågor; upprepa behovet.") },
    },
    {
      priority: 11,
      slide: { id: "why-now", layout: "bullets", title: t("Why now", "Varför nu"), bullets: [t(`The technology behind ${kw(info, 0, "this")} has matured`, `Tekniken bakom ${kw(info, 0, "detta")} har mognat`), t(`${cap(who)} expect better tools`, `${cap(who)} förväntar sig bättre verktyg`), t("Regulation and budgets are shifting", "Regelverk och budgetar förändras")], notes: t("Explain the timing.", "Förklara varför tidpunkten är rätt.") },
    },
    {
      priority: 12,
      slide: { id: "roadmap", layout: "timeline", title: t("Roadmap", "Färdplan"), timeline: [{ label: t("Now", "Nu"), text: t(`Launch core ${kw(info, 0, "product")}`, `Lansera kärnan i ${kw(info, 0, "produkten")}`) }, { label: t("Next", "Nästa"), text: t("Integrations and team features", "Integrationer och teamfunktioner") }, { label: t("Later", "Senare"), text: t("New segments and markets", "Nya segment och marknader") }], notes: t("Tie roadmap items to the use of funds.", "Koppla färdplanen till användningen av kapitalet.") },
    },
  ];
  if (data.quotes?.[0]) out.splice(out.findIndex((c) => c.slide.id === "traction") + 1, 0, { priority: 6.5, slide: { id: "customer-quote", layout: "quote", title: t("What customers say", "Vad kunderna säger"), quote: data.quotes[0], notes: "" } });
  return out;
}

function reportSlides(info: BriefInfo, data: ContentData): Candidate[] {
  const t = L(info.lang);
  const s = info.subject;
  const charts = data.charts ?? [];
  return [
    { priority: 0, slide: { id: "title", layout: "title", title: s, subtitle: info.description ? cap(info.description) : t("Report", "Rapport"), notes: t("Set context: period, scope and audience.", "Sätt kontext: period, omfattning och mottagare.") } },
    { priority: 1, slide: { id: "summary", layout: "bullets", title: t("Executive summary", "Sammanfattning"), bullets: [t(`Overall status of ${kw(info, 0, "the work")}`, `Övergripande status för ${kw(info, 0, "arbetet")}`), t("Most important result this period", "Viktigaste resultatet under perioden"), t("Key decision needed", "Viktigaste beslutet som behövs")], notes: t("Lead with the conclusion.", "Börja med slutsatsen.") } },
    { priority: 2, slide: data.metrics?.length ? { id: "metrics", layout: "stats", title: t("Key metrics", "Nyckeltal"), stats: data.metrics.slice(0, 4), notes: "" } : { id: "metrics", layout: "stats", title: t("Key metrics", "Nyckeltal"), stats: [{ value: "[ ]", label: t("Metric 1 — add value", "Nyckeltal 1 — lägg till") }, { value: "[ ]", label: t("Metric 2 — add value", "Nyckeltal 2 — lägg till") }, { value: "[ ]", label: t("Metric 3 — add value", "Nyckeltal 3 — lägg till") }], notes: t("Replace placeholders with real figures.", "Ersätt platshållarna med riktiga siffror.") } },
    ...(charts[0] ? [{ priority: 3, slide: { id: "trend", layout: "chart" as const, title: charts[0].title ?? t("Trend", "Trend"), chart: charts[0], notes: t("Explain the main movement in the chart.", "Förklara den viktigaste förändringen.") } }] : []),
    { priority: 4, slide: { id: "highlights", layout: "bullets", title: t("Highlights", "Höjdpunkter"), bullets: [t(`Progress on ${kw(info, 0, "priorities")}`, `Framsteg inom ${kw(info, 0, "prioriteringar")}`), t(`Wins in ${kw(info, 1, "delivery")}`, `Vinster inom ${kw(info, 1, "leverans")}`), t("Team and process improvements", "Förbättringar i team och process")], notes: "" } },
    { priority: 5, slide: { id: "challenges", layout: "two-column", title: t("Challenges & mitigations", "Utmaningar & åtgärder"), columns: [{ heading: t("Challenges", "Utmaningar"), bullets: [t(`Risks around ${kw(info, 2, "timeline")}`, `Risker kring ${kw(info, 2, "tidplan")}`), t("Resource constraints", "Resursbrist")] }, { heading: t("Mitigations", "Åtgärder"), bullets: [t("Re-prioritised scope", "Omprioriterad omfattning"), t("Added checkpoints", "Fler avstämningar")] }], notes: "" } },
    { priority: 6, slide: { id: "outlook", layout: "timeline", title: t("Outlook", "Framåt"), timeline: [{ label: t("Next month", "Nästa månad"), text: t("Close open items", "Stäng öppna punkter") }, { label: t("Next quarter", "Nästa kvartal"), text: t(`Scale ${kw(info, 0, "results")}`, `Skala ${kw(info, 0, "resultaten")}`) }, { label: t("Next year", "Nästa år"), text: t("Strategic goals", "Strategiska mål") }], notes: "" } },
    { priority: 7, slide: { id: "recommendations", layout: "bullets", title: t("Recommendations", "Rekommendationer"), bullets: [t("Decide on the open question raised in the summary", "Fatta beslut i frågan från sammanfattningen"), t(`Invest further in ${kw(info, 0, "what works")}`, `Investera mer i ${kw(info, 0, "det som fungerar")}`), t("Review again next period", "Följ upp nästa period")], notes: "" } },
    { priority: 8, slide: { id: "section-appendix", layout: "section", title: t("Appendix", "Bilaga"), notes: "" } },
    { priority: 9, slide: { id: "closing", layout: "closing", title: t("Questions & discussion", "Frågor & diskussion"), subtitle: s, notes: "" } },
  ];
}

function trainingSlides(info: BriefInfo): Candidate[] {
  const t = L(info.lang);
  const s = info.subject;
  const k = (i: number, f: string) => cap(kw(info, i, f));
  return [
    { priority: 0, slide: { id: "title", layout: "title", title: s, subtitle: info.description ? cap(info.description) : t("Training session", "Utbildningstillfälle"), notes: t("Welcome participants and set expectations.", "Välkomna deltagarna och sätt förväntningar.") } },
    { priority: 1, slide: { id: "agenda", layout: "timeline", title: t("Agenda", "Agenda"), timeline: [{ label: "1", text: k(0, t("Basics", "Grunder")) }, { label: "2", text: k(1, t("Practice", "Övning")) }, { label: "3", text: k(2, t("Advanced", "Fördjupning")) }, { label: "4", text: t("Q&A", "Frågor") }], notes: "" } },
    { priority: 2, slide: { id: "objectives", layout: "bullets", title: t("Learning objectives", "Lärandemål"), bullets: [t(`Understand ${kw(info, 0, "the basics")}`, `Förstå ${kw(info, 0, "grunderna")}`), t(`Apply ${kw(info, 1, "the method")} in daily work`, `Tillämpa ${kw(info, 1, "metoden")} i det dagliga arbetet`), t("Know where to get help", "Veta var man får hjälp")], notes: "" } },
    { priority: 3, slide: { id: "module-1", layout: "section", title: t(`Module 1: ${k(0, "Basics")}`, `Modul 1: ${k(0, "Grunder")}`), notes: "" } },
    { priority: 4, slide: { id: "concepts", layout: "two-column", title: t("Key concepts", "Nyckelbegrepp"), columns: [{ heading: k(0, t("Concept A", "Begrepp A")), bullets: [t("What it is", "Vad det är"), t("Why it matters", "Varför det spelar roll")] }, { heading: k(1, t("Concept B", "Begrepp B")), bullets: [t("When to use it", "När det används"), t("Common mistakes", "Vanliga misstag")] }], notes: "" } },
    { priority: 5, slide: { id: "example", layout: "image-left", title: t("Worked example", "Exempel"), image: { prompt: `Illustration of ${s} in practice, friendly flat style`, alt: t(`${s} example illustration`, `Illustration av ${s}`) }, bullets: [t("Step 1: prepare", "Steg 1: förbered"), t("Step 2: do", "Steg 2: genomför"), t("Step 3: check", "Steg 3: kontrollera")], notes: "" } },
    { priority: 6, slide: { id: "exercise", layout: "bullets", title: t("Practice exercise", "Övning"), bullets: [t(`Try ${kw(info, 0, "the method")} on a real case (10 min)`, `Testa ${kw(info, 0, "metoden")} på ett riktigt fall (10 min)`), t("Compare results in pairs", "Jämför resultat i par"), t("Share one learning", "Dela en lärdom")], notes: "" } },
    { priority: 7, slide: { id: "check", layout: "bullets", title: t("Check your understanding", "Kontrollfrågor"), bullets: [t(`What is ${kw(info, 0, "the core idea")}?`, `Vad är ${kw(info, 0, "huvudidén")}?`), t("When would you not use it?", "När ska man inte använda det?"), t("What is your first next step?", "Vad är ditt första nästa steg?")], notes: "" } },
    { priority: 8, slide: { id: "summary", layout: "bullets", title: t("Summary", "Sammanfattning"), bullets: [t("Key takeaway 1", "Viktigaste lärdom 1"), t("Key takeaway 2", "Viktigaste lärdom 2"), t("Key takeaway 3", "Viktigaste lärdom 3")], notes: "" } },
    { priority: 9, slide: { id: "closing", layout: "closing", title: t("Resources & next steps", "Resurser & nästa steg"), bullets: [t("Cheat sheet", "Lathund"), t("Follow-up session", "Uppföljning"), t("Contact for questions", "Kontakt för frågor")], notes: "" } },
  ];
}

function generalSlides(info: BriefInfo, data: ContentData): Candidate[] {
  const t = L(info.lang);
  const s = info.subject;
  const k = (i: number, f: string) => cap(kw(info, i, f));
  return [
    { priority: 0, slide: { id: "title", layout: "title", title: s, subtitle: info.description ? cap(info.description) : undefined, notes: "" } },
    { priority: 1, slide: { id: "overview", layout: "bullets", title: t("Overview", "Översikt"), bullets: info.keywords.slice(0, 4).map((x) => cap(x)).concat(info.keywords.length ? [] : [t("Context", "Bakgrund"), t("Goals", "Mål"), t("Approach", "Angreppssätt")]), notes: "" } },
    { priority: 2, slide: { id: "section-1", layout: "section", title: k(0, t("Background", "Bakgrund")), notes: "" } },
    { priority: 3, slide: { id: "key-points", layout: "two-column", title: t("Key points", "Nyckelpunkter"), columns: [{ heading: k(1, t("What", "Vad")), bullets: [t("Current situation", "Nuläge"), t("What changes", "Vad som förändras")] }, { heading: k(2, t("Why", "Varför")), bullets: [t("Benefits", "Fördelar"), t("Risks", "Risker")] }], notes: "" } },
    { priority: 4, slide: { id: "visual", layout: "image-full", title: s, subtitle: info.description, image: { prompt: `Editorial photo representing ${s}${info.description ? `, ${info.description}` : ""}`, alt: s }, notes: "" } },
    ...(data.metrics?.length ? [{ priority: 5, slide: { id: "numbers", layout: "stats" as const, title: t("In numbers", "I siffror"), stats: data.metrics.slice(0, 4), notes: "" } }] : []),
    ...(data.charts?.[0] ? [{ priority: 5.5, slide: { id: "chart", layout: "chart" as const, title: data.charts[0].title ?? t("Data", "Data"), chart: data.charts[0], notes: "" } }] : []),
    { priority: 6, slide: { id: "summary", layout: "bullets", title: t("Summary", "Sammanfattning"), bullets: [t("Main conclusion", "Huvudslutsats"), t("Recommended next step", "Rekommenderat nästa steg"), t("Open questions", "Öppna frågor")], notes: "" } },
    { priority: 7, slide: { id: "closing", layout: "closing", title: t("Thank you", "Tack"), subtitle: s, notes: "" } },
  ];
}

/** Rule-based deck outline for a brief (used by the mock LLM handler for "slides.outline"). */
export function ruleBasedDeckOutline(brief: string, slideCount: number, data: ContentData = {}): DeckOutline {
  const info = analyzeBrief(brief);
  const type = detectDeckType(brief);
  const cands = type === "pitch" ? pitchSlides(info, data) : type === "report" ? reportSlides(info, data) : type === "training" ? trainingSlides(info) : generalSlides(info, data);
  let slides = pick(cands, Math.max(1, slideCount));
  // A closing slide always ends the deck, even when extra slides (why now, roadmap) are kept.
  slides = [...slides.filter((x) => x.layout !== "closing"), ...slides.filter((x) => x.layout === "closing")];
  // Pad when more slides are requested than the template has: one bullet slide per brief keyword.
  for (let i = 0; slides.length < slideCount; i++) {
    const topic = cap(info.keywords[i % Math.max(1, info.keywords.length)] ?? `Topic ${i + 1}`);
    slides.splice(Math.max(1, slides.length - 1), 0, { id: `${slug(topic)}-${i + 1}`, layout: "bullets", title: topic, bullets: L(info.lang)(`Key facts about ${topic.toLowerCase()}|Implications|Next steps`, `Fakta om ${topic.toLowerCase()}|Konsekvenser|Nästa steg`).split("|"), notes: "" });
  }
  slides = slides.map((sl) => ({ ...sl, notes: sl.notes || defaultNotes(sl, info.lang) }));
  const t = L(info.lang);
  const title = type === "pitch" ? info.subject : type === "report" ? t(`${info.subject} report`, `${info.subject} – rapport`) : type === "training" ? t(`${info.subject} training`, `${info.subject} – utbildning`) : info.subject;
  return { title, slides: slides as DeckOutline["slides"], meta: { generator: "rule-based mock (LLM_PROVIDER=mock)", deckType: type, lang: info.lang } };
}

function defaultNotes(sl: SlideInput, lang: Lang): string {
  const pts = [...(sl.bullets ?? []), ...(sl.columns ?? []).map((c) => c.heading ?? "")].filter(Boolean).slice(0, 3);
  return lang === "sv"
    ? `${sl.title}. ${pts.length ? `Gå igenom: ${pts.join("; ")}.` : "Håll det kort och tydligt."}`
    : `${sl.title}. ${pts.length ? `Cover: ${pts.join("; ")}.` : "Keep it short and clear."}`;
}

// ---------------- documents ----------------

export type DocKind = "market-analysis" | "report";

export function detectDocKind(brief: string): DocKind {
  return /\b(market|marknad|competitor|konkurrent|industry|bransch|segment)/i.test(brief) ? "market-analysis" : "report";
}

/** Rule-based document (used by the mock LLM handler for "slides.document"). */
export function ruleBasedDocument(brief: string, data: ContentData = {}): Doc {
  const info = analyzeBrief(brief);
  const t = L(info.lang);
  const s = info.subject;
  const k = (i: number, f: string) => cap(kw(info, i, f));
  const kind = detectDocKind(brief);
  const ph = t("[add figure]", "[lägg till siffra]");
  const src = t("[add source]", "[lägg till källa]");
  const sections: DocSection[] = [];
  const disclaimer = {
    type: "callout" as const, tone: "info" as const, title: t("Draft structure", "Utkast"),
    text: t("This document was assembled by Forge's rule-based mock generator. Bracketed placeholders mark facts that must be filled in from real sources.", "Dokumentet är sammanställt av Forges regelbaserade mock-generator. Platshållare inom hakparentes ska fyllas i med uppgifter från riktiga källor."),
  };
  if (kind === "market-analysis") {
    const segments = data.segments?.length
      ? data.segments.map((sg) => [sg.name, sg.needs ?? "—", sg.size ?? ph, sg.growth ?? ph])
      : [info.audience ? cap(info.audience) : t("[Primary segment]", "[Primärt segment]"), t("[Segment 2]", "[Segment 2]"), t("[Segment 3]", "[Segment 3]")].map((name) => [name, t("[describe needs]", "[beskriv behov]"), ph, ph]);
    const competitors = data.competitors?.length ? data.competitors : [t("[Competitor A]", "[Konkurrent A]"), t("[Competitor B]", "[Konkurrent B]"), t("[Competitor C]", "[Konkurrent C]")];
    sections.push(
      { id: "executive-summary", heading: t("Executive summary", "Sammanfattning"), level: 1, blocks: [
        { type: "paragraph", text: t(`This analysis covers the market for ${s}${info.description ? ` (${info.description})` : ""}: its size, customer segments, competitors, trends and risks, ending with recommendations.`, `Analysen omfattar marknaden för ${s}${info.description ? ` (${info.description})` : ""}: storlek, kundsegment, konkurrenter, trender och risker, samt rekommendationer.`) },
        disclaimer,
        { type: "image", image: { prompt: `Editorial cover illustration for a market analysis of ${s}`, alt: t(`Cover illustration: ${s} market`, `Omslagsbild: marknaden för ${s}`) }, caption: t("Illustration", "Illustration") },
      ] },
      { id: "market-size", heading: t("Market size", "Marknadsstorlek"), level: 1, blocks: [
        { type: "paragraph", text: t("Market size is estimated top-down (industry reports) and bottom-up (target customers × price).", "Marknadsstorleken uppskattas top-down (branschrapporter) och bottom-up (målkunder × pris).") },
        { type: "table", caption: t("Market size estimates", "Uppskattad marknadsstorlek"), headers: [t("Metric", "Mått"), t("Value", "Värde"), t("Source", "Källa")], rows: [["TAM", ph, src], ["SAM", ph, src], ["SOM", ph, src]] },
        ...(data.charts?.[0] ? [{ type: "chart" as const, chart: data.charts[0], caption: data.charts[0].title }] : []),
      ] },
      { id: "segments", heading: t("Customer segments", "Kundsegment"), level: 1, blocks: [
        { type: "table", headers: [t("Segment", "Segment"), t("Needs", "Behov"), t("Size", "Storlek"), t("Growth", "Tillväxt")], rows: segments },
      ] },
      { id: "competitors", heading: t("Competitive landscape", "Konkurrenslandskap"), level: 1, blocks: [
        { type: "table", headers: [t("Competitor", "Konkurrent"), t("Positioning", "Positionering"), t("Strengths", "Styrkor"), t("Weaknesses", "Svagheter")], rows: competitors.map((c) => [c, t("[describe]", "[beskriv]"), t("[describe]", "[beskriv]"), t("[describe]", "[beskriv]")]) },
        { type: "paragraph", text: t(`${s} should differentiate on what ${info.audience ?? "its customers"} value most: [describe differentiators].`, `${s} bör differentiera sig på det som ${info.audience ?? "kunderna"} värderar mest: [beskriv skillnader].`) },
      ] },
      { id: "trends", heading: t("Trends", "Trender"), level: 1, blocks: [{ type: "paragraph", text: t("Three trends shape the market:", "Tre trender formar marknaden:") }] },
      ...[0, 1, 2].map((i): DocSection => ({ id: `trend-${i + 1}`, heading: `${i + 1}. ${[t("Technology shifts", "Teknikskiften"), t(`Changing ${info.audience ?? "customer"} expectations`, `Förändrade förväntningar hos ${info.audience ?? "kunder"}`), t("Regulation and sustainability", "Reglering och hållbarhet")][i]}`, level: 2, blocks: [{ type: "bullets", items: [t("What is changing: [describe]", "Vad som förändras: [beskriv]"), t(`Impact on ${s}: [describe]`, `Påverkan på ${s}: [beskriv]`)] }] })),
      { id: "risks", heading: t("Risks", "Risker"), level: 1, blocks: [
        { type: "numbered", items: [t("Market adoption slower than expected", "Långsammare marknadsacceptans än väntat"), t("Competitive response from incumbents", "Motreaktion från etablerade aktörer"), t("Regulatory or pricing pressure", "Regulatoriskt tryck eller prispress")] },
        { type: "callout", tone: "warning", title: t("Validate assumptions", "Validera antaganden"), text: t("Every placeholder figure must be validated before decisions are made.", "Alla platshållarsiffror måste valideras innan beslut fattas.") },
      ] },
      { id: "recommendations", heading: t("Recommendations", "Rekommendationer"), level: 1, blocks: [
        { type: "numbered", items: [t(`Focus first on the ${segments[0]?.[0] ?? "primary"} segment`, `Fokusera först på segmentet ${segments[0]?.[0] ?? "primärt"}`), t("Run pricing experiments with early customers", "Testa prissättning med tidiga kunder"), t("Track competitors quarterly", "Följ upp konkurrenter kvartalsvis")] },
      ] },
      { id: "methodology", heading: t("Methodology & sources", "Metod & källor"), level: 3, blocks: [{ type: "paragraph", text: t("Desk research and interviews; list all sources here.", "Skrivbordsstudier och intervjuer; lista alla källor här.") }] },
    );
  } else {
    sections.push(
      { id: "summary", heading: t("Summary", "Sammanfattning"), level: 1, blocks: [{ type: "paragraph", text: t(`This report covers ${s}.`, `Rapporten handlar om ${s}.`) }, disclaimer] },
      { id: "background", heading: t("Background", "Bakgrund"), level: 1, blocks: [{ type: "paragraph", text: t(`Context for ${kw(info, 0, "the topic")}.`, `Bakgrund till ${kw(info, 0, "ämnet")}.`) }, { type: "image", image: { prompt: `Illustration for a report about ${s}`, alt: s } }] },
      { id: "findings", heading: t("Findings", "Resultat"), level: 1, blocks: [
        { type: "bullets", items: info.keywords.slice(0, 4).map((x) => `${cap(x)}: ${t("[finding]", "[resultat]")}`).concat(info.keywords.length ? [] : [t("[finding]", "[resultat]")]) },
        { type: "table", headers: [t("Area", "Område"), t("Status", "Status"), t("Comment", "Kommentar")], rows: [0, 1, 2].map((i) => [k(i, t(`Area ${i + 1}`, `Område ${i + 1}`)), ph, "—"]) },
        ...(data.charts?.[0] ? [{ type: "chart" as const, chart: data.charts[0], caption: data.charts[0].title }] : []),
      ] },
      { id: "next-steps", heading: t("Next steps", "Nästa steg"), level: 2, blocks: [{ type: "numbered", items: [t("Decide owners", "Utse ansvariga"), t("Set timeline", "Sätt tidplan"), t("Follow up", "Följ upp")] }] },
    );
  }
  return {
    title: kind === "market-analysis" ? t(`Market analysis: ${s}`, `Marknadsanalys: ${s}`) : t(`Report: ${s}`, `Rapport: ${s}`),
    subtitle: info.description ? cap(info.description) : undefined,
    author: "Forge",
    sections,
    meta: { generator: "rule-based mock (LLM_PROVIDER=mock)", kind, lang: info.lang },
  };
}
