import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["**/dist/**", "**/.next/**", "**/node_modules/**", "**/coverage/**", "**/.expo/**", ".claude/worktrees/**", "evals/fixtures/**", "packages/templates/files/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "@typescript-eslint/no-explicit-any": "error",
      "no-restricted-imports": ["error", {
        "patterns": [{ "group": ["@anthropic-ai/*", "openai", "@fal-ai/*", "replicate", "stripe", "@e2b/*", "e2b", "@daytonaio/*", "@composio/*", "@nangohq/*", "@deepgram/*", "elevenlabs"], "message": "Vendor SDKs may only be imported inside an adapters/ directory." }]
      }]
    }
  },
  { files: ["**/adapters/**"], rules: { "no-restricted-imports": "off" } }
);
