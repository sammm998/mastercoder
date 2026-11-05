import type { Finding } from "../types.js";
import type { SourceFile } from "../files.js";

export interface SecretRule {
  id: string;
  description: string;
  regex: RegExp;
  /** Capture group holding the secret (default 0). */
  group?: number;
  /** Minimum Shannon entropy (bits/char) of the secret. */
  minEntropy?: number;
}

/** Built-in gitleaks-style rules (used when the gitleaks binary is not available). */
export const SECRET_RULES: SecretRule[] = [
  { id: "aws-access-key-id", description: "AWS access key ID", regex: /\b((?:AKIA|ASIA|ABIA|ACCA|A3T[A-Z0-9])[A-Z0-9]{16})\b/g, group: 1 },
  {
    id: "aws-secret-access-key",
    description: "AWS secret access key",
    regex: /aws.{0,24}?(?:secret|sk|private).{0,24}?['"`:=]\s*['"`]?([A-Za-z0-9/+]{40})(?![A-Za-z0-9/+])/gi,
    group: 1,
    minEntropy: 3.5,
  },
  { id: "stripe-secret-key", description: "Stripe secret/restricted key", regex: /\b((?:sk|rk)_(?:live|test)_[0-9a-zA-Z]{16,})\b/g, group: 1 },
  { id: "github-token", description: "GitHub token", regex: /\b((?:ghp|gho|ghu|ghs|ghr)_[0-9a-zA-Z]{36}|github_pat_[0-9a-zA-Z_]{22,})\b/g, group: 1 },
  { id: "slack-token", description: "Slack token", regex: /\b(xox[baprse]-[0-9A-Za-z-]{10,})\b/g, group: 1 },
  { id: "slack-webhook", description: "Slack incoming webhook", regex: /(https:\/\/hooks\.slack\.com\/services\/T[0-9A-Z]+\/B[0-9A-Z]+\/[0-9A-Za-z]{16,})/g, group: 1 },
  { id: "anthropic-api-key", description: "Anthropic API key", regex: /\b(sk-ant-(?:api|admin)\d{2}-[A-Za-z0-9_-]{32,})/g, group: 1 },
  { id: "openai-api-key", description: "OpenAI API key", regex: /\b(sk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}T3BlbkFJ[A-Za-z0-9_-]{20,}|sk-(?:proj|svcacct|admin)-[A-Za-z0-9_-]{40,})/g, group: 1 },
  { id: "google-api-key", description: "Google API key", regex: /\b(AIza[0-9A-Za-z_-]{35})\b/g, group: 1 },
  { id: "sendgrid-api-key", description: "SendGrid API key", regex: /\b(SG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43})\b/g, group: 1 },
  { id: "private-key", description: "Private key", regex: /(-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY(?: BLOCK)?-----)/g, group: 1 },
  {
    id: "jwt-secret",
    description: "Hardcoded JWT secret",
    regex: /\b(?:jwt|token|session|auth)[_-]?(?:secret|signing[_-]?key)\b\s*[:=]\s*['"`]([^'"`\s]{8,})['"`]/gi,
    group: 1,
    minEntropy: 2.5,
  },
  {
    id: "generic-secret-assignment",
    description: "High-entropy secret assigned to a credential-like name",
    regex: /\b[\w-]*(?:api[_-]?key|apikey|secret|token|passwd|password|auth[_-]?key|access[_-]?key|client[_-]?secret|private[_-]?key)[\w-]*['"]?\s*[:=]\s*['"`]([^'"`\s]{16,})['"`]/gi,
    group: 1,
    minEntropy: 3.8,
  },
];

const PLACEHOLDER = /(example|sample|dummy|placeholder|changeme|change-me|your[_-]|xxxx|<[^>]+>|\$\{|\{\{|process\.env|import\.meta|os\.environ|redacted|\*\*\*\*|fake|test-?key)/i;

export function shannonEntropy(s: string): number {
  const freq = new Map<string, number>();
  for (const ch of s) freq.set(ch, (freq.get(ch) ?? 0) + 1);
  let h = 0;
  for (const n of freq.values()) {
    const p = n / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}

export function redactSecret(s: string): string {
  if (s.length <= 8) return "****";
  return `${s.slice(0, 4)}…${"*".repeat(4)}(${s.length} chars)`;
}

const SKIP_FILE = /(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|poetry\.lock|uv\.lock|Cargo\.lock|composer\.lock)$|\.(min\.)?map$/;
const ALLOW_MARKER = /(gitleaks:allow|forge:allow-secret)/;

export interface SecretMatch {
  rule: SecretRule;
  file: string;
  line: number;
  secret: string;
}

export function findSecrets(files: SourceFile[], rules: SecretRule[] = SECRET_RULES): SecretMatch[] {
  const out: SecretMatch[] = [];
  for (const f of files) {
    if (SKIP_FILE.test(f.path)) continue;
    const base = f.path.split("/").pop() ?? "";
    if (/^\.env\.(example|sample|template|dist)$/.test(base)) continue;
    f.lines.forEach((text, i) => {
      if (ALLOW_MARKER.test(text)) return;
      const seen = new Set<string>();
      for (const rule of rules) {
        rule.regex.lastIndex = 0;
        for (const m of text.matchAll(rule.regex)) {
          const secret = m[rule.group ?? 0] ?? m[0];
          if (rule.id.startsWith("generic") || rule.id === "jwt-secret" || rule.id === "aws-secret-access-key") {
            if (PLACEHOLDER.test(secret) || PLACEHOLDER.test(m[0].replace(secret, ""))) continue;
          }
          if (rule.minEntropy !== undefined && shannonEntropy(secret) < rule.minEntropy) continue;
          if (seen.has(secret)) continue;
          seen.add(secret);
          out.push({ rule, file: f.path, line: i + 1, secret });
        }
      }
    });
  }
  // A specific rule wins over the generic one on the same line/secret.
  return out.filter(
    (m) => !(m.rule.id === "generic-secret-assignment" && out.some((o) => o !== m && o.file === m.file && o.line === m.line && o.rule.id !== m.rule.id)),
  );
}

export function secretFindings(matches: SecretMatch[], ruleId = (m: SecretMatch) => `secret/${m.rule.id}`): Finding[] {
  return matches.map((m) => ({
    file: m.file,
    line: m.line,
    rule: ruleId(m),
    message: `${m.rule.description} committed in source: ${redactSecret(m.secret)}`,
    severity: "error",
  }));
}
