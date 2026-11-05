export type AbuseCategory = "phishing" | "impersonation" | "credential_harvesting" | "malware" | "other";

export interface AbuseFinding {
  category: AbuseCategory;
  rule: string;
  evidence: string;
  file?: string;
  weight: number;
}

export interface ScanInput {
  /** Files of the hosted project (path → content) and/or rendered HTML of live pages. */
  files: Record<string, string>;
  /** Brand/company names the owner legitimately represents (project name, verified domains). */
  ownBrands?: string[];
  /** Hostname the app is served on. */
  hostname?: string;
}

export interface ScanResult {
  score: number;
  verdict: "clean" | "suspicious" | "malicious";
  findings: AbuseFinding[];
}

/** Frequently impersonated brands (banks, payment, big tech, Nordic services). */
export const PROTECTED_BRANDS = [
  "paypal", "apple", "icloud", "microsoft", "office 365", "outlook", "google", "gmail", "facebook", "instagram", "whatsapp", "netflix", "amazon",
  "dhl", "postnord", "ups", "fedex", "klarna", "swish", "bankid", "swedbank", "handelsbanken", "seb", "nordea", "danske bank", "dnb", "skatteverket",
  "försäkringskassan", "coinbase", "binance", "metamask", "stripe", "visa", "mastercard", "american express", "linkedin", "dropbox", "docusign", "adobe",
];

const PHISH_PHRASES = [
  /verify your (account|identity|payment)/i, /your account (has been|will be) (suspended|locked|limited|closed)/i, /unusual (sign-?in|activity)/i,
  /confirm your (billing|card|bank) (details|information)/i, /update your payment (method|details)/i, /(re-?)?activate your account/i,
  /verifiera (ditt|ditt konto|din identitet)/i, /ditt konto (har spärrats|kommer att stängas)/i, /bekräfta dina (kort|bank)uppgifter/i,
  /seed phrase|recovery phrase|private key/i, /you have (won|been selected)/i, /claim your (prize|refund|reward)/i,
];

const MALWARE_PATTERNS: Array<[RegExp, string, number]> = [
  [/eval\s*\(\s*(atob|unescape|decodeURIComponent)\s*\(/i, "obfuscated eval", 35],
  [/document\.write\s*\(\s*unescape\s*\(/i, "document.write(unescape(...))", 30],
  [/(coinhive|cryptonight|coin-hive|webminepool|crypto-loot|miner\.start\s*\()/i, "in-browser crypto miner", 50],
  [/\.(exe|scr|msi|apk|bat|vbs|jar)["']\s*[,)].*\b(download|click\(\))/i, "automatic executable download", 40],
  [/new\s+Function\s*\(\s*atob\s*\(/i, "new Function(atob(...))", 35],
  [/String\.fromCharCode\((\s*\d+\s*,){40,}/, "long fromCharCode payload", 25],
  [/window\.location\s*=\s*["']data:/i, "data: URL navigation", 25],
];

function stripTags(html: string): string {
  return html.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
}

/** Text a victim reads as "who is this page": title, headings, logo alt text, and text around the sign-in prompt. */
export function prominentText(content: string): string {
  const parts: string[] = [];
  for (const re of [/<title[^>]*>([\s\S]*?)<\/title>/gi, /<h[1-3][^>]*>([\s\S]*?)<\/h[1-3]>/gi, /alt\s*=\s*["']([^"']+)["']/gi, /<button[^>]*>([\s\S]*?)<\/button>/gi]) {
    for (const m of content.matchAll(re)) parts.push(m[1]!);
  }
  const plain = stripTags(content);
  // "Log in to your PayPal account" / "Logga in med BankID" / "PayPal - Log in"
  for (const m of plain.matchAll(/\b(?:log ?in|sign ?in|logga in)\s+(?:to|with|into|till|på|med)\s+(?:your\s+|ditt\s+)?([\p{L}\d ]{2,25})/giu)) parts.push(m[1]!);
  for (const m of plain.matchAll(/([\p{L}\d ]{2,20})\s*[-–|:]\s*(?:log ?in|sign ?in|logga in)\b/giu)) parts.push(m[1]!);
  return stripTags(parts.join(" ")).toLowerCase();
}

function host(u: string): string | null {
  try {
    return new URL(u).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Heuristic scanner for hosted Forge apps. Weighted rules; score >= 60 = malicious (auto-takedown
 * candidate, still reviewed by an admin), >= 30 = suspicious (queued for review).
 */
export function scanForAbuse(input: ScanInput): ScanResult {
  const findings: AbuseFinding[] = [];
  const own = (input.ownBrands ?? []).map((b) => b.toLowerCase());
  for (const [file, content] of Object.entries(input.files)) {
    const isMarkup = /\.(html?|tsx|jsx|astro|vue|svelte)$/.test(file) || /<html|<form/i.test(content);
    const text = isMarkup ? stripTags(content) : content;
    const hasPassword = /type\s*=\s*["']?password/i.test(content);
    const hasCard = /(card ?number|kortnummer|cvv|cvc|expiry|utgångsdatum|cc-number|autocomplete=["']cc-)/i.test(content);
    const hasSeed = /(seed phrase|recovery phrase|12[- ]word|24[- ]word|private key)/i.test(content);

    const prominent = prominentText(content);
    const brands = PROTECTED_BRANDS.filter((b) => new RegExp(`\\b${b.replace(/ /g, "\\s+")}\\b`, "i").test(prominent) && !own.some((o) => o.includes(b) || b.includes(o)));
    if (brands.length && (hasPassword || hasCard)) {
      findings.push({ category: "impersonation", rule: "brand-login-form", evidence: `Collects ${hasCard ? "card details" : "passwords"} while presenting as: ${brands.slice(0, 3).join(", ")}`, file, weight: 45 });
    } else if (brands.length >= 2 && /\b(log ?in|sign ?in|logga in)\b/i.test(prominent)) {
      findings.push({ category: "impersonation", rule: "brand-mentions-login", evidence: `Login page naming ${brands.slice(0, 3).join(", ")}`, file, weight: 20 });
    }
    for (const re of PHISH_PHRASES) {
      const m = text.match(re);
      if (m) findings.push({ category: "phishing", rule: "phishing-phrase", evidence: m[0], file, weight: 15 });
    }
    if (hasSeed && /<(input|textarea)/i.test(content)) findings.push({ category: "credential_harvesting", rule: "seed-phrase-input", evidence: "Form asks for a wallet seed phrase / private key", file, weight: 50 });
    // Credentials posted to a third-party origin.
    for (const m of content.matchAll(/<form[^>]*action\s*=\s*["'](https?:\/\/[^"']+)["'][^>]*>([\s\S]*?)<\/form>/gi)) {
      const h = host(m[1]!);
      if (h && h !== input.hostname && /type\s*=\s*["']?password|cc-number|card/i.test(m[2]!)) findings.push({ category: "credential_harvesting", rule: "external-credential-post", evidence: `Credentials form posts to ${h}`, file, weight: 40 });
    }
    for (const m of content.matchAll(/fetch\(\s*["'](https?:\/\/[^"']+)["'][\s\S]{0,300}?(password|passwd|card|cvv)/gi)) {
      const h = host(m[1]!);
      if (h && h !== input.hostname && !/(stripe\.com|forge\.)/.test(h)) findings.push({ category: "credential_harvesting", rule: "external-credential-fetch", evidence: `Sends ${m[2]} to ${h}`, file, weight: 35 });
    }
    if (/api\.telegram\.org\/bot[^"'\s]+\/send(Message|Document)/i.test(content) && (hasPassword || hasCard)) findings.push({ category: "credential_harvesting", rule: "telegram-exfiltration", evidence: "Form data relayed to a Telegram bot", file, weight: 50 });
    for (const [re, rule, weight] of MALWARE_PATTERNS) if (re.test(content)) findings.push({ category: "malware", rule, evidence: content.match(re)![0].slice(0, 120), file, weight });
  }
  // Same finding in many files should not stack unboundedly.
  const seen = new Map<string, number>();
  const capped = findings.filter((f) => {
    const n = (seen.get(f.rule) ?? 0) + 1;
    seen.set(f.rule, n);
    return n <= 2;
  });
  const score = Math.min(100, capped.reduce((a, f) => a + f.weight, 0));
  return { score, verdict: score >= 60 ? "malicious" : score >= 30 ? "suspicious" : "clean", findings: capped };
}
