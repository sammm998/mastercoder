import { generateNextjsAuth } from "./gen-nextjs-auth.js";
import { generateWebLocal } from "./gen-web-local.js";
import { generateHono } from "./gen-hono.js";
import { generateFastapi } from "./gen-fastapi.js";
import { generateExpo } from "./gen-expo.js";
import { emptyProject, type GenerateContext, type GeneratedProject } from "./types.js";

export class UnsupportedBuildError extends Error {}

/** Pick the generator for a template + spec and produce the project files (pure, deterministic). */
export function generateProject(ctx: GenerateContext): GeneratedProject {
  const t = ctx.templateId;
  if (t === "nextjs") {
    if (ctx.spec.auth) {
      if (!ctx.files.includes("src/lib/session.ts") || !ctx.files.includes("src/db/with-user.ts")) {
        throw new UnsupportedBuildError("The spec needs sign-in, but the app-kit auth/db files (src/lib/session.ts, src/db/with-user.ts) are not in the project; scaffold the template with the auth kit first.");
      }
      return generateNextjsAuth(ctx);
    }
    return generateWebLocal(ctx, "next");
  }
  if (t === "vite-react-ts") return generateWebLocal(ctx, "vite");
  if (t === "hono-api") return generateHono(ctx);
  if (t === "fastapi") return generateFastapi(ctx);
  if (t === "expo") return generateExpo(ctx);
  return emptyProject(`unsupported:${t}`);
}
