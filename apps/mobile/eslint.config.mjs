import reactHooks from "eslint-plugin-react-hooks";
import root from "../../eslint.config.mjs";

export default [
  ...root,
  { ignores: ["dist/**", ".expo/**", "expo-env.d.ts"] },
  {
    files: ["**/*.tsx", "**/*.ts"],
    plugins: { "react-hooks": reactHooks },
    rules: {
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
    },
  },
  {
    files: ["scripts/**/*.mjs"],
    languageOptions: { globals: { console: "readonly", process: "readonly" } },
  },
];
