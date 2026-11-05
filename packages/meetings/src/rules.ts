/**
 * Rule-based (offline, deterministic) meeting analysis used by the mock LLM handlers in mock-llm.ts.
 * It is NOT a language model: it finds Swedish/English cue phrases ("vi behöver", "den ska kunna",
 * "kunden vill", "vi bestämde", "beslut:", "ska vi …?", "must", "should", "we decided", "action:") and
 * extracts entity hints from nouns in the requirement sentences with suffix-stripping heuristics.
 */
import type { IntentKind } from "@forge/shared";
import type { ActionItem, EntityHint, Extraction, MeetingSpec, Requirement } from "./schemas.js";

export interface Utterance {
  speaker?: string;
  text: string;
}

type Lang = "sv" | "en";
const langOf = (language: string): Lang => (language.toLowerCase().startsWith("en") ? "en" : "sv");

const LABELLED = /^\s*([^:\n]{1,40}?):\s+(.+)$/;

/** "Name: text" lines → utterances (unlabelled lines continue the previous speaker). */
export function parseUtterances(text: string): Utterance[] {
  const out: Utterance[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const m = line.match(LABELLED);
    if (m && !/^(action|beslut|decision|att göra|todo|åtgärd)$/i.test((m[1] as string).trim())) {
      out.push({ speaker: (m[1] as string).trim(), text: (m[2] as string).trim() });
    } else if (out.length) {
      const last = out[out.length - 1] as Utterance;
      last.text = `${last.text} ${line}`;
    } else out.push({ text: line });
  }
  return out;
}

export function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+(?=[\p{Lu}\p{N}"'(])/u)
    .map((s) => s.trim())
    .filter(Boolean);
}

interface Sentence {
  speaker?: string;
  text: string;
  /** Index of the utterance this sentence belongs to. */
  u: number;
}

function sentencesOf(utts: Utterance[]): Sentence[] {
  const out: Sentence[] = [];
  utts.forEach((ut, u) => {
    for (const s of splitSentences(ut.text)) out.push({ speaker: ut.speaker, text: s, u });
  });
  return out;
}

const lc = (s: string) => s.toLocaleLowerCase("sv-SE");

const REQ_CUES: RegExp[] = [
  /\bbehöver\b/,
  /\bska kunna\b/,
  /\bska gå att\b/,
  /\bvill kunna\b/,
  /\bvill få\b/,
  /\b(kunden|kunderna|användaren|användarna|personalen|medlemmarna|besökaren|vi|jag) vill\b/,
  /\bmåste\b/,
  /\bfår (aldrig|inte)\b/,
  /\b(viktigaste|viktigt)\b.*\b(är|blir)\b/,
  /\b(den|det|systemet|appen|sidan|tjänsten|kunden|kunderna|personalen|användaren|en \p{L}+|ett \p{L}+|varje \p{L}+) ska\b/u,
  /\bmust\b/,
  /\bshould\b/,
  /\bshall\b/,
  /\bwe need\b/,
  /\bneeds? to\b/,
  /\b(the )?(customer|client|user|staff|admin)s? (wants?|needs?)\b/,
  /\bable to\b/,
];
const DECISION_CUE = /\b(vi bestämde|vi har bestämt|vi beslutade|beslut:|beslutat|vi kör på|we decided|we have decided|we agreed|decision:|agreed:)/;
const ACTION_PREFIX = /^(action|att göra|todo|to-do|åtgärd)\s*:\s*/i;
const ACTION_CUE = /\b(jag tar fram|jag tar hand om|jag skickar|jag fixar|jag ordnar|jag återkommer med|i'll send|i will send|i'll prepare|i will prepare|i'll set up|i will set up)\b/;
const MUST_CUE = /\b(måste|får aldrig|får inte|aldrig|viktigaste|kritiskt|must|never|critical|shall)\b/;
const COULD_CUE = /\b(gärna|kanske|på sikt|senare|nice to have|could|maybe|later)\b/;
const AFFIRMATIVE = /^(ja|japp|jo|absolut|precis|gärna|självklart|definitivt|yes|yeah|sure|definitely|absolutely|exactly|of course)\b/;
const NEGATIVE = /^(nej|nä|inte nu|no|nope|not now)\b/;
const UNCERTAIN = /\b(vet (jag )?inte|vet ej|osäker|fundera|återkommer|oklart|inte bestämt|får se|not sure|don't know|do not know|tbd|to be decided|need to check|get back)\b/;
const QUESTION_NEED = /\b(ska|behöver|måste|should|need|must|shall|do we|will it)\b/;
const DUE_SV = /\b(senast (?:på |i )?\p{L}+dag(?:en)?|nästa (?:vecka|månad|\p{L}+dag)|(?:på|till|i) (?:måndag|tisdag|onsdag|torsdag|fredag|lördag|söndag)|i ?morgon|i ?dag|innan \p{L}+)\b/u;
const DUE_EN = /\b(by (?:next )?\p{L}+day|next (?:week|month|\p{L}+day)|tomorrow|today|end of (?:the )?(?:week|month)|on (?:monday|tuesday|wednesday|thursday|friday))\b/u;

function cleanEnd(s: string): string {
  return s.replace(/\s+/g, " ").trim().replace(/[.!]+$/, "");
}

/** Drop a leading conjunction ("Och kunden vill …" → "Kunden vill …"). */
function stripConjunction(s: string): string {
  const out = s.replace(/^(och|men|så|samt|and|but|so)\s+/i, "");
  return out === s ? s : capitalize(out);
}

function capitalize(s: string): string {
  return s ? s.charAt(0).toLocaleUpperCase("sv-SE") + s.slice(1) : s;
}
function decapitalize(s: string): string {
  return s ? s.charAt(0).toLocaleLowerCase("sv-SE") + s.slice(1) : s;
}

function inferRole(text: string, lang: Lang): string {
  const t = lc(text);
  const rules: Array<[RegExp, string, string]> = [
    [/\b(personal|personalen|stylist|stylisten|frisör|anställd|medarbetare|staff|employee|stylist)\b/, "personal", "staff member"],
    [/\b(kund|kunden|kunder|kunderna|customer|client)\b/, "kund", "customer"],
    [/\b(medlem|medlemmar|member)\b/, "medlem", "member"],
    [/\b(admin|administratör|ägare|owner)\b/, "administratör", "administrator"],
    [/\b(besökare|visitor)\b/, "besökare", "visitor"],
  ];
  // The grammatical subject wins: "kunden vill …" → kund even if staff is mentioned later.
  let best: { idx: number; role: string } | undefined;
  for (const [re, sv, en] of rules) {
    const m = re.exec(t);
    if (m && (best === undefined || m.index < best.idx)) best = { idx: m.index, role: lang === "sv" ? sv : en };
  }
  return best?.role ?? (lang === "sv" ? "användare" : "user");
}

/** Turn a requirement sentence into a user story with simple cue-specific rewrites. */
export function toUserStory(text: string, language: string): string {
  const lang = langOf(language);
  const role = inferRole(text, lang);
  const t = cleanEnd(text);
  const l = lc(t);
  if (lang === "sv") {
    let m = l.match(/\b(?:kunden|kunderna|användaren|användarna|personalen|medlemmarna|besökaren|vi|jag) vill (kunna .+|få .+|ha .+|.+)$/);
    if (m) return `Som ${role} vill jag ${m[1]}`;
    m = l.match(/\b(?:kunden|kunderna|personalen|användaren|användarna) ska (kunna .+)$/);
    if (m) return `Som ${role} vill jag ${m[1]}`;
    m = l.match(/\b(?:den|det|systemet|appen|sidan) ska (kunna .+|.+)$/);
    if (m) return `Som ${role} vill jag att systemet ska ${m[1]}`;
    m = l.match(/\b(?:vi|jag|ni) behöver (.+)$/);
    if (m) return `Som ${role} vill jag ha ${m[1]}`;
    m = l.match(/\bfår (aldrig|inte) (.+)$/);
    if (m) return `Som ${role} vill jag att det ${m[1]} ska ${m[2] ?? ""}`;
    m = l.match(/^(?:det )?viktigaste (?:blir|är)(?: väl)? att (.+)$/);
    if (m) return `Som ${role} vill jag att ${m[1]}`;
    return `Som ${role} vill jag att: ${decapitalize(t)}`;
  }
  let m = l.match(/\b(?:the )?(?:customers?|clients?|users?|staff|admins?|we|i) (?:wants?|needs?) (?:to )?(.+)$/);
  if (m) return `As a ${role}, I want to ${m[1]}`;
  m = l.match(/\b(?:should|must|shall) be able to (.+)$/);
  if (m) return `As a ${role}, I want to be able to ${m[1]}`;
  m = l.match(/\b(?:it|the system|the app|the site) (?:should|must|shall) (.+)$/);
  if (m) return `As a ${role}, I want the system to ${m[1]}`;
  return `As a ${role}, I want: ${decapitalize(t)}`;
}

function priorityOf(text: string): Requirement["priority"] {
  const l = lc(text);
  if (MUST_CUE.test(l)) return "must";
  if (COULD_CUE.test(l)) return "could";
  return "should";
}

/** "Ska vi skicka en påminnelse …?" → "skicka en påminnelse …" */
function restateQuestion(q: string): string {
  return cleanEnd(q.replace(/\?+$/, ""))
    .replace(/^(så\s+)?(ska|behöver|måste|kan)\s+(vi|ni|den|det|systemet|appen|kunden|personalen|man)\s+/i, "")
    .replace(/^(should|do|must|can|will)\s+(we|you|it|the system|the app|users?)\s+/i, "");
}

export function extractMeeting(transcript: string, language: string): Extraction {
  const lang = langOf(language);
  const utts = parseUtterances(transcript);
  const sents = sentencesOf(utts);
  const speakers = [...new Set(utts.map((u) => u.speaker).filter((s): s is string => Boolean(s)))];
  const decisions: string[] = [];
  const reqs: Array<{ text: string; source?: string; story?: string }> = [];
  const openQuestions: string[] = [];
  const actionItems: ActionItem[] = [];
  const nextUtteranceFromOther = (s: Sentence): Utterance | undefined => {
    for (let i = s.u + 1; i < utts.length; i++) {
      const ut = utts[i] as Utterance;
      if (!s.speaker || ut.speaker !== s.speaker) return ut;
    }
    return undefined;
  };

  for (const s of sents) {
    const l = lc(s.text);
    // Action items
    if (ACTION_PREFIX.test(s.text) || ACTION_CUE.test(l)) {
      const body = cleanEnd(s.text.replace(ACTION_PREFIX, ""));
      let owner: string | undefined;
      const first = body.split(/\s+/)[0]?.replace(/[,:]$/, "");
      if (first && speakers.includes(first)) owner = first;
      else if (/^(jag|i)\b/i.test(body) || ACTION_CUE.test(l)) owner = s.speaker;
      const due = lc(body).match(lang === "sv" ? DUE_SV : DUE_EN)?.[1] ?? lc(body).match(DUE_SV)?.[1] ?? lc(body).match(DUE_EN)?.[1];
      const item: ActionItem = { text: body };
      if (owner) item.owner = owner;
      if (due) item.due = due;
      actionItems.push(item);
      continue;
    }
    // Decisions
    if (DECISION_CUE.test(l)) {
      decisions.push(capitalize(cleanEnd(s.text.replace(/^(beslut|decision|agreed)\s*:\s*/i, ""))));
      continue;
    }
    // Questions: confirmed → requirement; uncertain/unanswered → open question
    if (/\?\s*$/.test(s.text)) {
      const ans = nextUtteranceFromOther(s);
      const ansText = ans ? lc(ans.text) : "";
      if (!ans || UNCERTAIN.test(ansText)) {
        openQuestions.push(s.text.trim());
        continue;
      }
      if (QUESTION_NEED.test(l) && !NEGATIVE.test(ansText)) {
        const answerSentences = splitSentences(ans.text);
        const firstAns = (answerSentences[0] ?? "").replace(AFFIRMATIVE, "").replace(/^[\s,!.]+/, "");
        // Only a bare "ja" → restate the question; otherwise keep the answer's detail.
        const answerHasCue = answerSentences.some((a) => REQ_CUES.some((re) => re.test(lc(a))));
        if (AFFIRMATIVE.test(ansText) && !answerHasCue) {
          const restated = restateQuestion(s.text);
          const detail = firstAns.split(/\s+/).length >= 3 ? ` (${cleanEnd(firstAns)})` : "";
          const role = inferRole(`${s.text} ${ans?.text ?? ""}`, lang);
          const story = lang === "sv" ? `Som ${role} vill jag att systemet ska ${decapitalize(restated)}` : `As a ${role}, I want the system to ${decapitalize(restated)}`;
          reqs.push({ text: capitalize(restated) + detail, source: s.speaker, story });
        } else if (!AFFIRMATIVE.test(ansText) && !answerHasCue) {
          reqs.push({ text: `${cleanEnd(s.text.replace(/\?+$/, ""))}: ${cleanEnd(answerSentences[0] ?? "")}`, source: ans.speaker });
        }
      }
      continue;
    }
    if (UNCERTAIN.test(l) && /\b(om|whether|if)\b/.test(l)) {
      openQuestions.push(s.text.trim());
      continue;
    }
    if (REQ_CUES.some((re) => re.test(l)) && !NEGATIVE.test(l)) reqs.push({ text: stripConjunction(cleanEnd(s.text)), source: s.speaker });
  }

  const seen = new Set<string>();
  const requirements: Requirement[] = [];
  for (const r of reqs) {
    const key = lc(r.text).replace(/[^\p{L}\p{N}]+/gu, " ").trim();
    if (seen.has(key)) continue;
    seen.add(key);
    const req: Requirement = { id: `R${requirements.length + 1}`, text: r.text, userStory: r.story ?? toUserStory(r.text, language), priority: priorityOf(r.text) };
    if (r.source) req.source = r.source;
    requirements.push(req);
  }

  const words = transcript.split(/\s+/).filter(Boolean).length;
  const topics = extractEntities(requirements.map((r) => r.text), transcript, language).slice(0, 4).map((e) => e.name);
  const summary =
    lang === "sv"
      ? `Regelbaserad sammanfattning (mock, ingen språkmodell): mötet mellan ${speakers.join(", ") || "okända talare"} (~${words} ord) handlade om ${topics.join(", ") || "okända ämnen"}. ${requirements.length} krav, ${decisions.length} beslut, ${openQuestions.length} öppna frågor och ${actionItems.length} åtgärder identifierades.`
      : `Rule-based summary (mock, no language model): the meeting between ${speakers.join(", ") || "unknown speakers"} (~${words} words) covered ${topics.join(", ") || "unknown topics"}. ${requirements.length} requirements, ${decisions.length} decisions, ${openQuestions.length} open questions and ${actionItems.length} action items were identified.`;
  return { summary, decisions, requirements, openQuestions, actionItems, generator: "mock-rules" };
}

// ---------------------------------------------------------------- entities

const STOP = new Set(
  (
    "alla allt alltid aldrig andra annan annat antal bara bättre både dagen dagar dagarna dagens dag deras dess detta denna dessa direkt där efter eget egen eller enkel enkelt först fram framåt från genom gärna hela helst hennes hans här ibland idag igen inga inget inom innan inte kanske kunna kunde lite lika man med mellan mer mest mitt mycket många nästa något några nåt också olika oss också samma sedan senare sina sitt själv själva själv självklart som till under utan vad varje vilka vilken vilket väl vill våra vårt ännu även över " +
    "tid tider tiden time times timme timmar minut minuter vecka veckan veckor månad månader år året gång gången början slut sommaren vintern morgon kväll lunch ledighet " +
    "länk länken knapp knappen sätt saker sak exempel kaos " +
    "about after again also always another because before being both could does each either every from have into just like many might more most much must never only other over same should some such than that their them then there these they this those through under very want what when where which while will with would your yours able need needs"
  ).split(/\s+/),
);
const MODAL = new Set(["ska", "kan", "kunna", "vill", "att", "måste", "får", "inte", "to", "can", "should", "must", "will", "be", "cannot", "won't"]);
/** Swedish is V2 and English SVO: the word right after a subject pronoun is (almost always) a verb. */
const PRONOUN = new Set(["jag", "du", "vi", "ni", "de", "dom", "han", "hon", "den", "det", "man", "i", "you", "we", "they", "he", "she", "it"]);
/** Field vocabulary → camelCase field names (also excluded from entity candidates). */
const FIELD_WORDS: Record<string, string> = {
  namn: "name", name: "name", pris: "price", priser: "price", price: "price", kostnad: "price",
  tidsåtgång: "durationMinutes", längd: "durationMinutes", varaktighet: "durationMinutes", duration: "durationMinutes",
  telefonnummer: "phone", telefon: "phone", mobilnummer: "phone", phone: "phone",
  "e-post": "email", epost: "email", mejl: "email", email: "email", "e-mail": "email",
  datum: "date", date: "date", adress: "address", address: "address", status: "status",
  starttid: "startsAt", sluttid: "endsAt", beskrivning: "description", description: "description",
};
const INTEGRATION_WORDS = new Set(["sms", "e-post", "epost", "mejl", "email", "e-mail", "swish", "klarna", "stripe", "bankid", "betalning", "online-betalning"]);
const TIME_WORDS = /\b(tid|tider|tiden|tidslucka|tidsluckor|tidsluckorna|klockan|time|times|slot|slots|schedule|schema|scheman)\b/;

/** Swedish/English suffix-stripping lemmatizer for nouns (heuristic). */
export function lemma(word: string): string {
  const w = lc(word);
  const rules: Array<[RegExp, string, number]> = [
    [/elserna$/, "else", 0],
    [/elser$/, "else", 0],
    [/elsen$/, "else", 0],
    [/ningarna$/, "ning", 0],
    [/ningar$/, "ning", 0],
    [/ningen$/, "ning", 0],
    [/erna$/, "", 6],
    [/arna$/, "", 6],
    [/orna$/, "a", 6],
    [/or$/, "a", 5],
    [/ar$/, "", 6],
    [/er$/, "", 5],
    [/([^aeiouyåäö])an$/, "$1a", 6],
    [/en$/, "", 6],
    [/et$/, "", 6],
    [/ies$/, "y", 5],
    [/([^s])s$/, "$1", 5],
  ];
  for (const [re, rep, min] of rules) if (re.test(w) && w.length >= min) return w.replace(re, rep);
  return w;
}

function tokens(text: string): string[] {
  return lc(text).match(/[\p{L}][\p{L}-]*/gu) ?? [];
}

function isNounCandidate(tok: string, prev: string | undefined, verbs: Set<string>): boolean {
  if (tok.length < 4 || STOP.has(tok) || tok in FIELD_WORDS || INTEGRATION_WORDS.has(tok)) return false;
  if (prev && MODAL.has(prev)) return false;
  if (verbs.has(tok)) return false;
  if (/(era|iga|liga|igt|ligt|llt|vis|ade|ande|ende|as|ing)$/.test(tok) && !/ning$/.test(tok)) return false;
  if (/(ly|ed|ing)$/.test(tok) && !/(ning|thing)$/.test(tok)) return false;
  return true;
}

/**
 * Entity hints from nouns in requirement sentences, ranked by how often their lemma occurs in the whole
 * transcript (needs >= 2 mentions). Fields come from a small attribute vocabulary seen in sentences that
 * mention the entity; relations from entities co-mentioned in a requirement.
 */
export function extractEntities(requirementTexts: string[], transcript: string, _language: string, max = 8): EntityHint[] {
  const allToks = tokens(transcript);
  // Words that follow a modal/"att"/"to" or a subject pronoun anywhere are verbs ("kunna välja", "vi behöver").
  const verbs = new Set<string>();
  allToks.forEach((t, i) => {
    const prev = allToks[i - 1];
    // "att" is also the conjunction "that" ("vi bestämde att bokningar …"): only infinitives (-a) count after it.
    if (prev && ((MODAL.has(prev) && (prev !== "att" || t.endsWith("a"))) || PRONOUN.has(prev))) verbs.add(t);
  });
  // Infinitives whose present/passive/past forms also occur ("boka" + "bokas") are verbs too.
  const tokSet = new Set(allToks);
  for (const t of tokSet) if (t.endsWith("a") && (tokSet.has(`${t}r`) || tokSet.has(`${t}s`) || tokSet.has(`${t}de`))) verbs.add(t);
  const freq = new Map<string, number>();
  for (const t of allToks) if (!verbs.has(t)) freq.set(lemma(t), (freq.get(lemma(t)) ?? 0) + 1);
  const candidates = new Map<string, number>();
  for (const r of requirementTexts) {
    const toks = tokens(r);
    toks.forEach((t, i) => {
      if (!isNounCandidate(t, toks[i - 1], verbs)) return;
      const lm = lemma(t);
      if (lm.length < 3 || STOP.has(lm)) return;
      candidates.set(lm, freq.get(lm) ?? 1);
    });
  }
  const ranked = [...candidates.entries()].filter(([, n]) => n >= 2).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  // Merge compounds into their head when both exist ("tidslucka" vs "lucka" → keep the longer, more specific one).
  const names: string[] = [];
  for (const [lm] of ranked) {
    if (names.some((n) => n.endsWith(lm) || lm.endsWith(n))) continue;
    names.push(lm);
    if (names.length >= max) break;
  }
  const sentences = splitSentences(parseUtterances(transcript).map((u) => u.text).join(" "));
  const mentions = (lm: string, s: string) => tokens(s).some((t) => lemma(t) === lm);
  const fieldsOf = new Map<string, Set<string>>(names.map((n) => [n, new Set(["id"])]));
  for (const s of sentences) {
    const toks = tokens(s);
    let lastEntity: { name: string; at: number } | undefined;
    toks.forEach((t, i) => {
      const lm = lemma(t);
      if (fieldsOf.has(lm)) lastEntity = { name: lm, at: i };
      const f = FIELD_WORDS[t];
      // "per telefon" / "via e-post" is a channel, not an attribute.
      if (f && lastEntity && i - lastEntity.at <= 8 && !/^(per|via|by|över|through)$/.test(toks[i - 1] ?? "")) fieldsOf.get(lastEntity.name)?.add(f);
    });
    if (TIME_WORDS.test(lc(s))) {
      for (const n of names) {
        if (toks.some((t) => lemma(t) === n) && /(bokning|booking|reservation|order|besök|appointment|tidslucka|slot|pass|event)/.test(n)) {
          fieldsOf.get(n)?.add("startsAt");
          fieldsOf.get(n)?.add("endsAt");
        }
      }
    }
  }
  return names.map((lm) => {
    const relations = new Set<string>();
    for (const r of requirementTexts) {
      if (!mentions(lm, r)) continue;
      for (const other of names) if (other !== lm && mentions(other, r)) relations.add(capitalize(other));
    }
    return { name: capitalize(lm), fields: [...(fieldsOf.get(lm) ?? [])], relations: [...relations] };
  });
}

// ---------------------------------------------------------------- spec

const INTEGRATIONS: Array<[RegExp, string, string]> = [
  [/\bsms\b/, "SMS-utskick (t.ex. 46elks eller Twilio)", "SMS notifications (e.g. 46elks or Twilio)"],
  [/\b(e-post|epost|mejl|email|e-mail)\b/, "E-postutskick (transaktionsmejl)", "Transactional e-mail"],
  [/\b(betala|betalning|swish|klarna|stripe|payment|pay)\b/, "Betalning (Stripe/Swish/Klarna)", "Payments (Stripe/Swish/Klarna)"],
  [/\b(google kalender|google calendar|outlook|ical|kalendersynk|calendar sync)\b/, "Kalendersynk (Google/Outlook)", "Calendar sync (Google/Outlook)"],
  [/\bbankid\b/, "BankID-inloggning", "BankID login"],
  [/\b(karta|kartor|maps?)\b/, "Karta (t.ex. Google Maps)", "Maps"],
];
const SCREEN_WORD = /^(\p{L}*(vy|vyn|sida|sidan|översikt|översikten|formulär|formuläret|dashboard|panel|panelen)|view|page|screen|dashboard|form)$/u;

function screensFrom(reqs: Requirement[], entities: EntityHint[], lang: Lang): string[] {
  const out: string[] = [];
  for (const r of reqs) {
    const words = r.text.replace(/[.,;:!?]/g, " ").split(/\s+/).filter(Boolean);
    words.forEach((w, i) => {
      if (!SCREEN_WORD.test(lc(w))) return;
      let phrase = w;
      const next = words[i + 1];
      const qualified = Boolean(next && /^(för|for|med|with)$/i.test(next) && words[i + 2]);
      if (qualified) phrase += ` ${next} ${words[i + 2]}`;
      // A bare "sidan"/"page" is not a screen name; compounds ("dagsvy", "bokningssida") or qualified ones are.
      if (!qualified && /^(vy|vyn|sida|sidan|översikt|översikten|formulär|formuläret|panel|panelen|view|page|screen|form)$/i.test(w)) return;
      out.push(capitalize(phrase));
    });
  }
  const bookingLike = entities.find((e) => /(bokning|booking|reservation|order|besök|appointment)/i.test(e.name));
  if (bookingLike) out.push(lang === "sv" ? `${bookingLike.name}sflöde för kunder (välj, bekräfta, avboka)` : `${bookingLike.name} flow (choose, confirm, cancel)`);
  for (const e of entities.slice(0, 4)) out.push(lang === "sv" ? `Admin: hantera ${lc(e.name)}` : `Admin: manage ${lc(e.name)}`);
  return [...new Set(out)];
}

function intentsFrom(text: string, entities: EntityHint[], integrations: string[], lang: Lang): MeetingSpec["suggestedIntents"] {
  const l = lc(text);
  const out: MeetingSpec["suggestedIntents"] = [];
  const add = (kind: IntentKind, summary: string, hint?: string) => {
    const i: MeetingSpec["suggestedIntents"][number] = { kind, confidence: 0.6, summary };
    if (hint) i.hint = hint;
    out.push(i);
  };
  if (/\b(mobilapp|iphone|android|app store|mobile app)\b/.test(l)) add("mobile", lang === "sv" ? "Mobilapp" : "Mobile app", "expo");
  if (entities.length || /\b(system|app|appen|webbapp|portal|bokning|booking)\b/.test(l)) {
    add("app", lang === "sv" ? "Webbapp med databas enligt specen" : "Web app with database per spec", "nextjs");
  } else if (/\b(hemsida|webbplats|sajt|website|landing)\b/.test(l)) add("website", lang === "sv" ? "Webbplats" : "Website", "nextjs");
  if (integrations.length) add("integration", integrations.join(", "));
  return out;
}

export function buildSpec(extraction: Extraction, transcript: string, language: string): MeetingSpec {
  const lang = langOf(language);
  const reqTexts = extraction.requirements.map((r) => r.text);
  const entities = extractEntities(reqTexts, transcript, language);
  const allReq = lc(reqTexts.join(" "));
  const integrations = INTEGRATIONS.filter(([re]) => re.test(allReq)).map(([, sv, en]) => (lang === "sv" ? sv : en));
  const plain = parseUtterances(transcript).map((u) => u.text).join(" ");
  const titleMatch =
    lc(plain).match(/\b(?:behöver|vill ha|bygga|bygg|skapa|göra)\s+(?:ett|en)\s+(?:nytt?\s+|enkelt?\s+)?([\p{L}-]{5,})/u) ??
    lc(plain).match(/\b(?:need|build|create|make|want)\s+(?:a|an)\s+(?:new\s+|simple\s+)?([\p{L}-]{4,}(?:\s+(?:system|app|site|portal))?)/u);
  const title = titleMatch?.[1] ? capitalize(titleMatch[1]) : entities[0] ? `${entities[0].name}-app` : lang === "sv" ? "Ny app" : "New app";
  const must = extraction.requirements.filter((r) => r.priority === "must");
  const goals = [...new Set([...(must.length ? must : extraction.requirements.slice(0, 3)).map((r) => r.text), ...extraction.decisions.map((d) => (lang === "sv" ? `Beslut: ${d}` : `Decision: ${d}`))])].slice(0, 8);
  return {
    title,
    language: lang,
    goals,
    userStories: extraction.requirements.map((r) => r.userStory),
    entities,
    screens: screensFrom(extraction.requirements, entities, lang),
    integrations,
    suggestedIntents: intentsFrom(`${plain} ${reqTexts.join(" ")}`, entities, integrations, lang),
    acceptanceCriteria: extraction.requirements.map((r) => `${r.id}: ${lang === "sv" ? "Verifierat när" : "Verified when"}: ${decapitalize(r.text)}`),
    openQuestions: extraction.openQuestions,
    generator: "mock-rules",
  };
}
