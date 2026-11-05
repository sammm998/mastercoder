import { selectAdapter } from "@forge/shared";
import type { LLMProvider } from "./types.js";
import { MockLLMProvider } from "./mock.js";
import { AnthropicProvider } from "./adapters/anthropic.js";
import { OpenAIProvider } from "./adapters/openai.js";

/** LLM_PROVIDER=anthropic|openai|mock */
export function createLLM(): LLMProvider {
  return selectAdapter<LLMProvider>(
    "LLM_PROVIDER",
    {
      anthropic: () => new AnthropicProvider(),
      openai: () => new OpenAIProvider(),
      mock: () => new MockLLMProvider(),
    },
    "mock",
  ).instance;
}
