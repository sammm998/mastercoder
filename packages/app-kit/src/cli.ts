/**
 * Scaffold a template with app-kit features onto disk (development aid):
 *   tsx src/cli.ts <templateId> <dir> "<Project Name>" [feature ...]
 */
import { resolve } from "node:path";
import { scaffoldWithKit } from "./kit/apply.js";
import { KIT_FEATURES, type KitFeature } from "./kit/features.js";

const [id, dir, name, ...features] = process.argv.slice(2);
if (!id || !dir) {
  process.stderr.write(`usage: cli <templateId> <dir> [name] [${KIT_FEATURES.join("|")} ...]\n`);
  process.exit(1);
}
const files = await scaffoldWithKit(id, resolve(dir), { projectName: name ?? "Forge App" }, features as KitFeature[]);
process.stdout.write(`wrote ${files.length} files to ${resolve(dir)}\n`);
