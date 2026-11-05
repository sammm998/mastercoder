import type { Finding } from "../types.js";
import { isBuildOutput, isCodeFile, isTestFile, lineOf, type SourceFile } from "../files.js";

/**
 * Built-in OWASP Top-10 static rules (fallback when semgrep is not installed). Heuristic, line/regex based,
 * tuned for low false positives on idiomatic code (parameterized queries, tagged sql``, sanitizers).
 */
export interface OwaspHit {
  rule: string;
  file: string;
  line: number;
  message: string;
  severity: "error" | "warning";
  fix: string;
}

/** Uppercase SQL (case-sensitive) — or any case when the string is passed straight to a DB call. */
const SQL_UPPER = /\b(SELECT\s[\s\S]*\bFROM|INSERT\s+INTO|UPDATE\s+\S+\s+SET|DELETE\s+FROM|REPLACE\s+INTO|MERGE\s+INTO|DROP\s+TABLE|ALTER\s+TABLE)\b/;
const SQL_ANY = /\b(select\s[\s\S]*\bfrom|insert\s+into|update\s+\S+\s+set|delete\s+from)\b/i;
const DB_CALL = /(\.(query|execute|exec|raw|unsafe|prepare|run|all|queryRawUnsafe|executeRawUnsafe)|\$queryRawUnsafe|\$executeRawUnsafe)\s*\(\s*$/;
const REQUEST_INPUT = /\b(req|request|ctx|c\.req|params|query|body|searchParams|formData|input|args|event)\b/;
// serializeJsonLd = app-kit JSON-LD serializer that escapes "<" as \u003c (safe inside <script type="application/ld+json">).
const SANITIZED = /(sanitize|DOMPurify|purify|escapeHtml|escape\(|xss\(|sanitizeHtml|serializeJsonLd\()/i;

const isComment = (t: string): boolean => /^\s*(\/\/|#|\*|\/\*)/.test(t);

function jsRules(f: SourceFile, hits: OwaspHit[]): void {
  const c = f.content;
  const handlerFile = REQUEST_INPUT.test(c);
  const add = (rule: string, line: number, message: string, severity: "error" | "warning", fix: string): void => {
    if (!hits.some((h) => h.rule === rule && h.file === f.path && h.line === line)) hits.push({ rule, file: f.path, line, message, severity, fix });
  };

  // SQL injection: untagged template literals with SQL + interpolation
  for (const m of c.matchAll(/`(?:\\[\s\S]|[^`\\])*`/g)) {
    const lit = m[0];
    if (!lit.includes("${")) continue;
    const before = c.slice(Math.max(0, (m.index ?? 0) - 40), m.index ?? 0);
    if (!SQL_UPPER.test(lit) && !(SQL_ANY.test(lit) && DB_CALL.test(before))) continue;
    if (/[\w$\])]\s*$/.test(before) && !/\b(raw|unsafe|query|execute|exec|run|all|get)\s*\(\s*$/.test(before)) continue; // tagged template => parameterized
    const interp = [...lit.matchAll(/\$\{([^}]+)\}/g)].map((x) => x[1] ?? "").join(" ");
    const line = lineOf(c, (m.index ?? 0) + lit.indexOf("${"));
    const severity = REQUEST_INPUT.test(interp) || handlerFile ? "error" : "warning";
    add(
      "owasp/sql-injection",
      line,
      `SQL built with template-literal interpolation (${interp.trim().slice(0, 60)}) — injectable`,
      severity,
      "Use a parameterized query: db.query('SELECT … WHERE name = $1', [name]) or a tagged template (sql`… ${name}`) / query builder.",
    );
  }

  f.lines.forEach((t, i) => {
    if (isComment(t)) return;
    const line = i + 1;
    // SQL via string concatenation
    if (/["'][^"']*\b(SELECT\b[^"']*\bFROM|INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM|WHERE)\b[^"']*["']\s*\+\s*[\w$(]/.test(t)) {
      add("owasp/sql-injection", line, "SQL built by string concatenation — injectable", handlerFile ? "error" : "warning", "Use a parameterized query with placeholders ($1 / ?) and pass values separately.");
    }
    if (/(?<![.\w$])eval\s*\(/.test(t)) add("owasp/eval", line, "eval() executes arbitrary code", "error", "Remove eval(); parse data with JSON.parse or use a lookup table of allowed operations.");
    if (/\bnew\s+Function\s*\(/.test(t)) add("owasp/new-function", line, "new Function() compiles arbitrary code", "error", "Remove new Function(); use explicit functions or a safe expression parser.");
    if (/(?:(?<![.\w$])|(?<=\b(?:child_process|cp|childProcess)\.))(exec|execSync)\s*\(\s*(`[^`]*\$\{|["'][^"']*["']\s*\+|[a-zA-Z_$][\w$.]*\s*[,)])/.test(t) && /child_process|execa|shelljs/.test(c) && !/\bexecFile/.test(t)) {
      add("owasp/command-injection", line, "child_process exec() with interpolated input runs through a shell", "error", "Use execFile/spawn with an argument array (no shell) and validate inputs against an allowlist.");
    }
    if (/\bspawn(Sync)?\s*\([^)]*shell\s*:\s*true/.test(t)) add("owasp/command-injection", line, "spawn with shell: true", "error", "Drop shell: true and pass arguments as an array.");
    const dsh = /dangerouslySetInnerHTML\s*=\s*\{\{\s*__html\s*:\s*([^}]+)\}\}/.exec(t);
    if (dsh && dsh[1] && !SANITIZED.test(dsh[1]) && !/^\s*["'`][^"'`$]*["'`]\s*$/.test(dsh[1])) {
      add("owasp/xss-dangerously-set-inner-html", line, `dangerouslySetInnerHTML with unsanitized value (${dsh[1].trim().slice(0, 40)})`, "error", "Render as text, or sanitize first: dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(html) }}.");
    }
    const ih = /\.(innerHTML|outerHTML)\s*(\+?=)(?!=)\s*([^;]+)/.exec(t);
    if (ih && ih[3] && !SANITIZED.test(ih[3]) && !/^\s*(["'])[^"'`]*\1\s*$/.test(ih[3])) {
      add("owasp/xss-inner-html", line, `${ih[1]} assigned a dynamic value`, "error", "Use textContent, or sanitize with DOMPurify.sanitize() before assigning innerHTML.");
    }
    if (/insertAdjacentHTML\s*\(\s*[^,]+,\s*(?!["'][^"'$]*["']\s*\))/.test(t) && !SANITIZED.test(t)) {
      add("owasp/xss-inner-html", line, "insertAdjacentHTML with a dynamic value", "error", "Sanitize with DOMPurify.sanitize() or build DOM nodes with textContent.");
    }
    if (/rejectUnauthorized\s*:\s*false|NODE_TLS_REJECT_UNAUTHORIZED['"]?\]?\s*=\s*['"]?0|strictSSL\s*:\s*false/.test(t)) {
      add("owasp/tls-verification-disabled", line, "TLS certificate verification disabled", "error", "Remove rejectUnauthorized: false / NODE_TLS_REJECT_UNAUTHORIZED=0; trust a CA bundle (ca option / NODE_EXTRA_CA_CERTS) instead.");
    }
    if (/\bjwt\.(sign|verify)\s*\([^,]+,\s*['"`][^'"`]{3,}['"`]/.test(t) || (/jose|SignJWT|jwtVerify/.test(c) && /new\s+TextEncoder\(\)\.encode\(\s*['"`][^'"`]{6,}['"`]\s*\)/.test(t))) {
      add("owasp/hardcoded-jwt-secret", line, "JWT signed/verified with a hardcoded secret", "error", "Load the signing key from the environment (process.env.JWT_SECRET) or a secrets manager, and rotate the leaked value.");
    }
    if (
      /\.redirect\(\s*(req|request|ctx|c\.req)\.(query|body|params)\b/.test(t) ||
      /\bredirect\(\s*[\w.]*searchParams\.get\(/.test(t) ||
      /NextResponse\.redirect\(\s*(new\s+URL\(\s*)?[\w.]*searchParams\.get\(/.test(t) ||
      /\.redirect\(\s*req\.(query|body)\[/.test(t) ||
      /(window\.)?location(\.href)?\s*=\s*[\w.]*(searchParams\.get|query\.|params\.)/.test(t)
    ) {
      add("owasp/open-redirect", line, "Redirect target taken from request input (open redirect)", "error", "Only redirect to relative paths or an allowlist: const next = safePath(param) ?? '/'; reject absolute URLs and '//' prefixes.");
    }
  });

  // CORS: wildcard / reflected origin together with credentials
  const wildcard = /origin\s*:\s*(['"]\*['"]|true(?![\w$]))|Access-Control-Allow-Origin['"]\s*,\s*(['"]\*['"]|req\.headers\.origin|request\.headers\.get\(['"]origin['"]\))/i;
  const creds = /credentials\s*:\s*true|Access-Control-Allow-Credentials['"]\s*,\s*['"]?true/i;
  if (wildcard.test(c) && creds.test(c)) {
    const idx = f.lines.findIndex((l) => wildcard.test(l));
    add("owasp/cors-wildcard-credentials", idx + 1, "CORS allows any origin together with credentials", "error", "Set an explicit origin allowlist (origin: ['https://app.example.com']) when credentials: true.");
  }
}

function pyRules(f: SourceFile, hits: OwaspHit[]): void {
  const c = f.content;
  const add = (rule: string, line: number, message: string, severity: "error" | "warning", fix: string): void => {
    if (!hits.some((h) => h.rule === rule && h.file === f.path && h.line === line)) hits.push({ rule, file: f.path, line, message, severity, fix });
  };
  const sqlFix = "Use DB-API parameters: cursor.execute('SELECT … WHERE id = %s', (user_id,)) or SQLAlchemy text() with bound params.";
  f.lines.forEach((t, i) => {
    if (isComment(t)) return;
    const line = i + 1;
    if (/\.(execute|executemany|executescript|raw|text|exec_driver_sql)\(\s*f(["'])(?:(?!\2).)*\b(SELECT|INSERT|UPDATE|DELETE|WHERE)\b(?:(?!\2).)*\{/i.test(t)) add("owasp/sql-injection", line, "SQL built with an f-string", "error", sqlFix);
    if (/\.(execute|executemany|raw|text)\(\s*["'][^"']*\b(SELECT|INSERT|UPDATE|DELETE|WHERE)\b[^"']*["']\s*(%\s*[(\w]|\.format\(|\+)/i.test(t)) add("owasp/sql-injection", line, "SQL built with %-formatting/format()/concatenation", "error", sqlFix);
    if (/subprocess\.\w+\([^)]*shell\s*=\s*True/.test(t)) add("owasp/command-injection", line, "subprocess with shell=True", "error", "Pass an argument list and drop shell=True: subprocess.run(['cmd', arg], check=True).");
    if (/\bos\.(system|popen)\(\s*(f["']|[^"')]+\+|[a-zA-Z_]\w*\s*\))/.test(t)) add("owasp/command-injection", line, "os.system/os.popen with dynamic input", "error", "Use subprocess.run([...]) with an argument list.");
    if (/\b(c?pickle|dill)\.loads?\(/.test(t)) add("owasp/insecure-deserialization", line, "pickle.load(s) deserializes arbitrary objects", "error", "Use json (or a schema-validated format) for untrusted data; never unpickle user input.");
    if (/\byaml\.(load|load_all)\(/.test(t) && !/Loader\s*=\s*(yaml\.)?C?SafeLoader/.test(t)) add("owasp/yaml-load", line, "yaml.load without SafeLoader", "error", "Use yaml.safe_load(data).");
    if (/\byaml\.unsafe_load\(/.test(t)) add("owasp/yaml-load", line, "yaml.unsafe_load", "error", "Use yaml.safe_load(data).");
    if (/(?<![.\w])(eval|exec)\s*\(/.test(t)) add("owasp/eval", line, "eval/exec executes arbitrary code", "error", "Remove eval/exec; use ast.literal_eval for literals or explicit dispatch.");
    if (/\bverify\s*=\s*False\b|ssl\._create_unverified_context|CERT_NONE/.test(t)) add("owasp/tls-verification-disabled", line, "TLS certificate verification disabled", "error", "Remove verify=False; pass verify='/path/to/ca.pem' if a private CA is needed.");
    if (/\bjwt\.(encode|decode)\([^,]+,\s*["'][^"']{3,}["']/.test(t)) add("owasp/hardcoded-jwt-secret", line, "JWT encoded/decoded with a hardcoded secret", "error", "Load the key from os.environ['JWT_SECRET'] or a secrets manager.");
    if (/\b(redirect|RedirectResponse)\(\s*(url\s*=\s*)?request\.(args|GET|query_params|form)/.test(t)) add("owasp/open-redirect", line, "Redirect target taken from request input", "error", "Validate the target against an allowlist or only allow relative paths.");
  });
  if (/allow_origins\s*=\s*\[\s*["']\*["']\s*\]/.test(c) && /allow_credentials\s*=\s*True/.test(c)) {
    const idx = f.lines.findIndex((l) => /allow_origins/.test(l));
    add("owasp/cors-wildcard-credentials", idx + 1, "CORSMiddleware allows any origin with credentials", "error", "List explicit origins in allow_origins when allow_credentials=True.");
  }
}

export function scanOwasp(files: SourceFile[]): OwaspHit[] {
  const hits: OwaspHit[] = [];
  for (const f of files) {
    if (!isCodeFile(f.path) || isTestFile(f.path) || isBuildOutput(f.path)) continue;
    if (f.path.endsWith(".py")) pyRules(f, hits);
    else jsRules(f, hits);
  }
  return hits;
}

export function owaspFindings(hits: OwaspHit[]): Finding[] {
  return hits.map((h) => ({ file: h.file, line: h.line, rule: h.rule, message: h.message, severity: h.severity }));
}
