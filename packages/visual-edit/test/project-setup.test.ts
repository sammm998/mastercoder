import { describe, it, expect } from "vitest";
import { patchViteConfig, patchPackageJson, VISUAL_EDIT_PLUGIN_SOURCE } from "../src/index.js";
import { bundlePlugin, renderPluginModule } from "../scripts/build-plugin.js";
import { readFileSync } from "node:fs";

describe("visual-edit project setup", () => {
  it("adds the plugin to a Vite config once", () => {
    const src = 'import { defineConfig } from "vite";\nimport react from "@vitejs/plugin-react";\n\nexport default defineConfig({\n  plugins: [react()],\n});\n';
    const out = patchViteConfig(src)!;
    expect(out).toContain('import { forgeSourceTags } from "./forge-visual-edit.mjs";');
    expect(out).toContain("plugins: [forgeSourceTags(), react()]");
    expect(patchViteConfig(out)).toBe(out);
    expect(patchViteConfig("export default {}")).toBeNull();
  });
  it("adds the devDependencies only when missing", () => {
    const out = patchPackageJson(JSON.stringify({ devDependencies: { vite: "^7" } }))!;
    expect(JSON.parse(out).devDependencies).toMatchObject({ vite: "^7", "@babel/parser": expect.any(String), "magic-string": expect.any(String) });
    expect(patchPackageJson(out)).toBeNull();
  });
  it("the committed standalone plugin bundle is up to date", async () => {
    expect(readFileSync(new URL("../src/plugin-bundle.ts", import.meta.url), "utf8")).toBe(renderPluginModule(await bundlePlugin()));
    expect(VISUAL_EDIT_PLUGIN_SOURCE).toContain("forge-source-tags");
  });
});
