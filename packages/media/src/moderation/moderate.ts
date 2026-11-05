import { z } from "zod";
import { getModels, structured, type ContentBlock, type LLMProvider } from "@forge/llm";
import type { ImageInput } from "../types.js";
import { sniffMime } from "../adapters/http.js";
import { normalizeForModeration, type NormalizedText } from "./normalize.js";
import * as L from "./lexicons.js";

export const ModerationCategory = z.enum(["sexual_minors", "deepfake", "brand_impersonation", "violent_extremism"]);
export type ModerationCategory = z.infer<typeof ModerationCategory>;

export interface ModerationInput {
  prompt: string;
  images?: ImageInput[];
}

export interface ModerationResult {
  allowed: boolean;
  category?: ModerationCategory;
  reason: string;
  /** Which check decided: rule lexicons or the optional LLM check. */
  source: "rules" | "llm";
  /** Matched lexicon fragments (for audit / abuse queue). */
  matched?: string[];
}

export interface ModerateOptions {
  /** Optional second opinion from an LLM (purpose "media.moderate") when rules allow. */
  llm?: LLMProvider;
  model?: string;
}

function compile(frags: string[], flags = ""): RegExp {
  return new RegExp(`\\b(?:${frags.join("|")})`, flags);
}
function compileCs(words: string[]): RegExp {
  return new RegExp(`\\b(?:${words.join("|")})\\b`);
}

const RX = {
  sexual: compile(L.SEXUAL_TERMS),
  minor: compile(L.MINOR_TERMS),
  minorSv: compile(L.MINOR_TERMS_SV_ONLY),
  csam: compile(L.CSAM_STANDALONE),
  person: compile(L.REAL_PEOPLE),
  personal: compile(L.PERSONAL_TARGETS),
  deepfakeAction: compile(L.DEEPFAKE_ACTIONS),
  imageAbuse: compile(L.IMAGE_ABUSE_ACTIONS),
  deepfakeStandalone: compile(L.DEEPFAKE_STANDALONE),
  brand: compile(L.BRANDS),
  brandCs: compileCs(L.BRANDS_CASE_SENSITIVE),
  brandAbuse: compile(L.BRAND_ABUSE_PATTERNS),
  phishing: compile(L.PHISHING_STANDALONE),
  phishingEdu: compile(L.PHISHING_EDUCATION),
  org: compile(L.EXTREMIST_ORGS),
  orgCs: compileCs(L.EXTREMIST_ORGS_CASE_SENSITIVE),
  propaganda: compile(L.EXTREMIST_PROPAGANDA),
  extremistIntent: compile(L.EXTREMIST_INTENT),
  extremistStandalone: compile(L.EXTREMIST_STANDALONE),
  attacker: compile(L.ATTACKERS),
  glorify: compile(L.GLORIFY),
  edu: compile(L.EDUCATIONAL_CONTEXT),
};

/** First match of a regex over all normalised variants. */
function find(n: NormalizedText, rx: RegExp): string | undefined {
  for (const v of n.variants) {
    const m = v.match(rx);
    if (m) return m[0].trim();
  }
  return undefined;
}

function block(category: ModerationCategory, reason: string, matched: Array<string | undefined>): ModerationResult {
  return { allowed: false, category, reason, source: "rules", matched: matched.filter((m): m is string => Boolean(m)) };
}

/**
 * In Swedish, "sex" is also the numeral six ("sex barn" = six children). Rewrite the numeral use to a digit
 * so it is not read as a sexual term, while keeping phrases like "sex med".
 */
function swedishNumerals(n: NormalizedText): NormalizedText {
  if (!n.swedish) return n;
  const fix = (s: string) => s.replace(/\bsex (?!med\b|mellan\b|och\b|scen|bild|video|film|leksak)(?=[a-z])/g, "6 ");
  return { ...n, variants: n.variants.map(fix), plain: fix(n.plain) };
}

/** Rule-based moderation only (deterministic, multilingual sv+en). */
export function moderateRules(input: ModerationInput): ModerationResult {
  const n = swedishNumerals(normalizeForModeration(input.prompt));
  const hasImages = (input.images?.length ?? 0) > 0;

  // 1. Sexual content involving minors.
  const csam = find(n, RX.csam);
  if (csam) return block("sexual_minors", "Sexual content involving minors is never allowed.", [csam]);
  const sexual = find(n, RX.sexual);
  if (sexual) {
    const minor = find(n, RX.minor) ?? (n.swedish ? find(n, RX.minorSv) : undefined) ?? n.plain.match(L.MINOR_AGE)?.[0];
    if (minor) return block("sexual_minors", "Sexual or nude content combined with a minor indicator is never allowed.", [sexual, minor]);
  }

  // 2. Real-person deepfakes / non-consensual imagery.
  const standaloneDf = find(n, RX.deepfakeStandalone);
  if (standaloneDf) return block("deepfake", "Deepfakes or 'undressing' of real people are not allowed.", [standaloneDf]);
  const person = find(n, RX.person) ?? find(n, RX.personal);
  const dfAction = find(n, RX.deepfakeAction);
  if (person && dfAction) {
    return block("deepfake", "Fake, sexualised or impersonating depictions of a real, identifiable person are not allowed.", [person, dfAction]);
  }
  if (hasImages) {
    const abuse = find(n, RX.imageAbuse);
    if (abuse) return block("deepfake", "Face swaps or undressing a person in an uploaded photo are not allowed.", [abuse]);
  }

  // 3. Brand impersonation / phishing.
  const phishing = find(n, RX.phishing);
  const brand = find(n, RX.brand) ?? n.raw.match(RX.brandCs)?.[0];
  if (phishing && !(find(n, RX.phishingEdu) && !brand)) {
    return block("brand_impersonation", "Phishing or fake login material is not allowed.", [phishing]);
  }
  if (brand) {
    const abuse = find(n, RX.brandAbuse);
    if (abuse) return block("brand_impersonation", `Recreating ${brand} branding (logo, official or login material) could impersonate the brand.`, [brand, abuse]);
  }

  // 4. Violent extremism.
  const extremeStandalone = find(n, RX.extremistStandalone);
  if (extremeStandalone) return block("violent_extremism", "Extremist slogans, symbols or propaganda are not allowed.", [extremeStandalone]);
  const attacker = find(n, RX.attacker);
  const glorify = find(n, RX.glorify);
  if (attacker && glorify) return block("violent_extremism", "Glorifying perpetrators of terrorist attacks is not allowed.", [attacker, glorify]);
  const org = find(n, RX.org) ?? n.raw.match(RX.orgCs)?.[0];
  if (org) {
    const intent = find(n, RX.extremistIntent);
    if (intent) return block("violent_extremism", "Recruitment or glorification material for violent extremist groups is not allowed.", [org, intent]);
    const propaganda = find(n, RX.propaganda);
    if (propaganda && !find(n, RX.edu)) {
      return block("violent_extremism", "Propaganda, flags or symbols of violent extremist groups are not allowed outside a clear educational/historical context.", [org, propaganda]);
    }
  }

  return { allowed: true, reason: "No policy rule matched.", source: "rules" };
}

const LlmVerdict = z.object({
  allowed: z.boolean(),
  category: ModerationCategory.optional().nullable(),
  reason: z.string(),
});

export const MODERATION_POLICY = `You are a content-safety classifier for an image/video generation service.
Block ONLY these categories:
- sexual_minors: any sexual or nude content involving minors (any language).
- deepfake: fake, sexualised, humiliating or impersonating depictions of real identifiable people (public or private), face swaps, undressing.
- brand_impersonation: recreating real brands' logos, official or login material that could be used to impersonate or phish.
- violent_extremism: propaganda, recruitment, symbols or glorification of violent extremist organisations or attackers.
Everything else is allowed (including children in non-sexual contexts, adult art, brand-inspired styles, history education).
Answer as JSON: {"allowed": boolean, "category": one of the categories or null, "reason": short string}.`;

function imageBlock(img: ImageInput): ContentBlock | undefined {
  let bytes: Uint8Array | undefined;
  if (typeof img !== "string") bytes = img;
  else {
    const m = img.match(/^data:([^;,]+);base64,(.*)$/s);
    if (m) bytes = new Uint8Array(Buffer.from(m[2] as string, "base64"));
  }
  if (!bytes) return undefined; // remote URLs are not fetched for moderation
  const mime = sniffMime(bytes);
  if (mime !== "image/png" && mime !== "image/jpeg" && mime !== "image/webp" && mime !== "image/gif") return undefined;
  return { type: "image", mediaType: mime, data: Buffer.from(bytes).toString("base64") };
}

/**
 * Moderate a prompt (+ optional images) BEFORE any model call. Rule lexicons (sv+en, normalised for
 * leetspeak/diacritics/homoglyphs) run first; when they allow and an LLM is given, the LLM is asked too
 * (purpose "media.moderate"). Either can block.
 */
export async function moderate(input: ModerationInput, opts: ModerateOptions = {}): Promise<ModerationResult> {
  const rules = moderateRules(input);
  if (!rules.allowed || !opts.llm) return rules;
  const content: ContentBlock[] = [{ type: "text", text: JSON.stringify({ prompt: input.prompt, imageCount: input.images?.length ?? 0 }) }];
  for (const img of input.images ?? []) {
    const b = imageBlock(img);
    if (b) content.push(b);
  }
  const { value } = await structured(
    opts.llm,
    { purpose: "media.moderate", model: opts.model ?? getModels().fast, system: MODERATION_POLICY, messages: [{ role: "user", content }], maxTokens: 300 },
    LlmVerdict,
  );
  if (value.allowed) return { allowed: true, reason: value.reason, source: "llm" };
  return { allowed: false, category: value.category ?? undefined, reason: value.reason, source: "llm" };
}
