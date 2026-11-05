import reactHooks from "eslint-plugin-react-hooks";
import root from "../../eslint.config.mjs";

export default [
  ...root,
  {
    files: ["**/*.tsx", "**/*.ts"],
    plugins: { "react-hooks": reactHooks },
    rules: {
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
    },
  },
];
