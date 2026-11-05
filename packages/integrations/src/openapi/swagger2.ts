import { follow, isObj, rewriteRefs } from "./refs.js";
import { HTTP_METHODS } from "./model.js";

type Obj = Record<string, unknown>;

const REF_MAP: Array<[string, string]> = [
  ["#/definitions/", "#/components/schemas/"],
  ["#/parameters/", "#/components/parameters/"],
  ["#/responses/", "#/components/responses/"],
];

const SCHEMA_KEYS = ["type", "format", "items", "enum", "default", "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "minLength", "maxLength", "pattern", "minItems", "maxItems", "uniqueItems", "multipleOf"];

function paramSchema(p: Obj): Obj {
  const s: Obj = {};
  for (const k of SCHEMA_KEYS) if (k in p) s[k] = p[k];
  if (s.type === "file") return { type: "string", format: "binary" };
  return s;
}

function convertParams(doc: Obj, params: unknown[], consumes: string[]): { parameters: Obj[]; requestBody?: Obj } {
  const parameters: Obj[] = [];
  let requestBody: Obj | undefined;
  const form: Obj = { type: "object", properties: {} as Obj, required: [] as string[] };
  let hasForm = false;
  let hasFile = false;
  for (const raw of params) {
    const p = follow(doc, raw) as Obj;
    if (!isObj(p)) continue;
    if (p.in === "body") {
      requestBody = {
        required: p.required === true,
        description: p.description,
        content: { [consumes.find((c) => c.includes("json")) ?? consumes[0] ?? "application/json"]: { schema: p.schema ?? {} } },
      };
    } else if (p.in === "formData") {
      hasForm = true;
      if (p.type === "file") hasFile = true;
      (form.properties as Obj)[String(p.name)] = { ...paramSchema(p), ...(p.description ? { description: p.description } : {}) };
      if (p.required) (form.required as string[]).push(String(p.name));
    } else {
      parameters.push({ name: p.name, in: p.in, required: p.in === "path" ? true : p.required === true, description: p.description, schema: paramSchema(p) });
    }
  }
  if (hasForm) {
    const ct = hasFile || consumes.includes("multipart/form-data") ? "multipart/form-data" : "application/x-www-form-urlencoded";
    requestBody = { required: (form.required as string[]).length > 0, content: { [ct]: { schema: form } } };
  }
  return { parameters, requestBody };
}

function convertSecurity(defs: Obj): Obj {
  const out: Obj = {};
  for (const [name, d] of Object.entries(defs)) {
    if (!isObj(d)) continue;
    if (d.type === "basic") out[name] = { type: "http", scheme: "basic", description: d.description };
    else if (d.type === "apiKey") out[name] = { type: "apiKey", in: d.in, name: d.name, description: d.description };
    else if (d.type === "oauth2") {
      const flowName = d.flow === "application" ? "clientCredentials" : d.flow === "accessCode" ? "authorizationCode" : String(d.flow ?? "implicit");
      out[name] = {
        type: "oauth2",
        description: d.description,
        flows: { [flowName]: { authorizationUrl: d.authorizationUrl, tokenUrl: d.tokenUrl, scopes: d.scopes ?? {} } },
      };
    }
  }
  return out;
}

/** Convert a Swagger 2.0 document to an OpenAPI 3.0.3 document (paths, params, bodies, definitions, security). */
export function swagger2ToOpenApi3(doc: Obj): Obj {
  const schemes = Array.isArray(doc.schemes) && doc.schemes.length ? (doc.schemes as string[]) : ["https"];
  const servers = typeof doc.host === "string" ? [{ url: `${schemes.includes("https") ? "https" : schemes[0]}://${doc.host}${typeof doc.basePath === "string" ? doc.basePath : ""}` }] : typeof doc.basePath === "string" ? [{ url: doc.basePath }] : [];
  const globalConsumes = Array.isArray(doc.consumes) ? (doc.consumes as string[]) : [];
  const globalProduces = Array.isArray(doc.produces) ? (doc.produces as string[]) : [];
  const paths: Obj = {};
  for (const [path, rawItem] of Object.entries(isObj(doc.paths) ? doc.paths : {})) {
    const item = follow(doc, rawItem) as Obj;
    if (!isObj(item)) continue;
    const shared = Array.isArray(item.parameters) ? item.parameters : [];
    const outItem: Obj = {};
    for (const m of HTTP_METHODS) {
      const op = item[m];
      if (!isObj(op)) continue;
      const consumes = Array.isArray(op.consumes) ? (op.consumes as string[]) : globalConsumes;
      const produces = Array.isArray(op.produces) ? (op.produces as string[]) : globalProduces;
      const own = Array.isArray(op.parameters) ? op.parameters : [];
      const ownNames = new Set(own.map((p) => (follow(doc, p) as Obj).name));
      const { parameters, requestBody } = convertParams(doc, [...shared.filter((p) => !ownNames.has((follow(doc, p) as Obj).name)), ...own], consumes);
      const responses: Obj = {};
      for (const [code, rawRes] of Object.entries(isObj(op.responses) ? op.responses : {})) {
        const r = follow(doc, rawRes) as Obj;
        if (!isObj(r)) continue;
        responses[code] = { description: r.description ?? "", ...(r.schema ? { content: { [produces.find((p) => p.includes("json")) ?? produces[0] ?? "application/json"]: { schema: r.schema } } } : {}) };
      }
      const { consumes: _c, produces: _p, parameters: _pa, responses: _r, ...rest } = op;
      outItem[m] = { ...rest, parameters, ...(requestBody ? { requestBody } : {}), responses };
    }
    paths[path] = outItem;
  }
  const converted: Obj = {
    openapi: "3.0.3",
    info: doc.info ?? { title: "API", version: "0" },
    servers,
    paths,
    components: {
      schemas: doc.definitions ?? {},
      securitySchemes: convertSecurity(isObj(doc.securityDefinitions) ? doc.securityDefinitions : {}),
    },
    ...(doc.security ? { security: doc.security } : {}),
    ...(doc.tags ? { tags: doc.tags } : {}),
  };
  return rewriteRefs(converted, REF_MAP) as Obj;
}
