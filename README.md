# @orchet/agent-sdk

[![npm version](https://img.shields.io/npm/v/@orchet/agent-sdk.svg)](https://www.npmjs.com/package/@orchet/agent-sdk)
[![node](https://img.shields.io/node/v/@orchet/agent-sdk.svg)](https://www.npmjs.com/package/@orchet/agent-sdk)

**The contract every Orchet specialist agent implements.** Manifest types, OpenAPI → Claude tool bridge, confirmation gates, attached-summary envelopes, and SDK-compliant health probes — everything an agent needs to be discovered, invoked, and trusted by the Orchet orchestrator.

[Orchet](https://orchet.ai) is a conversational AI super-agent. Specialist agents (Lumo Rentals, Splitwise, Plaid Investments, your own) plug into Orchet's chat surface via a uniform contract: declare your tools in an `agent.json` manifest, expose them as OpenAPI 3.1 routes, return summaries the chat can render. This SDK is that contract in code.

## Install

```bash
npm install @orchet/agent-sdk
```

Peer dependency on `@anthropic-ai/sdk` (>=0.27.0) is optional — only required if you use the Claude tool-bridge helpers.

## Quick example

```ts
import {
  defineManifest,
  registerTool,
  attachSummary,
  healthHandler,
} from "@orchet/agent-sdk";

export const manifest = defineManifest({
  agent_id: "weather",
  display_name: "Weather",
  base_url: "https://weather.example.com",
  tools: [
    registerTool({
      name: "get_forecast",
      description: "5-day forecast for a city",
      input_schema: { type: "object", properties: { city: { type: "string" } } },
    }),
  ],
});

// Inside your route handler
return attachSummary({
  result: forecastData,
  summary: { headline: `Mumbai: 31°C, sunny`, kind: "forecast" },
});

// Liveness probe at /health
app.get("/health", healthHandler({ agent_id: "weather", version: "1.0.0" }));
```

## What's in the box

| Module | Subpath | What it gives you |
|---|---|---|
| [`manifest`](./src/manifest.ts) | `@orchet/agent-sdk/manifest` | Typed `AgentManifest` schema + `defineManifest()` helper |
| [`openapi`](./src/openapi.ts) | `@orchet/agent-sdk/openapi` | OpenAPI 3.1 → Anthropic tool-use conversion |
| [`confirmation`](./src/confirmation.ts) | `@orchet/agent-sdk/confirmation` | Confirmation gate primitives (mutate-after-explicit-confirm pattern) |
| [`summaries`](./src/summaries.ts) | `@orchet/agent-sdk/summaries` | `attachSummary()` envelope — gives Orchet the data + the chat-renderable preview |
| [`trips`](./src/trips.ts) | `@orchet/agent-sdk/trips` | Multi-step trip / mission helpers for compound agents |
| [`health`](./src/health.ts) | `@orchet/agent-sdk/health` | SDK-compliant `/health` route handler |

Top-level `import { ... } from "@orchet/agent-sdk"` re-exports everything.

## How agents fit into Orchet

```
┌─────────────────┐     1. user prompt
│  Orchet chat    │ ────────────────────►
└────────┬────────┘
         │ 2. orchestrator picks tools from registered agents
         ▼
┌─────────────────┐     3. POST /tools/{name}
│  Orchet gateway │ ────────────────────►  Your agent (this SDK)
└─────────────────┘                          │
                                             │ 4. attachSummary({ result, summary })
         ┌───────────────────────────────────┘
         ▼
   Chat renders summary; orchestrator gets full result for next turn
```

## Scaffold a new agent

Use [`@orchet/agent-cli`](https://github.com/Orchet-AI/orchet-agent-cli) — generates a working Next.js + SDK skeleton from a vendor OpenAPI spec or from a built-in template.

```bash
npx @orchet/agent-cli
```

## Production examples

These specialist agents are built with this SDK:

- [orchet-lumo-rentals](https://github.com/Orchet-AI/orchet-lumo-rentals) — South India self-drive rentals
- [orchet-splitwise-agent](https://github.com/Orchet-AI/orchet-splitwise-agent) — Splitwise OAuth2 + REST
- [orchet-plaid-investments](https://github.com/Orchet-AI/orchet-plaid-investments) — Read-only portfolio via Plaid

## Development

```bash
npm install
npm run typecheck    # tsc --noEmit
npm run build        # tsc -p tsconfig.json → dist/
npm run smoke        # smoke tests (trips + cancellation)
npm test             # build + smoke
```

Smoke tests live in `scripts/smoke-*.mjs` and exercise the full encode/decode round-trip without spinning up a server.

## License

Apache-2.0 © Lumo Technologies / Orchet

## Links

- **Docs:** [orchet.ai/developer](https://orchet.ai/developer)
- **Marketplace:** [orchet.ai/store](https://orchet.ai/store)
- **CLI:** [@orchet/agent-cli](https://github.com/Orchet-AI/orchet-agent-cli)
- **Issues:** [github.com/Orchet-AI/orchet-agent-sdk/issues](https://github.com/Orchet-AI/orchet-agent-sdk/issues)
