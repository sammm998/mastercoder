/**
 * Speech WER eval: runs every configured STT adapter over the Swedish fixtures in fixtures.json and
 * reports word/character error rate per fixture and adapter.
 *
 *   pnpm --filter @forge/speech eval:wer            # or: npx tsx evals/speech/run-wer.ts [--json]
 *
 * mock        always runs; the fixture registry maps each WAV's sha256 to its reference → WER 0 (pipeline check only)
 * elevenlabs  runs when ELEVENLABS_API_KEY is set, otherwise reported as skipped
 * deepgram    runs when DEEPGRAM_API_KEY is set, otherwise skipped
 * whisper     runs when WHISPER_URL is set (self-hosted kb-whisper), otherwise skipped
 */
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  DeepgramSttProvider,
  ElevenLabsSttProvider,
  MockSttProvider,
  MockTranscriptRegistry,
  WhisperSttProvider,
  cer,
  sha256Hex,
  werDetails,
  type SttProvider,
} from "../../packages/speech/src/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..");

export interface Fixture {
  id: string;
  language: string;
  text: string;
  file: string;
  sha256: string;
  durationSec: number;
}

export interface FixtureResult {
  id: string;
  reference: string;
  hypothesis: string;
  wer: number;
  cer: number;
}

export interface AdapterReport {
  adapter: string;
  status: "ok" | "skipped" | "error";
  reason?: string;
  isMock: boolean;
  /** Corpus WER: total edits / total reference words. */
  wer?: number;
  cer?: number;
  results: FixtureResult[];
}

export async function loadFixtures(manifestPath = join(here, "fixtures.json")): Promise<Fixture[]> {
  const m = JSON.parse(await readFile(manifestPath, "utf8")) as { fixtures: Fixture[] };
  return m.fixtures;
}

type AdapterSpec = { name: string; make: () => SttProvider | null; missing: string };

export function configuredAdapters(env: NodeJS.ProcessEnv = process.env, registry?: MockTranscriptRegistry): AdapterSpec[] {
  return [
    { name: "mock", missing: "", make: () => new MockSttProvider({ registry }) },
    {
      name: "elevenlabs",
      missing: "ELEVENLABS_API_KEY not set",
      make: () => (env.ELEVENLABS_API_KEY ? new ElevenLabsSttProvider({ apiKey: env.ELEVENLABS_API_KEY, baseUrl: env.ELEVENLABS_BASE_URL || undefined }) : null),
    },
    {
      name: "deepgram",
      missing: "DEEPGRAM_API_KEY not set",
      make: () => (env.DEEPGRAM_API_KEY ? new DeepgramSttProvider({ apiKey: env.DEEPGRAM_API_KEY, baseUrl: env.DEEPGRAM_BASE_URL || undefined }) : null),
    },
    {
      name: "whisper",
      missing: "WHISPER_URL not set",
      make: () => (env.WHISPER_URL ? new WhisperSttProvider({ baseUrl: env.WHISPER_URL, model: env.WHISPER_MODEL || undefined, apiKey: env.WHISPER_API_KEY || undefined }) : null),
    },
  ];
}

export async function runWer(opts: { only?: string[]; env?: NodeJS.ProcessEnv; fixtures?: Fixture[] } = {}): Promise<AdapterReport[]> {
  const fixtures = opts.fixtures ?? (await loadFixtures());
  const audio = new Map<string, Uint8Array>();
  const registry = new MockTranscriptRegistry();
  for (const f of fixtures) {
    const bytes = new Uint8Array(await readFile(join(repoRoot, f.file)));
    if (sha256Hex(bytes) !== f.sha256) throw new Error(`Fixture ${f.id} does not match its sha256 (regenerate fixtures.json)`);
    audio.set(f.id, bytes);
    registry.register(f.sha256, { text: f.text, language: f.language });
  }
  const reports: AdapterReport[] = [];
  for (const spec of configuredAdapters(opts.env ?? process.env, registry)) {
    if (opts.only && !opts.only.includes(spec.name)) continue;
    const provider = spec.make();
    if (!provider) {
      reports.push({ adapter: spec.name, status: "skipped", reason: spec.missing, isMock: false, results: [] });
      continue;
    }
    const results: FixtureResult[] = [];
    let edits = 0;
    let refWords = 0;
    let cerSum = 0;
    try {
      for (const f of fixtures) {
        const t = await provider.transcribe(audio.get(f.id) as Uint8Array, { mimeType: "audio/wav", language: f.language });
        const d = werDetails(f.text, t.text, { language: f.language, numbers: true });
        const c = cer(f.text, t.text, { language: f.language, numbers: true });
        edits += d.substitutions + d.deletions + d.insertions;
        refWords += d.n;
        cerSum += c;
        results.push({ id: f.id, reference: f.text, hypothesis: t.text, wer: d.rate, cer: c });
      }
      reports.push({ adapter: spec.name, status: "ok", isMock: provider.isMock, wer: refWords ? edits / refWords : 0, cer: results.length ? cerSum / results.length : 0, results });
    } catch (e) {
      reports.push({ adapter: spec.name, status: "error", reason: (e as Error).message, isMock: provider.isMock, results });
    }
  }
  return reports;
}

export function formatReport(reports: AdapterReport[]): string {
  const lines = ["Speech WER eval (Swedish fixtures, normalized: lowercase, no punctuation, numbers → digits)", ""];
  for (const r of reports) {
    if (r.status === "skipped") lines.push(`- ${r.adapter}: SKIPPED (${r.reason})`);
    else if (r.status === "error") lines.push(`- ${r.adapter}: ERROR (${r.reason})`);
    else {
      lines.push(`- ${r.adapter}${r.isMock ? " [mock: registry lookup, not real recognition]" : ""}: WER ${(100 * (r.wer ?? 0)).toFixed(1)}% · CER ${(100 * (r.cer ?? 0)).toFixed(1)}%`);
      for (const x of r.results) lines.push(`    ${x.id.padEnd(8)} WER ${(100 * x.wer).toFixed(1).padStart(5)}%  "${x.hypothesis}"`);
    }
  }
  return lines.join("\n");
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  const json = process.argv.includes("--json");
  runWer()
    .then((reports) => {
      console.log(json ? JSON.stringify(reports, null, 2) : formatReport(reports));
      const mock = reports.find((r) => r.adapter === "mock");
      process.exitCode = mock?.status === "ok" && mock.wer === 0 && !reports.some((r) => r.status === "error") ? 0 : 1;
    })
    .catch((e: unknown) => {
      console.error(e);
      process.exitCode = 1;
    });
}
