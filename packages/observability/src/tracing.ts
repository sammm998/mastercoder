import { trace, context, SpanStatusCode, type Attributes, type Span, type Tracer } from "@opentelemetry/api";
import { BasicTracerProvider, BatchSpanProcessor, SimpleSpanProcessor, InMemorySpanExporter, type SpanExporter, type SpanProcessor } from "@opentelemetry/sdk-trace-base";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";

export interface TracingHandle {
  tracer: Tracer;
  shutdown(): Promise<void>;
  /** Present when tracing to memory (tests, local dev without a collector). */
  memory?: InMemorySpanExporter;
}

let active: TracingHandle | null = null;

/**
 * Initialise OpenTelemetry tracing for a service. Exports OTLP/HTTP when OTEL_EXPORTER_OTLP_ENDPOINT
 * is set (e.g. an EU-hosted Grafana Tempo / Honeycomb EU / SigNoz), otherwise keeps spans in memory.
 */
export function initTracing(service: string, opts: { exporter?: SpanExporter; batch?: boolean } = {}): TracingHandle {
  if (active) return active;
  const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  const memory = !opts.exporter && !endpoint ? new InMemorySpanExporter() : undefined;
  const exporter = opts.exporter ?? (endpoint ? new OTLPTraceExporter({ url: `${endpoint.replace(/\/$/, "")}/v1/traces` }) : memory!);
  const processor: SpanProcessor = opts.batch ?? Boolean(endpoint) ? new BatchSpanProcessor(exporter) : new SimpleSpanProcessor(exporter);
  const provider = new BasicTracerProvider({
    resource: resourceFromAttributes({ "service.name": service, "deployment.environment": process.env.NODE_ENV ?? "development", "cloud.region": process.env.DATA_REGION ?? "eu-central-1" }),
    spanProcessors: [processor],
  });
  context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
  trace.setGlobalTracerProvider(provider);
  active = {
    tracer: trace.getTracer(service),
    memory,
    shutdown: async () => {
      await provider.shutdown();
      trace.disable();
      context.disable();
      active = null;
    },
  };
  return active;
}

export function tracer(): Tracer {
  return active?.tracer ?? trace.getTracer("forge");
}

/** Run fn inside a span; records exceptions and sets status. Nested calls become child spans. */
export async function withSpan<T>(name: string, attrs: Attributes, fn: (span: Span) => Promise<T>): Promise<T> {
  return tracer().startActiveSpan(name, { attributes: attrs }, async (span) => {
    try {
      const r = await fn(span);
      span.setStatus({ code: SpanStatusCode.OK });
      return r;
    } catch (e) {
      span.recordException(e as Error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: (e as Error).message });
      throw e;
    } finally {
      span.end();
    }
  });
}

/**
 * Event sink adapter that turns agent events into span events on the current agent-run span, so a
 * trace shows every phase, tool call, gate result and cost.
 */
export function spanEventRecorder(span: Span) {
  return (e: { type: string } & Record<string, unknown>) => {
    const attrs: Attributes = {};
    for (const [k, v] of Object.entries(e)) {
      if (k === "type" || k === "input" || k === "spec" || k === "directions") continue;
      if (typeof v === "string") attrs[`forge.${k}`] = v.slice(0, 500);
      else if (typeof v === "number" || typeof v === "boolean") attrs[`forge.${k}`] = v;
    }
    span.addEvent(e.type, attrs);
    if (e.type === "usage" && typeof e.costUsd === "number") {
      const prev = (span as unknown as { attributes?: Attributes }).attributes?.["forge.cost_usd"];
      span.setAttribute("forge.cost_usd", (typeof prev === "number" ? prev : 0) + e.costUsd);
    }
  };
}
