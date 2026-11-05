import { describe, it, expect } from "vitest";
import { runWer, loadFixtures, formatReport } from "../../../evals/speech/run-wer.js";
import { decodeWavHeader } from "../src/wav.js";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));

/** Per-adapter WER eval over the Swedish TTS fixtures (evals/speech). Real adapters run only with credentials. */
describe("evals/speech WER", () => {
  it("has >= 5 Swedish 16 kHz mono fixtures plus the voice prompt fixture", async () => {
    const fx = await loadFixtures();
    expect(fx.length).toBeGreaterThanOrEqual(6);
    for (const f of fx) {
      const info = decodeWavHeader(new Uint8Array(await readFile(repoRoot + f.file)));
      expect(info.sampleRate).toBe(16000);
      expect(info.channels).toBe(1);
      expect(info.durationSec).toBeCloseTo(f.durationSec, 2);
    }
    expect(fx.find((f) => f.id === "todo-sv")?.text).toBe("Bygg en att-göra-app där jag kan lägga till och bocka av uppgifter.");
  });

  it("mock adapter: registry lookup by sha256 → WER 0 on every fixture", async () => {
    const [mock] = await runWer({ only: ["mock"] });
    expect(mock).toMatchObject({ adapter: "mock", status: "ok", isMock: true, wer: 0, cer: 0 });
    expect(mock!.results.length).toBeGreaterThanOrEqual(6);
  });

  for (const adapter of ["elevenlabs", "deepgram", "whisper"]) {
    it(`${adapter}: reported as skipped without credentials`, async () => {
      const [r] = await runWer({ only: [adapter], env: {} });
      expect(r).toMatchObject({ adapter, status: "skipped" });
      expect(formatReport([r!])).toContain("SKIPPED");
    });
  }
});
