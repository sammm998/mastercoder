import type { Intent, IntentKind, PromptSource } from "@forge/shared";
import type { StepComplexity } from "@forge/llm";

export type Language = "sv" | "en";
export type AmbiguityReason = "no_deliverable" | "alternatives" | "underspecified";

export interface Attachment {
  name: string;
  mimeType?: string;
  /** Extracted text (transcript, document excerpt) — classified together with the prompt. */
  text?: string;
}

export interface Quantities {
  mediaSeconds?: number;
  images?: number;
  slides?: number;
}

export interface RuleClassification {
  language: Language;
  intents: Intent[];
  ambiguous: boolean;
  ambiguityReason?: AmbiguityReason;
  question?: string;
  options?: string[];
  complexity: StepComplexity;
  quantities: Quantities;
}

// ---------------------------------------------------------------------------------------------
// Pattern helpers: Unicode-aware word boundaries (\b does not treat å/ä/ö as letters).
const B = "(?<![\\p{L}\\p{N}])";
const E = "(?![\\p{L}\\p{N}])";
/** Whole word(s). */
const w = (p: string) => new RegExp(`${B}(?:${p})${E}`, "iu");
/** Word ending (Swedish compounds: "bokningssystem", "produktbilder", "att-göra-app"). */
const suffix = (p: string) => new RegExp(`(?:${p})${E}`, "iu");

interface Signal {
  re: RegExp;
  weight: number;
  hint?: string;
  /** Generic app words ("app") are absorbed by mobile; specific ones ("dashboard", "CRM") are not. */
  generic?: boolean;
  tag?: string;
  /** Skip when the whole token containing the match is one of these (e.g. "whatsapp" is not an app). */
  exclude?: RegExp;
}

const BRANDS: Array<[string, string]> = [
  ["hubspot", "hubspot"],
  ["gmail", "gmail"],
  ["google sheets|google-sheets|google kalkylark|kalkylark", "google_sheets"],
  ["google calendar|google kalender|google-kalender", "google_calendar"],
  ["google drive", "google_drive"],
  ["notion", "notion"],
  ["github|gitlab", "github"],
  ["stripe", "stripe"],
  ["klarna", "klarna"],
  ["swish", "swish"],
  ["fortnox", "fortnox"],
  ["visma", "visma"],
  ["airtable", "airtable"],
  ["salesforce", "salesforce"],
  ["outlook", "outlook"],
  ["shopify", "shopify"],
  ["jira", "jira"],
  ["trello", "trello"],
  ["asana", "asana"],
  ["pipedrive", "pipedrive"],
  ["mailchimp", "mailchimp"],
  ["sendgrid", "sendgrid"],
  ["twilio", "twilio"],
  ["zendesk", "zendesk"],
  ["intercom", "intercom"],
  ["dropbox", "dropbox"],
  ["calendly", "calendly"],
  ["zoom", "zoom"],
];
/** Chat platforms double as agent deployment channels. */
const CHANNEL_BRANDS: Array<[string, string]> = [
  ["slack", "slack"],
  ["microsoft teams|ms teams|teams-kanal(?:en)?|teams-chatt(?:en)?", "teams"],
  ["discord", "discord"],
  ["whatsapp", "whatsapp"],
  ["telegram", "telegram"],
];

const BUILD_VERBS = w(
  "build|create|make|generate|design|develop|write|draft|produce|draw|paint|illustrate|put together|rita|måla|illustrera|set ?up|launch|code|implement|i need|i want|we need|we want|give me|help me (?:build|make|create)|bygg|bygga|skapa|gör|göra|generera|designa|utveckla|skriv|skriva|ta fram|sätt upp|sätta upp|jag vill ha|jag behöver|vi behöver|vi vill ha|fixa|programmera|koda|tillverka|producera",
);
/** Openers that make a question on their own vs. ones that only do with a question mark ("When a new lead arrives, ..."). */
const QUESTION_START = /^\s*(?:what|what's|how|why|who|which|explain|tell me|vad|hur|varför|vem|vilken|vilket|vilka|förklara|berätta)(?![\p{L}])/iu;
const WEAK_QUESTION_START = /^\s*(?:when|where|can|could|is|are|does|do|did|should|would|will|när|var|kan|är|finns|bör|ska|skulle)(?![\p{L}])/iu;
const REQUEST_IN_QUESTION = w("(?:can|could|would|will) you (?:please )?(?:build|make|create|generate|design|write|set up|develop)|kan du (?:snälla )?(?:bygga|göra|skapa|generera|designa|skriva|ta fram|sätta upp)|skulle du kunna (?:bygga|göra|skapa|skriva)");
const MEETING_REF = w("what we discussed|as discussed|discussed in the meeting|from the meeting|from our meeting|det vi (?:pratade|diskuterade) om|det vi diskuterade|från mötet|enligt mötet|som vi pratade om");

const SIGNALS: Record<Exclude<IntentKind, "question">, Signal[]> = {
  website: [
    { re: w("landing[- ]?pages?|landningssid(?:a|an|or|orna)"), weight: 0.95, hint: "landing" },
    { re: w("portfolio(?:s|n|sida|sidan|site|sajt)?"), weight: 0.92, hint: "portfolio" },
    { re: w("web ?sites?|webbplats(?:en|er)?|webbsid(?:a|an|or)|hemsid(?:a|an|or)|sajt(?:en|er)?|homepage|home page|one[- ]?pager|marketing site|microsite"), weight: 0.92 },
    { re: w("site"), weight: 0.85 },
    { re: w("(?:sign ?up|signup|newsletter|contact|about|pricing|order|registration|waitlist|wait-list|coming soon|thank you|product|sales|event|campaign) pages?|(?:kontakt|registrerings|produkt|event|anmälnings|försäljnings|kampanj)sid(?:a|an|or)"), weight: 0.88 },
    { re: w("blog(?:g|gen|gar)?|blogs"), weight: 0.9, hint: "blog", exclude: /^blogg?(?:inlägg\w*|post\w*)$/i },
    { re: w("webb?shop(?:en)?|web shop|nätbutik(?:en)?|e-?handel|online store|e-?commerce(?: store| site)?"), weight: 0.8, hint: "shop" },
    { re: w("cms"), weight: 0.6 },
    { re: w("sitemap|seo"), weight: 0.45 },
  ],
  app: [
    { re: suffix("app|appen|appar|apparna|apps"), weight: 0.85, generic: true, exclude: /^(?:whatsapp|kidnapp\w*)$/i },
    { re: w("(?:web )?applications?|applikation(?:en|er)?"), weight: 0.85, generic: true },
    { re: w("web ?app(?:s|en)?|webbapp(?:en|ar)?|saas|crm(?:-system)?|erp|dashboards?|instrumentpanel(?:en)?|admin ?panel(?:en)?|admin dashboard|internal tools?|intern(?:t|a)? (?:verktyg|system)|kanban|todo|to-do|att-göra|portal(?:en)?|admin ?(?:ui|interface|gränssnitt)|back ?office|adminpanel(?:en)?|booking system|scheduling system|inventory system|ticketing system|habit tracker|tracker"), weight: 0.9 },
    { re: suffix("system|systemet|systems"), weight: 0.85, exclude: /^(?:eco-?systems?|ekosystem\w*|operativsystem\w*|solsystem\w*|operating-systems?)$/i },
    { re: w("tool|verktyg(?:et)?"), weight: 0.6 },
    { re: w("sign ?up|signup|log ?in|login|logga in|inloggning|authentication|user accounts|användarkonton"), weight: 0.45 },
    { re: w("crud"), weight: 0.45 },
  ],
  mobile: [
    { re: w("expo|react native"), weight: 0.97, hint: "expo" },
    { re: w("ios|android|iphone|ipad|app store|play store|testflight"), weight: 0.93, hint: "expo" },
    { re: suffix("mobilapp|mobilappen|mobilappar"), weight: 0.95, hint: "expo" },
    { re: w("mobile app(?:s|lication)?|mobil app(?:en)?|native app|smartphone app|phone app"), weight: 0.95, hint: "expo" },
  ],
  backend: [
    { re: w("fastapi|django|flask|python api"), weight: 0.95, hint: "fastapi" },
    { re: w("hono|express(?:\\.js|js)?(?: server| api)|node(?:\\.js)? api|typescript api"), weight: 0.93, hint: "hono" },
    { re: w("back-?end|backend-?tjänst|rest ?api|graphql(?: api)?|microservices?|mikrotjänst(?:er)?|api (?:service|server)|api-tjänst"), weight: 0.9 },
    { re: w("endpoints?|crud endpoints|api endpoints"), weight: 0.75 },
    { re: /(?:build|create|make|write|develop|design|bygg|skapa|gör|utveckla|need|behöver)\s+(?:me\s+)?(?:a|an|ett|en)?\s*(?:[\p{L}-]+\s+){0,3}?api(?![\p{L}])/iu, weight: 0.88 },
  ],
  image: [
    { re: w("images?|pictures?|photos?|photographs?|foto(?:n|t|na)?|illustrations?|illustration(?:er|en)?|posters?|affisch(?:er)?|banners?|wallpapers?|avatars?|product shots?|artwork"), weight: 0.9 },
    { re: suffix("bild|bilden|bilder|bilderna"), weight: 0.88, tag: "bild", exclude: /^(?:förebild\w*|sinnebild\w*|helhetsbild\w*|lägesbild\w*)$/i },
    { re: w("logo(?:s|type|typer|n)?|logga(?:n)?|icons?|ikon(?:er)?"), weight: 0.85, hint: "logo" },
    { re: w("mascots?|maskot(?:en|ar)?|cartoons?|drawings?|teckning(?:ar|en)?|sketch(?:es)?|skiss(?:er)?|stickers?|klistermärken?|thumbnails?|emojis?"), weight: 0.85 },
  ],
  video: [
    { re: suffix("video|videon|videos|videor|videoklipp|film|filmen|filmer|filmklipp"), weight: 0.92 },
    { re: w("movie|reels?|trailer|explainer|motion graphics|animerad (?:film|video)|animated video"), weight: 0.9 },
    { re: w("clip|clips"), weight: 0.65 },
  ],
  slides: [
    { re: w("slides?|slide ?deck|pitch ?deck|pitchdeck|decks?|presentation(?:s|en|er|erna)?|bildspel(?:et)?|keynote|powerpoint|pptx|google slides"), weight: 0.95 },
  ],
  document: [
    { re: w("reports?|rapport(?:en|er)?|documents?|dokument(?:et|en)?|whitepapers?|white paper|pdf|docx|word document|word-dokument|memo|business plan|affärsplan(?:en)?|proposals?|offert(?:en|er)?|essay|uppsats(?:en)?|articles?|artikel|artikeln|blog post|blogginlägg(?:et)?|cv|resumé|resume|contract|avtal(?:et)?|kontrakt|policy document|guide document|handout"), weight: 0.9 },
    { re: w("documentation|dokumentation(?:en)?"), weight: 0.6, tag: "docs" },
  ],
  agent: [
    { re: w("agent(?:s|en|er|erna)?|ai-agent(?:en)?|bot(?:s|ten|ar)?|chat ?bot(?:s)?|chattbot(?:ten)?"), weight: 0.92, hint: "chat" },
    { re: w("assistant|assistent(?:en)?"), weight: 0.6, hint: "chat" },
    {
      re: w(
        "every (?:day|morning|evening|night|week|weekday|month|hour|quarter|(?:\\d+|other) (?:minutes?|hours?|days?|weeks?)|monday|tuesday|wednesday|thursday|friday|saturday|sunday)|each (?:day|morning|evening|week|month|hour|monday|tuesday|wednesday|thursday|friday|saturday|sunday)|varje (?:dag|morgon|kväll|natt|vecka|månad|timme|vardag|kvart|måndag|tisdag|onsdag|torsdag|fredag|lördag|söndag)|varannan (?:dag|vecka)|dagligen|veckovis|nightly|hourly|daily at|weekly (?:summary|report|digest|email|update)|daily (?:summary|report|digest|email|update|briefing)|on a schedule|scheduled (?:job|task|run|email|report|post)s?|schemalägg(?:a|d|s)?|schemalagd|cron(?:job|-jobb)?",
      ),
      weight: 0.9,
      hint: "cron",
    },
    { re: w("webhooks?"), weight: 0.85, hint: "webhook" },
    { re: /(?<![\p{L}])(?:when(?:ever)?|each time|every time|när(?:helst)?|varje gång)\s+(?:a|an|new|someone|somebody|en|ett|någon|nya?)\s+(?:[\p{L}-]+\s+){0,5}?(?:arrives?|comes? in|is created|signs? up|is added|lands|is submitted|kommer in|skapas|registrerar|läggs till|skickas in)/iu, weight: 0.88, hint: "webhook" },
    { re: w("automate|automates|automation|automatisera|automatiserar|automatisering"), weight: 0.7 },
  ],
  integration: [
    { re: w("integrations?|integrate(?:s|d)?|integrera(?:r|d|t|s)?|integrering(?:en)?"), weight: 0.9 },
    { re: w("koppla(?:r|s|d)?|koppling(?:en|ar)?|synka(?:r|s)?|synkronisera(?:r)?"), weight: 0.8 },
    { re: w("connect(?:s|ed)? (?:it )?(?:to|with)|sync(?:s|ed)? (?:to|with)"), weight: 0.45 },
    { re: w("openapi (?:spec(?:ification)?|schema|json|yaml|file|fil(?:en)?|definition)|swagger(?: spec| file| json)?|openapi\\.(?:json|ya?ml)"), weight: 0.95, hint: "openapi" },
    { re: /[\w./-]+\.(?:json|ya?ml)(?![\p{L}])/iu, weight: 0.7, hint: "openapi", tag: "specfile" },
    { re: /(?<![\p{L}])(?:using|use|via|with|through|from|against|med|via|använd(?:er|a)?|från|mot)\s+(?:this|the|their|that|our|my|an?|external|detta|denna|det här|deras|vårt|vår|mitt|min|ett|en|extern(?:t|a)?)?\s*(?:[\p{L}-]+\s+){0,2}?api(?:et|er)?(?![\p{L}])/iu, weight: 0.88, tag: "use-api" },
    { re: w("api[- ]?(?:key|keys|token)|api-?nyckel(?:n)?|api nyckel|third[- ]party api|external api|extern(?:t|a)? api|public api"), weight: 0.85 },
    { re: w("mcp(?: server| servers|-server)?|model context protocol"), weight: 0.9, hint: "mcp" },
  ],
};

const STOP = new Set(
  "a an the this that these those my our your their its to of for in on at by with and or but is are be me us it i we you som och att en ett den det de jag vi du ni min mitt mina vår vårt våra er ert till för på i av med om eller men är vara mig oss please snälla some något någon new ny nytt nya".split(" "),
);
const DELIVERABLE_WORDS = /^(?:app|appen|apps|application|website|site|sajt|hemsida|webbplats|landing|page|video|film|image|images|bild|bilder|picture|slides|deck|presentation|report|rapport|document|dokument|agent|bot|api|backend|mobile|mobilapp|logo|logga|something|thing|grej|något)$/i;

const NUMBER_WORDS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, fifteen: 15, twenty: 20,
  två: 2, tre: 3, fyra: 4, fem: 5, sex: 6, sju: 7, åtta: 8, nio: 9, tio: 10, elva: 11, tolv: 12, femton: 15, tjugo: 20,
};
const NUM = `(\\d+|${Object.keys(NUMBER_WORDS).join("|")})`;
const num = (s: string): number => (/^\d+$/.test(s) ? Number(s) : (NUMBER_WORDS[s.toLowerCase()] ?? Number.NaN));

const SV_WORDS = new Set("och att en ett jag vi som för med på är det till hur vad bygg bygga skapa gör göra där kan vill ha inte eller av om mitt min vår våra varje ska också alla från efter vecka dag sida sidan appen hemsida kunder ny nya".split(" "));
const EN_WORDS = new Set("the and a an to for with of is that my our build create make every where can i we which from after week day page customers new this it as on in".split(" "));

export function detectLanguage(text: string): Language {
  const words = text.toLowerCase().match(/[\p{L}]+/gu) ?? [];
  let sv = 0;
  let en = 0;
  for (const t of words) {
    if (/[åäö]/.test(t)) sv += 2;
    if (SV_WORDS.has(t)) sv++;
    if (EN_WORDS.has(t)) en++;
  }
  return sv > en ? "sv" : "en";
}

function sentenceAround(text: string, index: number): string {
  const start = Math.max(text.lastIndexOf(".", index - 1), text.lastIndexOf("!", index - 1), text.lastIndexOf("?", index - 1), text.lastIndexOf("\n", index - 1)) + 1;
  const ends = [".", "!", "?", "\n"].map((c) => text.indexOf(c, index)).filter((i) => i >= 0);
  const end = ends.length ? Math.min(...ends) : text.length;
  return text.slice(start, end).trim().replace(/\s+/g, " ").slice(0, 140);
}

interface Hit {
  kind: Exclude<IntentKind, "question">;
  weight: number;
  index: number;
  /** Start of the word containing the match (suffix matches inside compounds: "boknings|system"). */
  start: number;
  match: string;
  hint?: string;
  generic?: boolean;
  tag?: string;
}

function tokenStart(text: string, index: number): number {
  let a = index;
  while (a > 0 && /[\p{L}\p{N}-]/u.test(text[a - 1]!)) a--;
  return a;
}

/** The whole whitespace-delimited token containing text[index, index+len). */
function tokenAt(text: string, index: number, len: number): string {
  let b = index + len;
  while (b < text.length && /[\p{L}\p{N}-]/u.test(text[b]!)) b++;
  return text.slice(tokenStart(text, index), b);
}

/** Text before the word containing the hit. */
function before(text: string, h: Hit, n = 50): string {
  return text.slice(Math.max(0, h.start - n), h.start);
}

function scan(text: string): Hit[] {
  const hits: Hit[] = [];
  for (const [kind, sigs] of Object.entries(SIGNALS) as Array<[Hit["kind"], Signal[]]>) {
    for (const s of sigs) {
      const g = new RegExp(s.re.source, s.re.flags.includes("g") ? s.re.flags : `${s.re.flags}g`);
      for (const m of text.matchAll(g)) {
        if (s.exclude && s.exclude.test(tokenAt(text, m.index ?? 0, m[0].length))) continue;
        hits.push({ kind, weight: s.weight, index: m.index ?? 0, start: tokenStart(text, m.index ?? 0), match: m[0], ...(s.hint ? { hint: s.hint } : {}), ...(s.generic ? { generic: true } : {}), ...(s.tag ? { tag: s.tag } : {}) });
      }
    }
  }
  for (const [pat, slug] of [...BRANDS, ...CHANNEL_BRANDS]) {
    for (const m of text.matchAll(new RegExp(`${B}(?:${pat})${E}`, "giu"))) hits.push({ kind: "integration", weight: 0.9, index: m.index ?? 0, start: tokenStart(text, m.index ?? 0), match: m[0], hint: slug, tag: CHANNEL_BRANDS.some(([, s]) => s === slug) ? "channel-brand" : "brand" });
  }
  return hits;
}

/** Phrases that reference an existing product ("for my booking app") rather than asking to build one. */
const SUBJECT_REF = /(?<![\p{L}])(?:for|of|about|from|in|into|on|om|för|till|från|i|på|av)\s+(?:my|our|the|their|your|min|mitt|mina|vår|vårt|våra|er|ert|deras|din|ditt)\s+(?:[\p{L}\d-]+\s+){0,3}?(?:app|apps|application|website|site|sajt|hemsida|webbplats|app(?:en)?|tjänst(?:en)?|product|produkt(?:en)?|platform|plattform(?:en)?|shop|webshop|butik)(?![\p{L}])/giu;
/** Image/document words used as features of an app ("upload documents", "ladda upp bilder"). */
const FEATURE_CONTEXT = /(?:upload|uploads|uploading|ladda upp|laddar upp|attach|bifoga|store|lagra|manage|hantera|scan|skanna|import|export|exportera|share|dela|with|med)\s+(?:(?:a|an|the|their|sina|sin|egna|his|her|of)\s+)?(?:[\p{L}-]+,?\s+(?:(?:and|or|och|eller)\s+)?){0,2}$/iu;

const POSSESSIVE_BEFORE = /(?<![\p{L}])(?:my|our|their|your|its|min|mitt|mina|vår|vårt|våra|er|ert|era|deras|din|ditt|dina|sin|sitt|sina)\s+(?:[\p{L}\d-]+\s+){0,3}$/iu;
/** Swedish definite forms point at an existing thing: "på hemsidan", "i appen". */
const DEFINITE_REF = /(?<![\p{L}])(?:på|i|till|från|för|om|av|in|on|to|from|for)\s+(?:[\p{L}-]+\s+){0,2}?(?:hemsidan|appen|webbplatsen|sajten|webbshopen|systemet|plattformen|tjänsten|the (?:website|site|app|platform|system))(?![\p{L}])/giu;
const TOPIC_BEFORE = /(?<![\p{L}])(?:about|on|regarding|for|of|from|om|kring|för|gällande|angående|från|av)\s+(?:[\p{L}\d-]+\s+){0,3}$/iu;
const REFERABLE: ReadonlySet<string> = new Set(["app", "website", "mobile", "backend", "image", "video", "slides", "document"]);
const DELIVERABLE_KINDS: ReadonlySet<string> = new Set([...REFERABLE, "agent"]);
const CONTENT_KINDS: ReadonlySet<string> = new Set(["image", "video", "slides", "document", "agent"]);
const BUILD_TARGET_KINDS: ReadonlySet<string> = new Set(["app", "website", "mobile", "backend"]);

function within(a: { index: number }, ranges: Array<[number, number]>): boolean {
  return ranges.some(([s, e]) => a.index >= s && a.index < e);
}

function contentWords(text: string): string[] {
  return (text.toLowerCase().match(/[\p{L}\d]+(?:-[\p{L}\d]+)*/gu) ?? []).filter((t) => !STOP.has(t) && !DELIVERABLE_WORDS.test(t) && !BUILD_VERBS.test(t) && t.length > 1);
}

function extractQuantities(text: string, kinds: Set<IntentKind>): Quantities {
  const q: Quantities = {};
  if (kinds.has("video")) {
    const s = new RegExp(`${B}${NUM}\\s*-?\\s*(?:s|sec|secs|seconds?|sek|sekund(?:er|ers)?)${E}`, "iu").exec(text);
    const m = new RegExp(`${B}${NUM}\\s*-?\\s*(?:min|mins|minutes?|minut(?:er|ers)?)${E}`, "iu").exec(text);
    const secs = (s ? num(s[1]!) : 0) + (m ? num(m[1]!) * 60 : 0);
    if (secs > 0) q.mediaSeconds = secs;
  }
  if (kinds.has("slides")) {
    const s = new RegExp(`${B}${NUM}\\s*-?\\s*(?:slides?|sidor|bilder|slajdar)${E}`, "iu").exec(text);
    if (s && num(s[1]!) > 0) q.slides = num(s[1]!);
  }
  if (kinds.has("image")) {
    const i = new RegExp(`${B}${NUM}\\s+(?:[\\p{L}-]+\\s+){0,3}?(?:images?|pictures?|photos?|logos?|illustrations?|icons?|posters?|banners?|bilder|foton|logotyper|logor|illustrationer|ikoner|[\\p{L}]*bilder)${E}`, "iu").exec(text);
    if (i && num(i[1]!) > 0) q.images = num(i[1]!);
  }
  return q;
}

const FEATURES: RegExp[] = [
  w("sign ?up|signup|log ?in|login|logga in|inloggning|auth(?:entication)?|roles|roller|permissions|behörighet(?:er)?|rls"),
  w("payments?|betalning(?:ar)?|checkout|subscriptions?|prenumeration(?:er)?|stripe|klarna|swish|invoic(?:e|es|ing)|fakturer(?:a|ing)"),
  w("real-?time|realtid|live|chat|chatt|collaborat(?:e|ion|ive)|samarbet(?:a|e)"),
  w("multi-?tenant|organizations|organisationer|workspaces"),
  w("notifications?|notiser|push|påminnelser|reminders?"),
  w("upload(?:s)?|ladda upp|csv|import(?:era)?"),
  w("charts?|graphs?|grafer|diagram|statistik|analytics|reports? per"),
  w("book(?:ing|ings)?|bokning(?:ar)?|boka|time ?slots?|tider|calendar|kalender"),
  w("admin|staff|personal|moderat(?:ion|e)"),
  w("3d|three\\.js|webgl|parallax|scroll (?:animations?|storytelling)"),
  w("multilingual|flerspråkig|i18n|translations?|översättning(?:ar)?"),
  w("search|sök(?:funktion)?|maps?|kart(?:a|or)|offline"),
  w("kanban|pipeline|workflow|arbetsflöde"),
];

function complexityOf(text: string, kinds: Set<IntentKind>): StepComplexity {
  const features = FEATURES.filter((r) => r.test(text)).length;
  const listEntities = (text.match(/[\p{L}]+,\s+[\p{L}]+(?:,\s+[\p{L}]+)*\s+(?:and|och)\s+[\p{L}]+/gu) ?? []).length;
  const simple = w("simple|enkel|enkelt|small|liten|litet|basic|quick|snabb|minimal").test(text);
  const complex = w("complex|komplex|advanced|avancerad|enterprise|in-depth|omfattande|detaljerad|full-featured|production-ready").test(text);
  const build = kinds.has("app") || kinds.has("mobile") || kinds.has("website") || kinds.has("backend");
  if (complex || (build && features + listEntities >= 4)) return "complex";
  if (simple && features === 0) return "trivial";
  return "normal";
}

const KIND_LABEL: Record<Language, Record<IntentKind, string>> = {
  en: { app: "Web app", website: "Website", mobile: "Mobile app", backend: "API / backend", image: "Images", video: "Video", slides: "Slide deck", document: "Document", agent: "Automated agent", integration: "Integration", question: "Just answer a question" },
  sv: { app: "Webbapp", website: "Webbplats", mobile: "Mobilapp", backend: "API / backend", image: "Bilder", video: "Video", slides: "Presentation", document: "Dokument", agent: "Automatisk agent", integration: "Integration", question: "Bara svara på en fråga" },
};

export function kindLabel(kind: IntentKind, lang: Language): string {
  return KIND_LABEL[lang][kind];
}

function clarification(reason: AmbiguityReason, kinds: IntentKind[], lang: Language): { question: string; options?: string[] } {
  const sv = lang === "sv";
  if (reason === "alternatives") {
    const [a, b] = kinds;
    return { question: sv ? `Ska det bli ${kindLabel(a!, "sv").toLowerCase()} eller ${kindLabel(b!, "sv").toLowerCase()}?` : `Should this be a ${kindLabel(a!, "en").toLowerCase()} or a ${kindLabel(b!, "en").toLowerCase()}?`, options: kinds.map((k) => kindLabel(k, lang)) };
  }
  if (reason === "no_deliverable") {
    return { question: sv ? "Vad vill du att jag ska bygga?" : "What would you like me to build?", options: (["website", "app", "mobile"] as IntentKind[]).map((k) => kindLabel(k, lang)) };
  }
  const k = kinds[0] ?? "app";
  const what = kindLabel(k, lang).toLowerCase();
  if (k === "app" || k === "mobile") {
    return {
      question: sv ? `Vad ska ${what}en göra, och för vem?` : `What should the ${what} do, and who is it for?`,
      options: sv ? ["Bokningssystem", "CRM / kundregister", "Dashboard", "Att-göra-lista"] : ["Booking system", "CRM", "Dashboard", "To-do list"],
    };
  }
  return { question: sv ? `Vad ska ${what} handla om?` : `What should the ${what} be about?` };
}

/**
 * Rule-based multi-label intent classifier (Swedish + English lexicons and patterns). Used as the
 * mock for LLM purpose "intent.classify" and as a fallback when the model output is invalid.
 */
export function classifyByRules(prompt: string, ctx: { source?: PromptSource; attachments?: Attachment[] } = {}): RuleClassification {
  const attachmentText = (ctx.attachments ?? []).map((a) => a.text ?? "").filter(Boolean).join("\n");
  // Parenthesised fixture references ("(Voice prompt: x.wav)") carry no intent.
  const raw = prompt.replace(/\((?:voice prompt|recorded [\p{L}\s]*meeting|röstmeddelande|inspelat möte)[^)]*\)/giu, " ").trim();
  const text = attachmentText ? `${raw}\n${attachmentText.slice(0, 20_000)}` : raw;
  const language = detectLanguage(raw || text);
  const hits = scan(text);

  const hasBuildVerb = BUILD_VERBS.test(raw) || REQUEST_IN_QUESTION.test(raw);
  // References to existing things ("for my booking app", "vår webbshop", "our blog posts") and topics
  // ("a whitepaper for SaaS companies") are not requests to build them.
  const subjectRanges: Array<[number, number]> = [...text.matchAll(SUBJECT_REF), ...text.matchAll(DEFINITE_REF)].map((m) => [m.index ?? 0, (m.index ?? 0) + m[0].length]);
  const referenced = new Set(hits.filter((h) => REFERABLE.has(h.kind) && (within(h, subjectRanges) || POSSESSIVE_BEFORE.test(before(text, h)))));
  const freeDeliverable = (k: Hit["kind"], kinds: ReadonlySet<string> = REFERABLE) => hits.some((x) => x.kind !== k && kinds.has(x.kind) && !referenced.has(x));
  let active = hits.filter((h) => {
    if (referenced.has(h) && (!hasBuildVerb || freeDeliverable(h.kind, DELIVERABLE_KINDS))) return false;
    if (BUILD_TARGET_KINDS.has(h.kind) && TOPIC_BEFORE.test(before(text, h)) && freeDeliverable(h.kind, CONTENT_KINDS)) return false;
    return true;
  });

  const has = (k: Hit["kind"]) => active.some((h) => h.kind === k);
  // "How do I build X?" is a question; "Can you build X?" is a request; "Build X. Can it be dark?" is a request.
  const isQuestion = !REQUEST_IN_QUESTION.test(raw) && (QUESTION_START.test(raw) || (WEAK_QUESTION_START.test(raw) && raw.includes("?")) || (/\?\s*$/.test(raw) && !hasBuildVerb));

  // Mobile absorbs generic "app" words ("Expo mobile app"); specific web-app nouns stay.
  if (has("mobile")) active = active.filter((h) => !(h.kind === "app" && h.generic));
  // "mobile-friendly" websites are not mobile apps.
  if (/mobile[- ]?(?:friendly|responsive|first)|mobilanpassad|responsiv/iu.test(text)) active = active.filter((h) => !(h.kind === "mobile" && /^mobil/i.test(h.match)));
  // Video calls/meetings are not video deliverables.
  active = active.filter((h) => !(h.kind === "video" && /video\s?(?:call|calls|conference|meeting|samtal|möte)|videosamtal|videomöte/iu.test(text.slice(h.index, h.index + 20))));
  // Swedish "bilder" counts slides inside a presentation.
  if (has("slides")) active = active.filter((h) => !(h.kind === "image" && h.tag === "bild"));
  // Image/document words that describe app features ("upload documents", "med bilder") when something else is built.
  const building = has("app") || has("website") || has("mobile") || has("backend") || has("agent");
  if (building) {
    active = active.filter((h) => {
      if (h.kind !== "image" && h.kind !== "document") return true;
      if (FEATURE_CONTEXT.test(before(text, h, 40))) return false;
      if (h.kind === "document" && h.tag === "docs") return false; // "OpenAPI docs/documentation" of the thing being built
      return true;
    });
    // An "API" produced by a backend build ("OpenAPI docs") vs. an external API to use.
  }
  // Backend vs integration: "using this API" is an integration, not a backend build.
  const usesApi = active.some((h) => h.tag === "use-api");
  if (usesApi) active = active.filter((h) => !(h.kind === "backend" && /api/i.test(h.match) && !/fastapi|hono|backend|graphql|rest|micro|endpoint/i.test(h.match)));
  // Spec files only count as integration when an API/spec is mentioned.
  if (!/api|openapi|swagger|spec/i.test(text)) active = active.filter((h) => h.tag !== "specfile");
  // Chat platforms used as the agent's deployment channel ("Slack agent", "bot in #help") are not integrations.
  if (has("agent")) {
    active = active.filter((h) => {
      if (h.tag !== "channel-brand") return true;
      const around = text.slice(Math.max(0, h.index - 40), h.index + h.match.length + 40);
      const m = h.match.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const asChannel = new RegExp(
        `(?:${m})[- ]?(?:agent|bot|assistant|assistent|app|kanal(?:en)?|channel|workspace|arbetsyta)|(?:in|on|for|i|på|för|via)\\s+(?:(?:our|my|the|a|vår|vårt|min|mitt|er|ert)\\s+)?(?:${m})|#[\\p{L}\\d-]+`,
        "iu",
      );
      const asAction = /(?:post|posts|posting|send|sends|notify|message|skicka|skickar|posta|postar|meddela|notifiera)\s+(?:[\p{L}#-]+\s+){0,4}?(?:to|in|on|till|i|på)?\s*$/iu.test(before(text, h));
      return asAction || !asChannel.test(around);
    });
  }
  // "integration" only via a brand used as a chat channel was dropped; webhooks belong to agents.

  // Score per kind: strongest signal + small boost per extra distinct signal.
  const byKind = new Map<Hit["kind"], Hit[]>();
  for (const h of active) byKind.set(h.kind, [...(byKind.get(h.kind) ?? []), h]);
  let intents: Intent[] = [];
  for (const [kind, hs] of byKind) {
    const max = Math.max(...hs.map((h) => h.weight));
    const distinct = new Set(hs.map((h) => h.match.toLowerCase())).size;
    const confidence = Math.min(0.98, max + 0.03 * (distinct - 1));
    if (confidence < 0.5) continue;
    const best = hs.reduce((a, b) => (b.weight > a.weight ? b : a));
    let hint: string | undefined;
    if (kind === "integration") {
      const slugs = [...new Set(hs.filter((h) => h.tag === "brand" || h.tag === "channel-brand").map((h) => h.hint!))];
      hint = hs.some((h) => h.hint === "openapi") ? "openapi" : hs.some((h) => h.hint === "mcp") ? "mcp" : slugs.length ? slugs.join(",") : undefined;
    } else if (kind === "video") {
      hint = /product (?:video|demo|film)|produkt(?:video|film|demo)|screenshots?|skärmdump(?:ar)?|skärmbild(?:er)?|brand|varumärke|logo animation|promo|explainer|motion graphics|kinetic|text animation|data(?:-| )video|from (?:my|our) (?:app|site|website)|för (?:min|mitt|vår|vårt) (?:app|tjänst|produkt)/iu.test(text) ? "remotion" : "generative";
    } else if (kind === "backend") {
      hint = hs.find((h) => h.hint)?.hint ?? (/python/i.test(text) ? "fastapi" : "hono");
    } else if (kind === "agent") {
      hint = hs.find((h) => h.hint === "cron")?.hint ?? hs.find((h) => h.hint === "webhook")?.hint ?? (/email|e-post|mejl|inbox|inkorg/iu.test(text) && /arrive|kommer in|incoming|inkommande/iu.test(text) ? "email" : hs.find((h) => h.hint)?.hint);
    } else {
      hint = hs.find((h) => h.hint)?.hint;
    }
    intents.push({ kind, confidence: Math.round(confidence * 100) / 100, summary: sentenceAround(text, best.index), ...(hint ? { hint } : {}) });
  }

  const deliverables: IntentKind[] = ["app", "website", "mobile", "backend", "image", "video", "slides", "document", "agent"];
  const hasDeliverable = intents.some((i) => deliverables.includes(i.kind));
  let ambiguous = false;
  let ambiguityReason: AmbiguityReason | undefined;

  if (isQuestion) {
    intents = [{ kind: "question", confidence: 0.9, summary: raw.slice(0, 140) }];
  } else if (!hasDeliverable) {
    if ((ctx.source === "meeting" || MEETING_REF.test(text)) && hasBuildVerb) {
      intents = [{ kind: "app", confidence: 0.7, summary: sentenceAround(text, 0), hint: "from-meeting" }, ...intents];
    } else if (hasBuildVerb) {
      ambiguous = true;
      ambiguityReason = "no_deliverable";
      intents = [{ kind: "app", confidence: 0.35, summary: raw.slice(0, 140) }, ...intents.map((i) => ({ ...i, confidence: Math.min(i.confidence, 0.5) }))];
    } else if (intents.length === 0) {
      intents = [{ kind: "question", confidence: 0.6, summary: raw.slice(0, 140) }];
    }
  }

  // Explicit alternatives: "a website or an app", "hemsida eller app".
  if (!ambiguous && intents.length > 1) {
    const alt = new RegExp(`(${hits.filter((h) => deliverables.includes(h.kind)).map((h) => h.match.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})\\s+(?:or|eller)\\s+(?:(?:a|an|en|ett|maybe|kanske)\\s+)?(?:[\\p{L}-]+\\s+){0,2}?(${hits.filter((h) => deliverables.includes(h.kind)).map((h) => h.match.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`, "iu");
    const m = hits.some((h) => deliverables.includes(h.kind)) ? alt.exec(text) : null;
    if (m) {
      const k1 = hits.find((h) => h.match.toLowerCase() === m[1]!.toLowerCase() && deliverables.includes(h.kind))?.kind;
      const k2 = hits.find((h) => h.match.toLowerCase() === m[2]!.toLowerCase() && deliverables.includes(h.kind))?.kind;
      if (k1 && k2 && k1 !== k2) {
        ambiguous = true;
        ambiguityReason = "alternatives";
        intents = intents.map((i) => (i.kind === k1 || i.kind === k2 ? { ...i, confidence: 0.5 } : i));
        intents.sort((a, b) => (a.kind === k1 ? -1 : b.kind === k1 ? 1 : a.kind === k2 ? -1 : b.kind === k2 ? 1 : 0));
      }
    }
  }

  // Underspecified: a deliverable with (almost) no description ("Bygg en app", "Make a video").
  if (!ambiguous && hasDeliverable && !isQuestion && ctx.source !== "meeting" && !attachmentText) {
    const words = contentWords(raw);
    if (words.length < 1 && !MEETING_REF.test(raw)) {
      ambiguous = true;
      ambiguityReason = "underspecified";
      intents = intents.map((i) => ({ ...i, confidence: Math.min(i.confidence, 0.45) }));
    }
  }

  intents.sort((a, b) => b.confidence - a.confidence);
  const kinds = new Set(intents.map((i) => i.kind));
  const result: RuleClassification = { language, intents, ambiguous, complexity: complexityOf(text, kinds), quantities: extractQuantities(text, kinds) };
  if (ambiguous && ambiguityReason) {
    result.ambiguityReason = ambiguityReason;
    const c = clarification(ambiguityReason, ambiguityReason === "alternatives" ? intents.filter((i) => i.confidence === 0.5).map((i) => i.kind).slice(0, 2) : intents.map((i) => i.kind), language);
    result.question = c.question;
    if (c.options) result.options = c.options;
  }
  return result;
}
