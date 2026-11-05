import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { vi } from "vitest";
import { LocalObjectStore } from "@forge/shared";
import { copyDirToSandbox, LocalSandboxProvider, SnapshotStore, type Sandbox } from "@forge/sandbox";

export const FIXTURES = fileURLToPath(new URL("./fixtures/", import.meta.url));

export const provider = new LocalSandboxProvider({ snapshotStore: new SnapshotStore(new LocalObjectStore(mkdtempSync(join(tmpdir(), "qg-snap-")))) });

export async function sandboxWith(fixture: string): Promise<Sandbox> {
  const sb = await provider.create({ projectId: `qg-${fixture}` });
  await copyDirToSandbox(sb, join(FIXTURES, fixture));
  return sb;
}

export async function sandboxFromFiles(files: Record<string, string>): Promise<Sandbox> {
  const sb = await provider.create({ projectId: "qg-inline" });
  for (const [p, c] of Object.entries(files)) await sb.writeFile(p, c);
  return sb;
}

/** Stub of the OSV API (https://api.osv.dev/v1): lodash < 4.17.21 is vulnerable, everything else clean. */
export function stubOsv(): ReturnType<typeof vi.fn> {
  const fn = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/querybatch")) {
      const body = JSON.parse(String(init?.body)) as { queries: Array<{ package: { name: string }; version: string }> };
      const results = body.queries.map((q) =>
        q.package.name === "lodash" && q.version !== "4.17.21" ? { vulns: [{ id: "GHSA-35jh-r3h4-6jhm" }, { id: "GHSA-p6mc-m468-83gw" }] } : {},
      );
      return new Response(JSON.stringify({ results }), { status: 200, headers: { "content-type": "application/json" } });
    }
    const id = url.split("/").pop();
    const vulns: Record<string, unknown> = {
      "GHSA-35jh-r3h4-6jhm": {
        id: "GHSA-35jh-r3h4-6jhm",
        summary: "Command Injection in lodash",
        database_specific: { severity: "HIGH" },
        affected: [{ package: { name: "lodash", ecosystem: "npm" }, ranges: [{ type: "SEMVER", events: [{ introduced: "0" }, { fixed: "4.17.21" }] }] }],
      },
      "GHSA-p6mc-m468-83gw": {
        id: "GHSA-p6mc-m468-83gw",
        summary: "Prototype Pollution in lodash",
        database_specific: { severity: "HIGH" },
        affected: [{ package: { name: "lodash", ecosystem: "npm" }, ranges: [{ type: "SEMVER", events: [{ introduced: "3.7.0" }, { fixed: "4.17.19" }] }] }],
      },
    };
    const v = id ? vulns[id] : undefined;
    return v ? new Response(JSON.stringify(v), { status: 200 }) : new Response("not found", { status: 404 });
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}
