import type { Plugin } from "vite";
import { tagJsxSource, relativePath } from "./tag.js";
import { INSPECTOR_SCRIPT } from "./inspector-script.js";

export interface ForgeVitePluginOptions {
  /** Inject the preview inspector into index.html (dev server only). Default true. */
  inspector?: boolean;
  /** Only tag files matching this test. Default: .jsx/.tsx outside node_modules. */
  include?: (id: string) => boolean;
}

const defaultInclude = (id: string) => /\.[jt]sx(\?.*)?$/.test(id) && !id.includes("/node_modules/");

/**
 * Vite plugin for generated apps: in `vite dev` it tags host JSX elements with `data-forge-src` and
 * loads the inspector so the Forge workspace can visually edit the preview. `vite build` is untouched.
 *
 *   import { forgeSourceTags } from "@forge/visual-edit/vite";
 *   export default defineConfig({ plugins: [forgeSourceTags(), react()] });
 */
export function forgeSourceTags(opts: ForgeVitePluginOptions = {}): Plugin {
  let root = process.cwd();
  const include = opts.include ?? defaultInclude;
  return {
    name: "forge-source-tags",
    enforce: "pre",
    apply: "serve",
    configResolved(config) {
      root = config.root;
    },
    transform(code, id) {
      if (!include(id)) return null;
      const r = tagJsxSource(code, relativePath(id, root));
      return r ? { code: r.code, map: r.map } : null;
    },
    transformIndexHtml() {
      if (opts.inspector === false) return [];
      return [{ tag: "script", attrs: { "data-forge-inspector": "" }, children: INSPECTOR_SCRIPT, injectTo: "body" }];
    },
  };
}

export default forgeSourceTags;
