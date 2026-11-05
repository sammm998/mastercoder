/** Small source-text utilities (balanced-bracket scanning that skips strings and comments). */

/** Index just past the bracket matching the opener at `open` (one of ( [ {), or -1. */
export function matchBracket(src: string, open: number): number {
  const pairs: Record<string, string> = { "(": ")", "[": "]", "{": "}" };
  const stack: string[] = [];
  for (let i = open; i < src.length; i++) {
    const ch = src[i]!;
    const next = src[i + 1];
    if (ch === "/" && next === "/") {
      const nl = src.indexOf("\n", i);
      i = nl === -1 ? src.length : nl;
      continue;
    }
    if (ch === "/" && next === "*") {
      const end = src.indexOf("*/", i + 2);
      i = end === -1 ? src.length : end + 1;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      i = skipString(src, i);
      continue;
    }
    if (pairs[ch]) stack.push(pairs[ch]!);
    else if (ch === ")" || ch === "]" || ch === "}") {
      if (stack.pop() !== ch) return -1;
      if (stack.length === 0) return i + 1;
    }
  }
  return -1;
}

/** Index of the closing quote of the string starting at `i` (handles template `${}` nesting). */
export function skipString(src: string, i: number): number {
  const q = src[i]!;
  for (let j = i + 1; j < src.length; j++) {
    const ch = src[j];
    if (ch === "\\") {
      j++;
      continue;
    }
    if (q === "`" && ch === "$" && src[j + 1] === "{") {
      const end = matchBracket(src, j + 1);
      if (end === -1) return src.length;
      j = end - 1;
      continue;
    }
    if (ch === q) return j;
    if (q !== "`" && ch === "\n") return j;
  }
  return src.length;
}

/** Text of a JS/TS function starting at `start` (declaration or `const X = ...` expression). */
export function extractJsBlock(src: string, start: number): string {
  const eq = src.indexOf("=", start);
  const paren = src.indexOf("(", start);
  const isConst = /^\s*(export\s+)?(const|let|var)\b/.test(src.slice(start, start + 30)) && eq !== -1 && (paren === -1 || eq < paren);
  if (!isConst) {
    if (paren === -1) return src.slice(start, start + 200);
    const afterParams = matchBracket(src, paren);
    if (afterParams === -1) return src.slice(start);
    const brace = src.indexOf("{", afterParams);
    if (brace === -1) return src.slice(start, afterParams);
    const end = matchBracket(src, brace);
    return src.slice(start, end === -1 ? src.length : end);
  }
  // const X = <expr>; — scan to the end of the statement at depth 0
  let i = eq + 1;
  let sawBlock = false;
  while (i < src.length) {
    const ch = src[i]!;
    if (ch === "(" || ch === "[" || ch === "{") {
      const end = matchBracket(src, i);
      if (end === -1) return src.slice(start);
      i = end;
      sawBlock = true;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      i = skipString(src, i) + 1;
      continue;
    }
    if (ch === ";") return src.slice(start, i);
    if (ch === "\n" && sawBlock) {
      const rest = src.slice(i + 1).match(/^\s*(\S)/);
      if (!rest || !/[.)\]?:|&+\-*/,]/.test(rest[1] ?? "")) return src.slice(start, i);
    }
    i++;
  }
  return src.slice(start);
}

/** Python: decorator/def block starting at the line index `defLine` (until dedent). */
export function extractPyBlock(lines: string[], defLine: number): { text: string; params: string } {
  const def = lines[defLine] ?? "";
  const indent = def.length - def.trimStart().length;
  let j = defLine;
  // signature may span lines until "):" / ") ->"
  let sig = def;
  while (!/\)\s*(->[^:]*)?:\s*(#.*)?$/.test(sig) && j + 1 < lines.length) {
    j++;
    sig += "\n" + lines[j];
  }
  const params = sig.slice(sig.indexOf("(") + 1, sig.lastIndexOf(")"));
  const body: string[] = [sig];
  for (let k = j + 1; k < lines.length; k++) {
    const l = lines[k]!;
    if (l.trim() === "") {
      body.push(l);
      continue;
    }
    const ind = l.length - l.trimStart().length;
    if (ind <= indent) break;
    body.push(l);
  }
  return { text: body.join("\n"), params };
}

/** First meaningful statement is a directive like "use client" / "use server". */
export function hasDirective(content: string, directive: string): boolean {
  const stripped = content.replace(/^\uFEFF/, "").replace(/^(\s*(\/\/[^\n]*|\/\*[\s\S]*?\*\/))*\s*/, "");
  return new RegExp(`^['"]${directive}['"]`).test(stripped);
}
