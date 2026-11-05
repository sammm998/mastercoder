#!/usr/bin/env bash
# Synthesize Swedish speech fixtures (16 kHz mono PCM16 WAV) + manifest with sha256 and reference text.
#
# Preferred TTS: Piper with the Swedish KBLab NST voice (CC0):
#   python3 -m venv .venv && .venv/bin/pip install piper-tts
#   curl -LO https://github.com/rhasspy/piper/releases/download/v0.0.2/voice-sv-se-nst-medium.tar.gz && tar xzf voice-sv-se-nst-medium.tar.gz
#   PIPER_BIN=.venv/bin/piper PIPER_MODEL=sv-se-nst-medium.onnx bash evals/speech/generate-fixtures.sh
# Fallback: espeak-ng -v sv (apt-get install -y espeak-ng). Requires ffmpeg and node.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$here/../.." && pwd)"
out="$here/audio"
voice_out="$root/evals/fixtures/voice"
mkdir -p "$out" "$voice_out"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

PIPER_BIN="${PIPER_BIN:-piper}"
PIPER_MODEL="${PIPER_MODEL:-}"
engine=""
if [ -n "$PIPER_MODEL" ] && command -v "$PIPER_BIN" >/dev/null 2>&1; then
  engine="piper"
elif command -v espeak-ng >/dev/null 2>&1; then
  engine="espeak-ng"
else
  echo "No TTS available (need piper + PIPER_MODEL, or espeak-ng). Fixtures not generated." >&2
  exit 2
fi
command -v ffmpeg >/dev/null || { echo "ffmpeg required" >&2; exit 2; }
echo "TTS engine: $engine"

# id|text
cat > "$tmp/sentences.txt" <<'EOF'
sv-01|Hej, jag vill bygga en webbshop för min blomsteraffär i Göteborg.
sv-02|Kunderna ska kunna boka tid online och få en bekräftelse via sms.
sv-03|Vi behöver en enkel hemsida med meny, öppettider och ett kontaktformulär.
sv-04|Appen ska visa dagens uppgifter och skicka en påminnelse klockan åtta på morgonen.
sv-05|Skapa en presentation om årets försäljning med tre tydliga diagram.
sv-06|Kan du göra en mobilapp där medlemmar kan anmäla sig till träningspass?
todo-sv|Bygg en att-göra-app där jag kan lägga till och bocka av uppgifter.
EOF

synth() { # text raw_out
  if [ "$engine" = "piper" ]; then
    printf '%s' "$1" | "$PIPER_BIN" -m "$PIPER_MODEL" -f "$2" >/dev/null 2>&1
  else
    espeak-ng -v sv -s 150 -w "$2" "$1" </dev/null
  fi
}

while IFS='|' read -r id text; do
  [ -n "$id" ] || continue
  synth "$text" "$tmp/$id.raw.wav"
  dest="$out/$id.wav"
  [ "$id" = "todo-sv" ] && dest="$voice_out/todo-sv.wav"
  # Deterministic output: strip metadata, bitexact muxer, 16 kHz mono s16le.
  ffmpeg -nostdin -hide_banner -loglevel error -y -i "$tmp/$id.raw.wav" -ac 1 -ar 16000 -c:a pcm_s16le -map_metadata -1 -fflags +bitexact -flags:a +bitexact "$dest"
  echo "$id|$text|$dest" >> "$tmp/done.txt"
done < "$tmp/sentences.txt"

ENGINE="$engine" ROOT="$root" node --input-type=module - "$tmp/done.txt" "$here/fixtures.json" <<'EOF'
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { relative } from "node:path";
const [list, manifestPath] = process.argv.slice(2);
const fixtures = readFileSync(list, "utf8").trim().split("\n").map((line) => {
  const [id, text, file] = line.split("|");
  const bytes = readFileSync(file);
  const dataSize = bytes.readUInt32LE(40);
  return {
    id,
    language: "sv",
    text,
    file: relative(process.env.ROOT, file),
    sha256: createHash("sha256").update(bytes).digest("hex"),
    durationSec: Math.round((dataSize / 32000) * 1000) / 1000,
  };
});
const voice = process.env.ENGINE === "piper" ? "piper sv-se-nst-medium (KBLab, CC0)" : "espeak-ng sv";
writeFileSync(manifestPath, JSON.stringify({ generatedBy: "evals/speech/generate-fixtures.sh", tts: voice, sampleRate: 16000, fixtures }, null, 2) + "\n");
console.log(`wrote ${fixtures.length} fixtures to ${manifestPath}`);
EOF
