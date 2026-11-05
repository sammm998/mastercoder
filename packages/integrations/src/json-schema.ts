import { z, type ZodTypeAny } from "zod";
import type { JsonSchema } from "@forge/llm";

type S = Record<string, unknown>;

function isObj(v: unknown): v is S {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function withMeta(t: ZodTypeAny, s: S): ZodTypeAny {
  let out = t;
  if (typeof s.description === "string" && s.description) out = out.describe(s.description);
  return out;
}

function stringType(s: S): ZodTypeAny {
  let t = z.string();
  if (typeof s.minLength === "number") t = t.min(s.minLength);
  if (typeof s.maxLength === "number") t = t.max(s.maxLength);
  if (s.format === "email") t = t.email();
  if (s.format === "uri" || s.format === "url") t = t.url();
  if (typeof s.pattern === "string") {
    try {
      t = t.regex(new RegExp(s.pattern));
    } catch {
      /* invalid pattern in vendor schema: ignore constraint */
    }
  }
  return t;
}

function numberType(s: S, integer: boolean): ZodTypeAny {
  let t = z.number();
  if (integer) t = t.int();
  if (typeof s.minimum === "number") t = t.gte(s.minimum);
  if (typeof s.maximum === "number") t = t.lte(s.maximum);
  if (typeof s.exclusiveMinimum === "number") t = t.gt(s.exclusiveMinimum);
  if (typeof s.exclusiveMaximum === "number") t = t.lt(s.exclusiveMaximum);
  return t;
}

function literalUnion(values: unknown[]): ZodTypeAny {
  const lits = values.filter((v): v is string | number | boolean | null => v === null || ["string", "number", "boolean"].includes(typeof v)).map((v) => z.literal(v));
  if (lits.length === 0) return z.unknown();
  if (lits.length === 1) return lits[0]!;
  return z.union(lits as unknown as [ZodTypeAny, ZodTypeAny, ...ZodTypeAny[]]);
}

function union(types: ZodTypeAny[]): ZodTypeAny {
  if (types.length === 0) return z.unknown();
  if (types.length === 1) return types[0]!;
  return z.union(types as unknown as [ZodTypeAny, ZodTypeAny, ...ZodTypeAny[]]);
}

/**
 * Convert a (dereferenced) JSON schema / OpenAPI schema object to zod, so vendor/OpenAPI/MCP tool inputs
 * are validated before execution and re-exported as JSON schema by `toToolDef`.
 * Unsupported constructs degrade to `z.unknown()` (accept, never reject valid input).
 */
export function jsonSchemaToZod(schema: unknown, depth = 0): ZodTypeAny {
  if (!isObj(schema) || depth > 24) return z.unknown();
  const s = schema;
  let t: ZodTypeAny;
  if ("const" in s) t = literalUnion([s.const]);
  else if (Array.isArray(s.enum)) t = literalUnion(s.enum);
  else if (Array.isArray(s.anyOf) || Array.isArray(s.oneOf)) {
    const alts = ((s.anyOf ?? s.oneOf) as unknown[]).map((x) => jsonSchemaToZod(x, depth + 1));
    t = union(alts);
  } else if (Array.isArray(s.allOf)) {
    const parts = s.allOf.filter(isObj);
    if (parts.every((p) => p.type === "object" || isObj(p.properties))) {
      const merged: S = { type: "object", properties: {}, required: [] };
      for (const p of parts) {
        Object.assign(merged.properties as S, (p.properties as S) ?? {});
        (merged.required as string[]).push(...(((p.required as string[]) ?? []) as string[]));
      }
      t = jsonSchemaToZod(merged, depth + 1);
    } else t = parts.length ? jsonSchemaToZod(parts[0], depth + 1) : z.unknown();
  } else {
    const types = Array.isArray(s.type) ? (s.type as string[]) : typeof s.type === "string" ? [s.type] : [];
    const inferred = types.length ? types : isObj(s.properties) ? ["object"] : isObj(s.items) ? ["array"] : [];
    const nonNull = inferred.filter((x) => x !== "null");
    const one = (ty: string): ZodTypeAny => {
      switch (ty) {
        case "string":
          return stringType(s);
        case "number":
          return numberType(s, false);
        case "integer":
          return numberType(s, true);
        case "boolean":
          return z.boolean();
        case "array": {
          let a = z.array(jsonSchemaToZod(s.items, depth + 1));
          if (typeof s.minItems === "number") a = a.min(s.minItems);
          if (typeof s.maxItems === "number") a = a.max(s.maxItems);
          return a;
        }
        case "object":
          return objectType(s, depth);
        default:
          return z.unknown();
      }
    };
    t = nonNull.length === 0 ? (inferred.includes("null") ? z.null() : z.unknown()) : union(nonNull.map(one));
    if (inferred.includes("null") && nonNull.length) t = t.nullable();
  }
  if (s.nullable === true) t = t.nullable();
  return withMeta(t, s);
}

function objectType(s: S, depth: number): ZodTypeAny {
  const props = isObj(s.properties) ? s.properties : {};
  const required = new Set(Array.isArray(s.required) ? (s.required as string[]) : []);
  const shape: Record<string, ZodTypeAny> = {};
  for (const [k, v] of Object.entries(props)) {
    const pt = jsonSchemaToZod(v, depth + 1);
    shape[k] = required.has(k) ? pt : pt.optional();
  }
  const obj = z.object(shape);
  if (s.additionalProperties === false) return obj.strict();
  if (isObj(s.additionalProperties)) return obj.catchall(jsonSchemaToZod(s.additionalProperties, depth + 1));
  return obj.passthrough();
}

/** Convenience: an object schema with the given properties/required list. */
export function objectSchema(properties: Record<string, JsonSchema>, required: string[] = []): JsonSchema {
  return { type: "object", properties, required, additionalProperties: false };
}
