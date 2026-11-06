import { selectAdapter } from "@forge/shared";
import type { MediaProvider } from "./types.js";
import { FalMediaProvider } from "./adapters/fal.js";
import { ReplicateMediaProvider } from "./adapters/replicate.js";
import { MockMediaProvider } from "./adapters/mock.js";
import { OpenAIMediaProvider } from "./adapters/openai.js";

/** MEDIA_PROVIDER=openai|fal|replicate|mock (default mock). */
export function createMediaProvider(): MediaProvider {
  return selectAdapter<MediaProvider>(
    "MEDIA_PROVIDER",
    {
      fal: () => new FalMediaProvider(),
      replicate: () => new ReplicateMediaProvider(),
      openai: () => new OpenAIMediaProvider(),
      mock: () => new MockMediaProvider(),
    },
    "mock",
  ).instance;
}
