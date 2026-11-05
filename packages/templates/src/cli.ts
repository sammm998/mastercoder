/**
 * Scaffold a template onto disk: `tsx src/cli.ts <templateId> <targetDir> "<Project Name>"`.
 * Used for local development of templates and by humans debugging a generated project.
 */
import { resolve } from "node:path";
import { scaffold, TEMPLATE_IDS } from "./registry.js";
import { localWriter } from "./local-writer.js";

const [id, dir, name] = process.argv.slice(2);
if (!id || !dir) {
  process.stderr.write(`usage: cli <${TEMPLATE_IDS.join("|")}> <targetDir> [projectName]\n`);
  process.exit(1);
}
const res = await scaffold(id, localWriter(resolve(dir)), { projectName: name ?? "Forge App" });
process.stdout.write(`scaffolded ${res.files.length} files from ${id} into ${resolve(dir)}\n`);
