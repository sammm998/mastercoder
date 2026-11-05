# @forge/agents-runtime

User-built autonomous agents: prompt → definition → versioned agent → runs on triggers with approvals.

## API
- `AgentDefinitionSchema`, `validateDefinition`, `nextRuns`, `needsApproval`, `toolName`
- `generateDefinition(llm, prompt)` (purpose `agents.define`; rule-based mock in `mock-llm.ts`)
- `InHouseAgentRunner(llm)` — Forge's loop over any `LLMProvider`.
- `ClaudeAgentSdkRunner` — Claude Agent SDK: `query()` with Forge tools exposed through an in-process MCP server,
  built-in Claude Code tools disabled, `canUseTool` pauses irreversible actions, resume via the SDK session.
- `createAgentRunner(llm)` picks by `AGENT_RUNNER`.
- `AgentService` — persists runs (`agent_runs` log/state/cost), approvals, monthly caps, failure alerts, evals (dry run).
- Channels: `verifySlackSignature`, `handleSlackEvent`, `widgetScript`, `emailToInput`.

## Providers
| Runner | Real/mock | Configuration |
|---|---|---|
| claude-agent-sdk | real | `AGENT_RUNNER=claude-agent-sdk`, `ANTHROPIC_API_KEY` |
| inhouse | real loop (uses whichever LLM_PROVIDER is set) | `AGENT_RUNNER=inhouse` |
| mock | in-house loop + rule-based mock LLM | `LLM_PROVIDER=mock` |

## Approvals
Irreversible kinds (`send`, `pay`, `delete`, `post`) pause the run and create an `approvals` row unless the user
explicitly listed the tool in `approvals.autoApprove`. Evals always run dry (nothing irreversible executes).

## Limitations
- One irreversible action is approved at a time; others in the same turn are requested again afterwards.
- The Claude Agent SDK runner's per-run budget uses the SDK's `maxBudgetUsd`.
