import type { ApiDeps } from "./deps.js";
import type { HttpExtension } from "./server.js";
import type { AudioStreamHandler } from "./ws/gateway.js";

/**
 * Connects domain packages (intent-router, billing, speech, media, ...) to the API. Each package is
 * registered as it lands; see PROGRESS.md.
 */
export async function wireServices(_deps: ApiDeps): Promise<{ extensions: HttpExtension[]; audio?: AudioStreamHandler }> {
  return { extensions: [] };
}
