# @orchet/agent-sdk

The contract every Orchet Store agent implements, plus helpers the Orchet runtime uses to consume it.

## What this package gives you

- **Types** for the agent manifest (`AgentManifest`, `AgentUIManifest`, `AgentSLA`, …).
- **OpenAPI conventions** — the `x-orchet-*` extensions that mark tools, cost tiers, and confirmation gates.
- **Tool bridge** — convert an agent's OpenAPI 3.1 operations into Claude tool definitions the orchestrator can expose.
- **Confirmation gate** — helpers to declare money-moving tools safely.
- **Health probe** — a standard shape for liveness + readiness.
- **Error taxonomy** — well-known error codes Orchet understands and surfaces to the user.

## If you are building an agent

```ts
import { defineManifest } from "@orchet/agent-sdk";

export const manifest = defineManifest({
  agent_id: "weather-public-readonly",
  version: "1.0.0",
  domain: "https://weather.example.com",
  display_name: "Weather Public Readonly",
  one_liner: "Get current public weather for a city.",
  intents: ["weather", "forecast"],
  openapi_url: "https://weather.example.com/openapi.json",
  health_url: "https://weather.example.com/health",
  ui: { components: [] },
  sla: {
    p50_latency_ms: 800,
    p95_latency_ms: 2500,
    availability_target: 0.99,
  },
  pii_scope: [],
  requires_payment: false,
  supported_regions: ["US"],
  capabilities: {
    sdk_version: "0.6.0",
    supports_compound_bookings: false,
    implements_cancellation: false,
    payment_mode: "agent_owned",
  },
  connect: { model: "none" },
});
```

Serve the manifest at `/.well-known/agent.json`, your OpenAPI at `/openapi.json`, and the health probe at `/health`. Orchet discovers you through those endpoints.

## If you are working on Orchet runtime

```ts
import { openApiToClaudeTools, evaluateConfirmation } from "@orchet/agent-sdk";

const tools = openApiToClaudeTools(agentOpenApiDoc);
```

Orchet's router uses these helpers at boot to build the LLM tool list and at runtime to validate money-moving tool calls.

## Versioning

Follows semver. Breaking changes to the contract are major bumps and require every agent to re-pin. Agents pin on `^X.Y` in their own `package.json`.
