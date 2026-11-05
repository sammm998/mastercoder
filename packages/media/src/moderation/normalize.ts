/** Text normalisation for rule-based moderation (Swedish + English). */

const ZERO_WIDTH = new RegExp("[\\u200B-\\u200D\\u2060\\uFEFF\\u00AD]", "g");

/** Cyrillic/Greek letters that look like Latin ones (common filter-evasion trick). */
const HOMOGLYPHS: Record<string, string> = {
  а: "a", в: "b", е: "e", к: "k", м: "m", н: "h", о: "o", р: "p", с: "c", т: "t", у: "y", х: "x", і: "i", ј: "j", ѕ: "s",
  А: "A", В: "B", Е: "E", К: "K", М: "M", Н: "H", О: "O", Р: "P", С: "C", Т: "T", Х: "X", І: "I", Ј: "J", Ѕ: "S",
  α: "a", ε: "e", ι: "i", κ: "k", ο: "o", ρ: "p", τ: "t", υ: "u", χ: "x", ν: "v",
};

/** Letters that do not decompose under NFKD. */
const SPECIAL: Record<string, string> = { ø: "o", Ø: "O", æ: "ae", Æ: "AE", œ: "oe", Œ: "OE", ß: "ss", ł: "l", Ł: "L", đ: "d", Đ: "D", þ: "th", ð: "d" };

const LEET_I: Record<string, string> = { "0": "o", "1": "i", "3": "e", "4": "a", "5": "s", "7": "t", "8": "b", "9": "g", "@": "a", $: "s", "!": "i", "|": "l", "+": "t", "€": "e" };

export interface NormalizedText {
  /** Original text after NFKC and zero-width removal (case preserved). */
  raw: string;
  /** Variants to match lexicons against: plain, leet (1→i), leet (1→l), leet with repeats squashed. */
  variants: string[];
  /** Plain lowercase/diacritic-free variant without leet mapping (digits preserved, used for ages). */
  plain: string;
  /** Heuristic: text looks Swedish. */
  swedish: boolean;
}

export function stripDiacritics(s: string): string {
  return s
    .replace(/[øØæÆœŒßłŁđĐþð]/g, (c) => SPECIAL[c] ?? c)
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "");
}

function deHomoglyph(s: string): string {
  return s.replace(/[Ͱ-ϿЀ-ӿ]/g, (c) => HOMOGLYPHS[c] ?? c);
}

function leet(text: string, one: "i" | "l"): string {
  return text
    .split(/\s+/)
    .map((tok) => {
      const core = tok.replace(/[.,!?;:)"'\]]+$/, "");
      if (!/[a-z]/.test(core) || !/[0-9@$!|+€]/.test(core)) return tok;
      return core.replace(/[0-9@$!|+€]/g, (c) => (c === "1" ? one : LEET_I[c] ?? c));
    })
    .join(" ");
}

/** Punctuation → spaces, collapse spelled-out letters ("n u d e" → "nude"), squeeze whitespace. */
function tokenize(s: string): string {
  const spaced = s.replace(/[^a-z0-9]+/g, " ").trim();
  const toks = spaced.split(" ");
  const out: string[] = [];
  let run: string[] = [];
  const flush = () => {
    if (run.length >= 3) out.push(run.join(""));
    else out.push(...run);
    run = [];
  };
  for (const t of toks) {
    if (t.length === 1 && /[a-z]/.test(t)) run.push(t);
    else {
      flush();
      out.push(t);
    }
  }
  flush();
  return out.filter(Boolean).join(" ");
}

const SV_WORDS = new Set(["och", "att", "det", "som", "med", "inte", "jag", "vi", "han", "hon", "till", "eller", "bild", "ett", "den", "gor", "gora", "skapa", "pa", "av", "ar", "en", "min", "mitt", "hans", "hennes", "nagon", "lite", "bilden", "videon",
  "i", "leker", "lekande", "springer", "sitter", "parken", "skolan", "hemma", "vid", "efter", "nar", "ocksa", "mycket", "alla", "flera", "tva", "tre",
  "fyra", "fem", "sju", "atta", "nio", "tio", "glad", "glada", "sma", "stora", "liten", "lilla", "vackert", "solig", "skogen", "stranden", "hund",
  "katt", "huset", "familj", "familjen", "teckning", "malning", "affisch", "logga", "logotyp", "gor", "gora", "kan", "ska", "vill", "hennes", "deras"]);

export function normalizeForModeration(input: string): NormalizedText {
  const raw = deHomoglyph(input.normalize("NFKC").replace(ZERO_WIDTH, ""));
  const lower = stripDiacritics(raw.toLowerCase());
  const plain = tokenize(lower);
  const leetI = tokenize(leet(lower, "i"));
  const leetL = tokenize(leet(lower, "l"));
  const squashed = leetI.replace(/([a-z])\1+/g, "$1");
  const variants = [...new Set([plain, leetI, leetL, squashed])];
  const tokens = plain.split(" ");
  const svHits = tokens.filter((t) => SV_WORDS.has(t)).length;
  const swedish = /[åäö]/i.test(raw) || svHits >= 2;
  return { raw, variants, plain, swedish };
}
