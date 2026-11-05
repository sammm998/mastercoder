import type { WebSocket } from "ws";
import type { ApiDeps } from "./deps.js";
import type { HttpExtension } from "./server.js";
import type { AudioStreamHandler } from "./ws/gateway.js";
import type { MediaEstimator, SlidesExporter, UploadService, MeetingUrlParser, IntentClassifier, SpendChecker, BillingPort, ConnectorPort, OpenApiImporter, VaultPort, AgentDefiner } from "./services.js";

/**
 * Connects domain packages to the API through the ports in services.ts. Each package is imported
 * dynamically so a missing optional native dependency in one package never takes the API down.
 */
export async function wireServices(deps: ApiDeps): Promise<{ extensions: HttpExtension[]; audio?: AudioStreamHandler }> {
  const extensions: HttpExtension[] = [];
  const s = deps.services;

  // ---- intent router + billing ----
  const intent = await import("@forge/intent-router");
  const billing = await import("@forge/billing");
  const classifier: IntentClassifier = {
    async classify(prompt, opts) {
      const r = await intent.classify(prompt, { llm: deps.llm, source: opts.source, usage: deps.usage, project: opts.project });
      return { intents: r.intents, needsClarification: r.needsClarification, question: r.question, options: r.options, estimate: r.estimate, language: r.language };
    },
  };
  s.intent = classifier;
  const guard = new billing.SpendGuard(new billing.DrizzleUsageRepo(deps.db), new billing.DrizzleSpendCapSource(deps.db));
  const spend: SpendChecker = {
    async check(scope, projectedUsd) {
      await guard.check(scope, projectedUsd);
    },
  };
  s.spend = spend;
  const billingProvider = billing.createBillingProvider();
  const billingPort: BillingPort = {
    plans: () =>
      Object.values(billing.PLANS).map((p) => ({ id: p.id, name: p.name, monthlyUsd: p.monthlyUsd ?? 0, includedUsd: p.includedCreditUsd, limits: p.limits as unknown as Record<string, number | null>, features: p.features.map(String) })),
    async checkoutUrl(o) {
      const customerId = o.customerId ?? (await billingProvider.createCustomer({ workspaceId: o.workspaceId, email: o.email })).customerId;
      const r = await billingProvider.createCheckoutSession({ customerId, workspaceId: o.workspaceId, plan: o.plan as Parameters<typeof billingProvider.createCheckoutSession>[0]["plan"], successUrl: o.successUrl, cancelUrl: o.cancelUrl });
      return { url: r.url, customerId };
    },
    portalUrl: (o) => billingProvider.createPortalSession(o),
    priceUsage: (records) => records.reduce((a, r) => a + billing.priceUsage({ kind: r.kind as Parameters<typeof billing.priceUsage>[0]["kind"], quantity: r.quantity, costUsd: r.costUsd }), 0),
  };
  s.billing = billingPort;

  // ---- integrations: connectors, OpenAPI, vault ----
  const integ = await import("@forge/integrations");
  const connectors = integ.createConnectorProvider();
  const connectorPort: ConnectorPort = {
    provider: connectors.name,
    async listApps(locale) {
      return integ.CATALOG.map((a) => ({ app: a.slug, name: a.displayName, category: a.category, scopes: integ.describeScopes(a.slug, [], locale) }));
    },
    async initiate(o) {
      const r = await connectors.initiateConnection({ workspaceId: o.workspaceId, projectId: o.projectId, userId: o.userId, app: o.app, scopes: o.scopes, redirectUrl: o.redirectUrl });
      return { connectionId: r.connectionId, redirectUrl: r.redirectUrl, externalId: r.connectionId };
    },
    async status(id) {
      const c = await connectors.getConnection(id);
      return { status: c.status, scopes: c.scopes };
    },
    revoke: (id) => connectors.revoke(id),
  };
  s.connectors = connectorPort;
  s.connectorProvider = connectors;
  const openapi: OpenApiImporter = {
    async import(source) {
      const api = await integ.importOpenApi(source, { llm: deps.llm });
      return { title: api.title, operations: api.operations.map((o) => ({ id: o.id, method: o.method, path: o.path, summary: o.summary })), spec: api.document };
    },
    async generateClient(spec) {
      return integ.generateTypedClient(await integ.importOpenApi(spec));
    },
  };
  s.openapi = openapi;
  const vault = new integ.Vault(new integ.DrizzleSecretStore(deps.db), integ.createKeyProvider());
  const vaultPort: VaultPort = {
    async put(scope, name, value) {
      await vault.put({ workspaceId: scope.workspaceId, projectId: scope.projectId ?? null, name, value });
    },
    listNames: (scope) => vault.listNames({ workspaceId: scope.workspaceId, projectId: scope.projectId ?? null }),
    async delete(scope, name) {
      await vault.delete({ workspaceId: scope.workspaceId, projectId: scope.projectId ?? null }, name);
    },
  };
  s.vault = vaultPort;
  s.vaultImpl = vault;

  // ---- agents ----
  const agents = await import("@forge/agents-runtime");
  const definer: AgentDefiner = {
    async generate(prompt) {
      const r = await agents.generateDefinition(deps.llm, prompt);
      return { name: r.name, definition: r.definition as unknown as Record<string, unknown> };
    },
    validate(def) {
      const v = agents.validateDefinition(def);
      return v.ok ? { ok: true, definition: v.definition as unknown as Record<string, unknown> } : v;
    },
  };
  s.agents = definer;

  // ---- media ----
  const media = await import("@forge/media");
  const provider = media.createMediaProvider();
  const toJob = (kind: string, prompt: string, o: Record<string, unknown>) => {
    if (kind === "video") return { type: "text-to-video" as const, prompt, durationSec: Number(o.durationSec ?? 10), aspectRatio: "16:9" as const };
    if (kind === "remotion") return { type: "text-to-video" as const, prompt, durationSec: Number(o.durationSec ?? 20), aspectRatio: "16:9" as const };
    return { type: "text-to-image" as const, prompt, width: Number(o.width ?? 1024), height: Number(o.height ?? 1024), n: kind === "image-set" ? Number(o.n ?? 4) : Number(o.n ?? 1) };
  };
  const estimator: MediaEstimator = {
    async estimate(kind, prompt, options) {
      if (kind === "remotion") return { lowUsd: 0.01, highUsd: 0.05, breakdown: [{ label: "Remotion render (compute only)", usd: 0.03 }] };
      return provider.estimate(media.MediaJobSchema.parse(toJob(kind, prompt, options)));
    },
    async moderate(prompt) {
      const r = await media.moderate({ prompt });
      return { allowed: r.allowed, category: r.category, reason: r.reason };
    },
  };
  s.media = estimator;

  // ---- slides ----
  const slides = await import("@forge/slides");
  const exporter: SlidesExporter = {
    validateDeck(d) {
      try {
        slides.parseDeck(d);
        return { ok: true };
      } catch (e) {
        return { ok: false, error: (e as Error).message.slice(0, 500) };
      }
    },
    validateDocument(d) {
      try {
        slides.parseDoc(d);
        return { ok: true };
      } catch (e) {
        return { ok: false, error: (e as Error).message.slice(0, 500) };
      }
    },
    async exportDeck(d, format) {
      const deck = slides.parseDeck(d);
      if (format === "pptx") return { bytes: await slides.exportPptx(deck), mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation", ext: "pptx" };
      if (format === "pdf") return { bytes: await slides.exportDeckPdf(deck), mimeType: "application/pdf", ext: "pdf" };
      return { bytes: new TextEncoder().encode(slides.renderDeckHtml(deck)), mimeType: "text/html", ext: "html" };
    },
    async exportDocument(d, format) {
      const doc = slides.parseDoc(d);
      if (format === "docx") return { bytes: await slides.exportDocx(doc), mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", ext: "docx" };
      if (format === "pdf") return { bytes: await slides.exportDocPdf(doc), mimeType: "application/pdf", ext: "pdf" };
      return { bytes: new TextEncoder().encode(slides.renderDocHtml(doc)), mimeType: "text/html", ext: "html" };
    },
  };
  s.slides = exporter;

  // ---- meetings: URL parsing + resumable uploads ----
  const meetings = await import("@forge/meetings");
  const urlParser: MeetingUrlParser = {
    parse(url) {
      try {
        const p = meetings.parseMeetingUrl(url);
        return { platform: p.platform, nativeId: p.nativeId };
      } catch {
        return null;
      }
    },
  };
  s.meetingUrls = urlParser;
  const uploader = new meetings.ChunkedUploadService(deps.store, new meetings.DrizzleChunkRepo(deps.db));
  const uploads: UploadService = {
    async init(o) {
      const r = await uploader.init({ meetingId: o.meetingId, totalSize: o.totalSize, mimeType: o.mimeType, chunkSize: o.chunkSize });
      return { uploadId: r.uploadId };
    },
    async putChunk(id, index, bytes, sha) {
      await uploader.putChunk(id, index, bytes, sha);
      return { received: (await uploader.status(id)).received };
    },
    async status(id) {
      const st = await uploader.status(id);
      return { received: st.received, missing: st.missing, totalChunks: st.totalChunks };
    },
    async complete(id) {
      const r = await uploader.complete(id);
      return { storageKey: r.key, size: r.size };
    },
  };
  s.uploads = uploads;

  // ---- speech: streaming mic transcription over /ws/audio ----
  const speech = await import("@forge/speech");
  // Mock STT: register reference transcripts for the eval fixtures (STT_MOCK_FIXTURES=evals/speech/fixtures.json)
  // so streamed fixture audio returns its known text. Labelled mock behaviour; real adapters ignore this.
  if (process.env.STT_MOCK_FIXTURES && (process.env.STT_PROVIDER ?? "mock") === "mock") {
    const { readFileSync } = await import("node:fs");
    const { dirname, resolve } = await import("node:path");
    const file = resolve(process.env.STT_MOCK_FIXTURES);
    const root = resolve(dirname(file), "../..");
    const fx = JSON.parse(readFileSync(file, "utf8")) as { fixtures: Array<{ text: string; language: string; file: string }> };
    for (const f of fx.fixtures) {
      try {
        const wav = new Uint8Array(readFileSync(resolve(root, f.file)));
        speech.mockTranscriptRegistry.registerAudio(wav, { text: f.text, language: f.language });
        speech.mockTranscriptRegistry.registerAudio(speech.wavPcm(wav).pcm, { text: f.text, language: f.language });
      } catch (e) {
        deps.log.warn("stt fixture missing", { file: f.file, error: (e as Error).message });
      }
    }
  }
  const conns = new Map<string, WebSocket>();
  const simpleClients = new Set<string>();
  let seq = 0;
  const manager = new speech.StreamingSessionManager({
    provider: speech.createSttProvider(),
    send: (id, msg) => {
      const ws = conns.get(id);
      if (ws?.readyState !== 1) return;
      // Simple protocol (mobile): {type:"transcript", text, isFinal} / {type:"error"} / {type:"done"}.
      if (simpleClients.has(id)) {
        const m = msg as { type: string; text?: string; message?: string; segment?: { text: string }; transcript?: { text: string } };
        if (m.type === "transcript.partial") ws.send(JSON.stringify({ type: "transcript", text: m.text ?? m.segment?.text ?? "", isFinal: false }));
        else if (m.type === "transcript.error") ws.send(JSON.stringify({ type: "error", message: m.message ?? "transcription failed" }));
        else if (m.type === "transcript.done") {
          ws.send(JSON.stringify({ type: "transcript", text: m.transcript?.text ?? "", isFinal: true }));
          ws.send(JSON.stringify({ type: "done" }));
        }
        return;
      }
      ws.send(JSON.stringify(msg));
    },
    logger: deps.log,
  });
  const audio: AudioStreamHandler = {
    handle(ws, { userId, language }) {
      const id = `${userId}:${++seq}`;
      conns.set(id, ws);
      // Clients may send protocol JSON (audio.start / audio.chunk base64 / audio.stop) or raw binary PCM16
      // 16 kHz frames; binary frames are wrapped into protocol messages on an implicit stream.
      let implicit: { streamId: string; seq: number } | null = null;
      // Process messages strictly in order (start → chunks → stop).
      let chain: Promise<void> = Promise.resolve();
      const handle = (m: unknown) => {
        chain = chain.then(() => manager.handle(id, m)).catch(() => undefined);
      };
      ws.on("message", (data: Buffer, isBinary: boolean) => {
        if (isBinary) {
          if (!implicit) {
            implicit = { streamId: `bin${seq}`, seq: 0 };
            handle({ type: "audio.start", streamId: implicit.streamId, language, sampleRate: 16000, encoding: "pcm16" });
          }
          handle({ type: "audio.chunk", streamId: implicit.streamId, seq: implicit.seq++, data: speech.bytesToBase64(new Uint8Array(data)) });
          return;
        }
        const text = data.toString();
        let parsed: { type?: string; language?: string; sampleRate?: number } | null = null;
        try {
          parsed = JSON.parse(text) as { type?: string };
        } catch {
          parsed = null;
        }
        if (parsed?.type === "start") {
          simpleClients.add(id);
          implicit = { streamId: `s${seq}`, seq: 0 };
          handle({ type: "audio.start", streamId: implicit.streamId, language: parsed.language ?? language, sampleRate: parsed.sampleRate ?? 16000, encoding: "pcm16" });
          return;
        }
        if (parsed?.type === "stop" && implicit) {
          handle({ type: "audio.stop", streamId: implicit.streamId });
          implicit = null;
          return;
        }
        if (implicit && /"type"\s*:\s*"audio\.stop"/.test(text) && !/"streamId"/.test(text)) {
          handle({ type: "audio.stop", streamId: implicit.streamId });
          implicit = null;
          return;
        }
        handle(text);
      });
      ws.on("close", () => {
        chain = chain.then(() => manager.disconnect(id)).finally(() => {
          conns.delete(id);
          simpleClients.delete(id);
        });
      });
    },
  };

  return { extensions, audio };
}
