// Package-local ESLint config: the repo config plus an ignore for the deliberately insecure test fixtures.
import root from "../../eslint.config.mjs";

export default [{ ignores: ["test/fixtures/**"] }, ...root];
