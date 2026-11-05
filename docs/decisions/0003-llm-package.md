# 0003 — Separate `packages/llm`

**Decision:** The LLM provider interface, adapters (Anthropic SDK, OpenAI, Mock), pricing and metering
live in `packages/llm` rather than inside `agent-core`.

**Why:** intent-router, design critic, meetings, slides and agents-runtime all need an LLM. A shared
package avoids a dependency cycle on agent-core. The model router (complexity → model) stays in agent-core,
built on `modelForComplexity()`.

Mock LLM is a purpose-keyed registry of deterministic handlers. It exists so the platform, tests and the
benchmark harness run offline; reports always state when mock providers were used.
