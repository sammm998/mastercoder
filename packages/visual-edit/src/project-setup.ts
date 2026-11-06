/**
 * Wires visual editing into a generated Vite project: the standalone plugin file, the plugin in
 * vite.config, and its two devDependencies. Pure string transforms — the caller reads/writes files.
 */
export const PLUGIN_FILE = "forge-visual-edit.mjs";
export const PLUGIN_DEV_DEPENDENCIES: Record<string, string> = { "@babel/parser": "^7.29.0", "magic-string": "^0.30.17" };

/** Adds `forgeSourceTags()` to the first `plugins: [` array. Returns null when the config has no plugins array. */
export function patchViteConfig(src: string): string | null {
  if (src.includes("forgeSourceTags")) return src;
  if (!/plugins\s*:\s*\[/.test(src)) return null;
  const imp = `import { forgeSourceTags } from "./${PLUGIN_FILE}";\n`;
  const lines = src.split("\n");
  let lastImport = -1;
  lines.forEach((l, i) => {
    if (/^import\s/.test(l)) lastImport = i;
  });
  lines.splice(lastImport + 1, 0, imp.trimEnd());
  return lines.join("\n").replace(/plugins\s*:\s*\[/, "plugins: [forgeSourceTags(), ");
}

/** Adds the plugin's devDependencies when missing. Returns null if nothing changed or the JSON is invalid. */
export function patchPackageJson(src: string): string | null {
  let pkg: { devDependencies?: Record<string, string>; dependencies?: Record<string, string> };
  try {
    pkg = JSON.parse(src) as typeof pkg;
  } catch {
    return null;
  }
  const missing = Object.entries(PLUGIN_DEV_DEPENDENCIES).filter(([n]) => !pkg.devDependencies?.[n] && !pkg.dependencies?.[n]);
  if (!missing.length) return null;
  pkg.devDependencies = { ...(pkg.devDependencies ?? {}), ...Object.fromEntries(missing) };
  return JSON.stringify(pkg, null, 2) + "\n";
}
