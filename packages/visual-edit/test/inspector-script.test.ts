import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { bundleInspector, renderModule } from "../scripts/build-inspector.js";

describe("inspector-script.ts", () => {
  it("is up to date with src/inspector (run build:inspector)", async () => {
    const committed = readFileSync(join(__dirname, "../src/inspector-script.ts"), "utf8");
    expect(committed).toBe(renderModule(await bundleInspector()));
  });
});
