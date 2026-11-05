/**
 * Word / character error rate. Isomorphic, dependency-free.
 *
 * WER = (S + D + I) / N over normalized word tokens (Levenshtein alignment), N = reference length.
 * CER = same over characters of the normalized text (single spaces between words count as characters).
 */

export interface NormalizeOptions {
  language?: string;
  /** Convert spelled-out numbers to digits ("tjugotre" → "23", "twenty three" → "23"). Default false. */
  numbers?: boolean;
}

const SV_NUMBERS: Record<string, number> = {
  noll: 0, två: 2, tre: 3, fyra: 4, fem: 5, sex: 6, sju: 7, åtta: 8, nio: 9, tio: 10,
  elva: 11, tolv: 12, tretton: 13, fjorton: 14, femton: 15, sexton: 16, sjutton: 17, arton: 18, nitton: 19,
  tjugo: 20, tju: 20, trettio: 30, tretti: 30, fyrtio: 40, fyrti: 40, femtio: 50, femti: 50, sextio: 60, sexti: 60,
  sjuttio: 70, sjutti: 70, åttio: 80, åtti: 80, nittio: 90, nitti: 90, hundra: 100, tusen: 1000,
};
/** Only valid inside a compound ("etthundra", "entusen") - standalone "en"/"ett" are articles. */
const SV_COMPOUND_ONLY: Record<string, number> = { ett: 1, en: 1 };

const EN_NUMBERS: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
  twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90, hundred: 100, thousand: 1000,
};

function lexicon(language: string | undefined): Record<string, number> {
  const l = (language ?? "").toLowerCase();
  if (l.startsWith("sv")) return SV_NUMBERS;
  if (l.startsWith("en")) return EN_NUMBERS;
  return { ...EN_NUMBERS, ...SV_NUMBERS };
}

/** Split a single Swedish compound like "tvåhundrafemtio" into number morphemes, or null. */
function svMorphemes(token: string): number[] | null {
  const keys = [...Object.keys(SV_NUMBERS), ...Object.keys(SV_COMPOUND_ONLY)].sort((a, b) => b.length - a.length);
  const out: number[] = [];
  let rest = token;
  while (rest.length > 0) {
    const k = keys.find((key) => rest.startsWith(key));
    if (!k) return null;
    out.push(SV_NUMBERS[k] ?? SV_COMPOUND_ONLY[k] ?? 0);
    rest = rest.slice(k.length);
  }
  return out;
}

/** Can morpheme `next` continue a number whose previous morpheme was `prev`? */
function continues(prev: number, next: number): boolean {
  if (next === 1000) return prev < 1000;
  if (next === 100) return prev < 100 && prev !== 0;
  if (prev === 100 || prev === 1000) return next < prev;
  if (prev >= 20 && prev < 100 && prev % 10 === 0) return next > 0 && next < 10;
  return false;
}

function valueOf(morphemes: number[]): number {
  let total = 0;
  let current = 0;
  for (const m of morphemes) {
    if (m === 100) current = (current || 1) * 100;
    else if (m === 1000) {
      total += (current || 1) * 1000;
      current = 0;
    } else current += m;
  }
  return total + current;
}

function numbersToDigits(tokens: string[], language: string | undefined): string[] {
  const lex = lexicon(language);
  const sv = !language || language.toLowerCase().startsWith("sv");
  const morphemesOf = (t: string): number[] | null => {
    if (t in lex) return [lex[t] as number];
    if (sv) {
      const m = svMorphemes(t);
      // A compound must contain at least one real number word (not just "en"/"ett").
      if (m && m.length > 1) return m;
    }
    return null;
  };
  const out: string[] = [];
  let group: number[] = [];
  const flush = () => {
    if (group.length) out.push(String(valueOf(group)));
    group = [];
  };
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i] as string;
    // English "two hundred and five"
    if (t === "and" && group.length && (group[group.length - 1] === 100 || group[group.length - 1] === 1000)) {
      const nextM = tokens[i + 1] !== undefined ? morphemesOf(tokens[i + 1] as string) : null;
      if (nextM && (nextM[0] ?? 0) < 100) continue;
    }
    const m = morphemesOf(t);
    if (!m) {
      flush();
      out.push(t);
      continue;
    }
    const internallyValid = m.every((v, j) => j === 0 || continues(m[j - 1] as number, v));
    if (!internallyValid) {
      flush();
      out.push(t);
      continue;
    }
    if (group.length && !continues(group[group.length - 1] as number, m[0] as number)) flush();
    group.push(...m);
  }
  flush();
  return out;
}

/**
 * Normalize for scoring: NFC, lowercase, punctuation → space (letters incl. å/ä/ö/é/ü and digits are kept),
 * whitespace unified. Hyphenated compounds ("att-göra-app") become separate tokens on both sides.
 */
export function normalizeText(text: string, opts: NormalizeOptions = {}): string {
  const lower = text.normalize("NFC").toLocaleLowerCase(opts.language?.startsWith("sv") ? "sv-SE" : "en-US");
  // Keep apostrophes inside words (don't, it's), drop everything that is not a letter, mark or digit.
  const cleaned = lower.replace(/(\p{L})['’](\p{L})/gu, "$1'$2").replace(/[^\p{L}\p{M}\p{N}']+/gu, " ").replace(/(^|\s)'+|'+(\s|$)/g, " ");
  let tokens = cleaned.split(/\s+/).filter(Boolean);
  if (opts.numbers) tokens = numbersToDigits(tokens, opts.language);
  return tokens.join(" ");
}

export function tokenize(text: string, opts: NormalizeOptions = {}): string[] {
  const n = normalizeText(text, opts);
  return n ? n.split(" ") : [];
}

export interface EditCounts {
  substitutions: number;
  deletions: number;
  insertions: number;
  hits: number;
  /** Reference length. */
  n: number;
}

/** Levenshtein alignment with operation counts (O(n*m) time, O(n*m) for backtrace). */
export function editCounts<T>(ref: readonly T[], hyp: readonly T[]): EditCounts {
  const n = ref.length;
  const m = hyp.length;
  const d: number[][] = Array.from({ length: n + 1 }, (_, i) => {
    const row = new Array<number>(m + 1).fill(0);
    row[0] = i;
    return row;
  });
  const row0 = d[0] as number[];
  for (let j = 0; j <= m; j++) row0[j] = j;
  for (let i = 1; i <= n; i++) {
    const row = d[i] as number[];
    const prev = d[i - 1] as number[];
    for (let j = 1; j <= m; j++) {
      const cost = ref[i - 1] === hyp[j - 1] ? 0 : 1;
      row[j] = Math.min((prev[j] as number) + 1, (row[j - 1] as number) + 1, (prev[j - 1] as number) + cost);
    }
  }
  let i = n;
  let j = m;
  const c: EditCounts = { substitutions: 0, deletions: 0, insertions: 0, hits: 0, n };
  while (i > 0 || j > 0) {
    const cur = (d[i] as number[])[j] as number;
    if (i > 0 && j > 0 && cur === ((d[i - 1] as number[])[j - 1] as number) + (ref[i - 1] === hyp[j - 1] ? 0 : 1)) {
      if (ref[i - 1] === hyp[j - 1]) c.hits++;
      else c.substitutions++;
      i--;
      j--;
    } else if (i > 0 && cur === ((d[i - 1] as number[])[j] as number) + 1) {
      c.deletions++;
      i--;
    } else {
      c.insertions++;
      j--;
    }
  }
  return c;
}

function rate(c: EditCounts, hypLen: number): number {
  if (c.n === 0) return hypLen === 0 ? 0 : 1;
  return (c.substitutions + c.deletions + c.insertions) / c.n;
}

export interface ErrorRate extends EditCounts {
  rate: number;
}

export function werDetails(reference: string, hypothesis: string, opts: NormalizeOptions = {}): ErrorRate {
  const r = tokenize(reference, opts);
  const h = tokenize(hypothesis, opts);
  const c = editCounts(r, h);
  return { ...c, rate: rate(c, h.length) };
}

/** Word error rate in [0, ∞) (can exceed 1 with many insertions). Empty reference: 0 if hypothesis empty, else 1. */
export function wer(reference: string, hypothesis: string, opts: NormalizeOptions = {}): number {
  return werDetails(reference, hypothesis, opts).rate;
}

export function cerDetails(reference: string, hypothesis: string, opts: NormalizeOptions = {}): ErrorRate {
  const r = Array.from(normalizeText(reference, opts));
  const h = Array.from(normalizeText(hypothesis, opts));
  const c = editCounts(r, h);
  return { ...c, rate: rate(c, h.length) };
}

/** Character error rate over normalized text. */
export function cer(reference: string, hypothesis: string, opts: NormalizeOptions = {}): number {
  return cerDetails(reference, hypothesis, opts).rate;
}
