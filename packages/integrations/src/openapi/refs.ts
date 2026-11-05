type Obj = Record<string, unknown>;

export function isObj(v: unknown): v is Obj {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Resolve a local JSON pointer ("#/components/schemas/Pet"). Returns undefined for remote/missing refs. */
export function resolvePointer(doc: unknown, ref: string): unknown {
  if (!ref.startsWith("#")) return undefined;
  const parts = ref
    .slice(1)
    .split("/")
    .filter((p, i) => !(i === 0 && p === ""))
    .map((p) => decodeURIComponent(p).replace(/~1/g, "/").replace(/~0/g, "~"));
  let cur: unknown = doc;
  for (const p of parts) {
    if (Array.isArray(cur)) cur = cur[Number(p)];
    else if (isObj(cur)) cur = cur[p];
    else return undefined;
  }
  return cur;
}

/** Inline one level: if node is {$ref}, follow local refs (chains included) until a non-ref node. */
export function follow(doc: unknown, node: unknown, max = 32): unknown {
  let cur = node;
  for (let i = 0; i < max && isObj(cur) && typeof cur.$ref === "string"; i++) {
    const next = resolvePointer(doc, cur.$ref);
    if (next === undefined) return {};
    cur = next;
  }
  return cur;
}

/**
 * Fully dereference local $refs inside `node`. Cycles are cut with `{ description: "(recursive <ref>)" }`
 * so the result is always a finite tree (safe for zod conversion and LLM tool schemas).
 * Remote refs (other files/URLs) are not fetched: they become `{}` (accept anything).
 */
export function deref(doc: unknown, node: unknown, stack: string[] = []): unknown {
  if (Array.isArray(node)) return node.map((n) => deref(doc, n, stack));
  if (!isObj(node)) return node;
  if (typeof node.$ref === "string") {
    const ref = node.$ref;
    if (stack.includes(ref)) return { description: `(recursive ${ref.split("/").pop()})` };
    const target = resolvePointer(doc, ref);
    if (target === undefined) return {};
    const { $ref: _r, ...siblings } = node;
    const resolved = deref(doc, target, [...stack, ref]);
    return isObj(resolved) ? { ...resolved, ...siblings } : resolved;
  }
  const out: Obj = {};
  for (const [k, v] of Object.entries(node)) out[k] = deref(doc, v, stack);
  return out;
}

/** Rewrite $ref prefixes throughout a tree (Swagger 2 -> OpenAPI 3 component locations). */
export function rewriteRefs(node: unknown, map: Array<[string, string]>): unknown {
  if (Array.isArray(node)) return node.map((n) => rewriteRefs(n, map));
  if (!isObj(node)) return node;
  const out: Obj = {};
  for (const [k, v] of Object.entries(node)) {
    if (k === "$ref" && typeof v === "string") {
      const m = map.find(([from]) => v.startsWith(from));
      out[k] = m ? m[1] + v.slice(m[0].length) : v;
    } else out[k] = rewriteRefs(v, map);
  }
  return out;
}
