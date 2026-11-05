import type { JsonSchema } from "@forge/llm";

export type HttpMethod = "get" | "post" | "put" | "patch" | "delete" | "head" | "options";
export const HTTP_METHODS: HttpMethod[] = ["get", "post", "put", "patch", "delete", "head", "options"];

export interface ApiParameter {
  name: string;
  in: "path" | "query" | "header" | "cookie";
  required: boolean;
  description?: string;
  /** Schema as written in the spec ($refs to components/schemas kept for client generation). */
  schema: JsonSchema;
}

export interface ApiRequestBody {
  contentType: string;
  required: boolean;
  schema: JsonSchema;
}

export interface ApiOperation {
  /** Stable identifier: sanitized operationId, or method + path. Valid TS identifier and tool name. */
  id: string;
  method: HttpMethod;
  path: string;
  summary?: string;
  description?: string;
  tags: string[];
  parameters: ApiParameter[];
  requestBody?: ApiRequestBody;
  responseSchema?: JsonSchema;
  responseContentType?: string;
  /** Effective security requirements (operation-level or global). */
  security: Array<Record<string, string[]>>;
  /** DELETE, or send/pay/charge/refund/... verbs: agents must ask for approval. */
  irreversible: boolean;
  deprecated: boolean;
}

export type SecurityScheme =
  | { type: "apiKey"; in: "header" | "query" | "cookie"; name: string; description?: string }
  | { type: "http"; scheme: string; bearerFormat?: string; description?: string }
  | { type: "oauth2"; flows: Record<string, unknown>; description?: string }
  | { type: "openIdConnect"; openIdConnectUrl: string; description?: string };

export type ApiSource = "openapi-3.0" | "openapi-3.1" | "swagger-2.0" | "docs-heuristic" | "docs-llm";

export interface ImportedApi {
  title: string;
  version: string;
  description?: string;
  /** First server URL (absolute), or "" when the spec has none. */
  baseUrl: string;
  servers: string[];
  operations: ApiOperation[];
  /** components.schemas (raw, may contain $refs). */
  schemas: Record<string, JsonSchema>;
  securitySchemes: Record<string, SecurityScheme>;
  source: ApiSource;
  /** Normalized OpenAPI 3.x document (Swagger 2.0 converted). */
  document: Record<string, unknown>;
}
