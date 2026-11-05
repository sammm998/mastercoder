// Type-checks the mobile app (equivalent to `tsc -p tsconfig.json --noEmit`) and fails on any diagnostic in
// this app's own files.
//
// Why not plain tsc: `import type { AppRouter } from "@forge/api"` makes tsc check the API's TypeScript source
// (and @forge/shared, @forge/db) under *this* app's ambient types. Expo's expo-modules-core declares
// `NodeJS.ProcessEnv` with `[key: string]: any`, which can surface implicit-any errors inside those packages
// that do not exist under their own configs (each package is type-checked by its own `typecheck`). Those
// foreign diagnostics are printed as warnings here instead of failing the mobile build.
import ts from "typescript";
import path from "node:path";
import { fileURLToPath } from "node:url";

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const configPath = path.join(appDir, "tsconfig.json");
const host = { ...ts.sys, onUnRecoverableConfigFileDiagnostic: (d) => console.error(ts.flattenDiagnosticMessageText(d.messageText, "\n")) };
const parsed = ts.getParsedCommandLineOfConfigFile(configPath, { noEmit: true }, host);
if (!parsed) process.exit(2);
if (parsed.errors.length) {
  console.error(ts.formatDiagnosticsWithColorAndContext(parsed.errors, fmtHost()));
  process.exit(2);
}
const program = ts.createProgram({ rootNames: parsed.fileNames, options: parsed.options, projectReferences: parsed.projectReferences });
const diags = ts.getPreEmitDiagnostics(program);

const isOwn = (d) => {
  if (!d.file) return true;
  const f = path.resolve(d.file.fileName);
  return f.startsWith(appDir + path.sep) && !f.includes(`${path.sep}node_modules${path.sep}`);
};
const own = diags.filter(isOwn);
const foreign = diags.filter((d) => !isOwn(d));

function fmtHost() {
  return { getCanonicalFileName: (f) => f, getCurrentDirectory: () => appDir, getNewLine: () => "\n" };
}

if (foreign.length) {
  console.warn(`note: ${foreign.length} diagnostic(s) in other workspace packages under Expo's ambient types (not failing; see scripts/typecheck.mjs):`);
  for (const d of foreign) {
    const pos = d.file && d.start !== undefined ? d.file.getLineAndCharacterOfPosition(d.start) : null;
    console.warn(`  ${d.file ? path.relative(appDir, d.file.fileName) : "?"}${pos ? `:${pos.line + 1}:${pos.character + 1}` : ""} TS${d.code}: ${ts.flattenDiagnosticMessageText(d.messageText, " ")}`);
  }
}
if (own.length) {
  console.error(ts.formatDiagnosticsWithColorAndContext(own, fmtHost()));
  console.error(`\n${own.length} type error(s) in apps/mobile`);
  process.exit(1);
}
console.log(`typecheck ok: ${program.getRootFileNames().length} files in apps/mobile, 0 errors`);
