// Root config plus: kit/ holds source files copied into generated projects. They are typechecked and
// linted inside those projects (see test/kit.int.test.ts), not with the platform's rules.
import root from "../../eslint.config.mjs";

export default [{ ignores: ["kit/**"] }, ...root];
