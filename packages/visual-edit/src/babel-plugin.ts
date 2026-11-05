import type { PluginObj, PluginPass, types as BabelTypes } from "@babel/core";
import { SRC_ATTR } from "./protocol.js";
import { relativePath } from "./tag.js";

export interface ForgeSourceTagsOptions {
  /** Project root used to make paths relative (defaults to Babel's cwd). */
  root?: string;
  /** Force on/off. Defaults to on unless NODE_ENV === "production". */
  enabled?: boolean;
}

interface BabelApi {
  types: typeof BabelTypes;
  env?: () => string;
}

/**
 * Babel plugin: tag host JSX elements with `data-forge-src="path:line:col"` in development builds so the
 * preview inspector can map a clicked DOM node back to its source. A no-op in production.
 *
 *   plugins: [[require.resolve("@forge/visual-edit/babel"), { root: __dirname }]]
 */
export default function forgeSourceTagsBabel(api: BabelApi, options: ForgeSourceTagsOptions = {}): PluginObj<PluginPass> {
  const t = api.types;
  const enabled = options.enabled ?? (api.env?.() ?? process.env.NODE_ENV) !== "production";
  return {
    name: "forge-source-tags",
    visitor: {
      JSXOpeningElement(path, state) {
        if (!enabled) return;
        const node = path.node;
        const name = node.name;
        const isHost = (name.type === "JSXIdentifier" && /^[a-z]/.test(name.name)) || name.type === "JSXNamespacedName";
        if (!isHost || !node.loc) return;
        if (node.attributes.some((a) => a.type === "JSXAttribute" && a.name.type === "JSXIdentifier" && a.name.name === SRC_ATTR)) return;
        const filename = state.filename ?? state.file.opts.filename ?? "unknown";
        const root = options.root ?? state.cwd ?? process.cwd();
        const value = `${relativePath(filename, root)}:${node.loc.start.line}:${node.loc.start.column + 1}`;
        node.attributes.push(t.jsxAttribute(t.jsxIdentifier(SRC_ATTR), t.stringLiteral(value)));
      },
    },
  };
}
