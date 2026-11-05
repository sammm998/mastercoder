/**
 * Scaffolds templates into temp dirs and runs their real toolchains (npm/pip over the network).
 * vite-react-ts, hono-api, nextjs: install + typecheck + lint + test (+ build for vite and hono).
 * fastapi: venv + pip + pytest + mypy + ruff when python3 is available.
 * astro-site, expo: JSON/TS/Astro syntax validation.
 */
import { afterAll, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { getManifest, localWriter, scaffold } from "../src/index.js";
import { mustRun, validateSyntax } from "./helpers.js";

const dirs: string[] = [];
afterAll(async () => {
  if (process.env.KEEP_SCAFFOLDS) return;
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
});

async function scaffoldTmp(id: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), `forge-tpl-${id}-`));
  dirs.push(dir);
  await scaffold(id, localWriter(dir), { projectName: `Forge ${id} check` });
  return dir;
}

const NPM_INSTALL = "npm install --no-audit --no-fund --loglevel=error";

describe.each([
  { id: "vite-react-ts", build: true },
  { id: "hono-api", build: true },
  { id: "nextjs", build: false },
])("$id toolchain", ({ id, build }) => {
  it("installs, typechecks, lints and passes its tests", async () => {
    const dir = await scaffoldTmp(id);
    const m = getManifest(id);
    expect(m.install).toBe("npm install");
    await mustRun(NPM_INSTALL, dir);
    await mustRun(m.typecheck, dir);
    await mustRun(m.lint, dir);
    const out = await mustRun(m.test, dir);
    expect(out).toMatch(/passed/i);
    if (build) await mustRun(m.build, dir);
  });
});

function hasPython(): boolean {
  try {
    execSync("python3 -c 'import venv, ensurepip'", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

describe.skipIf(!hasPython())("fastapi toolchain", () => {
  it("installs with pip in a venv and passes pytest, mypy and ruff", async () => {
    const dir = await scaffoldTmp("fastapi");
    const m = getManifest("fastapi");
    await mustRun(m.install, dir);
    const out = await mustRun(m.test, dir);
    expect(out).toMatch(/passed/);
    await mustRun(m.typecheck, dir);
    await mustRun(m.lint, dir);
    await mustRun(m.build, dir);
  });
});

describe.each(["astro-site", "expo", "nextjs", "vite-react-ts", "hono-api"])("%s syntax", (id) => {
  it("every JSON/TS/Astro file is syntactically valid after substitution", async () => {
    const dir = await scaffoldTmp(id);
    expect(await validateSyntax(dir)).toEqual([]);
  });
});
