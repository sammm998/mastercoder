import reactHooks from "eslint-plugin-react-hooks";
import root from "../../eslint.config.mjs";

export default [
  ...root,
  { ignores: [".next/**", "public/**", "next-env.d.ts", "playwright-report/**", "test-results/**"] },
  {
    files: ["src/**/*.{ts,tsx}"],
    plugins: { "react-hooks": reactHooks },
    rules: {
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
    },
  },
];
