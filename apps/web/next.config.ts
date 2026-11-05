import type { NextConfig } from "next";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const monorepoRoot = fileURLToPath(new URL("../..", import.meta.url));

/**
 * y-monaco imports `monaco-editor/esm/vs/editor/editor.api.js`, which monaco-editor >= 0.53's `exports`
 * map no longer resolves (it maps `./*` to `./esm/vs/*`). Alias it to the real file so y-monaco and the
 * editor share one monaco instance.
 */
const monacoApi = require.resolve("monaco-editor/editor/editor.api.js");

/**
 * Built with webpack (`next build --webpack`): workspace packages are TypeScript source with
 * ESM-style `.js` relative imports (ADR 0001), which Turbopack cannot map to `.ts` yet. webpack's
 * extensionAlias does. See docs/decisions/0005-web-i18n.md for the app's other choices.
 */
const config: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  outputFileTracingRoot: monorepoRoot,
  transpilePackages: ["@forge/visual-edit", "monaco-editor"],
  webpack(cfg) {
    cfg.resolve ??= {};
    cfg.resolve.extensionAlias = { ".js": [".ts", ".tsx", ".js"], ".mjs": [".mts", ".mjs"] };
    cfg.resolve.alias = { ...(cfg.resolve.alias as Record<string, string>), "monaco-editor/esm/vs/editor/editor.api.js$": monacoApi };
    return cfg;
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Permissions-Policy", value: "camera=(), geolocation=(), microphone=(self)" },
          { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
        ],
      },
    ];
  },
};

export default config;
