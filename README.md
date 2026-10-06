# inference-router

A local LLM router. It exposes **Anthropic Messages**, **OpenAI Chat Completions** and **Gemini generateContent**
endpoints on `127.0.0.1`, so any stock SDK or tool can call the subscription models directly. It routes each call to:

- **`claude-subscription`**: Claude Pro/Max OAuth, sent upstream as Anthropic Messages.
- **`antigravity`**: Google Antigravity OAuth, sent upstream through the Cloud Code Assist envelope. It serves Gemini,
  Claude and gpt-oss models.

> **Status: P1 scaffold.** No endpoint is served yet. See the plan:
> [docs/plans/2026-10-06-00-23-inference-router-plan.md](docs/plans/2026-10-06-00-23-inference-router-plan.md).

> **Terms risk.** Both providers' terms restrict third-party clients. The verbatim quotes are in
> [docs/research/2026-10-05-20-07-llm-router-from-auth-plugins.md](docs/research/2026-10-05-20-07-llm-router-from-auth-plugins.md) §3.
> Each provider stays disabled until its config sets `acknowledgeTermsRisk: true`.

## Planned dialect × provider matrix

| Inbound dialect \ Provider | claude-subscription | antigravity |
|---|---|---|
| Anthropic Messages | native passthrough | translated |
| OpenAI Chat Completions | translated | translated |
| Gemini generateContent | translated | near-native |

## Architecture

```mermaid
flowchart LR
  subgraph Clients
    A[Anthropic SDK / Claude Code]
    O[OpenAI SDK / tools]
    G[Google GenAI SDK]
  end
  subgraph apps/router
    H[HTTP inbound adapter + AuthGuard]
    S[Application services]
    C[composition root]
  end
  subgraph dialects[packages/dialect-*  inbound codecs]
    DA[anthropic]
    DO[openai]
    DG[gemini]
  end
  subgraph core[packages/core]
    D[canonical domain]
    P[ports]
  end
  subgraph providers[packages/provider-*  outbound adapters]
    PC[claude-subscription]
    PA[antigravity]
  end
  A --> H
  O --> H
  G --> H
  H --> DA & DO & DG --> S
  S --> P
  P -.implemented by.-> PC & PA
  PC --> X[(api.anthropic.com)]
  PA --> Y[(cloudcode-pa.googleapis.com)]
  C -.wires.-> H & S & PC & PA
```

The full component diagram is [docs/architecture.drawio](docs/architecture.drawio). The architecture rules are in
[AGENTS.md](AGENTS.md).

## Development

| Command | What it does |
|---|---|
| `bun install` | install the pinned toolchain (Bun 1.4.2) |
| `bun run typecheck` | `tsc --noEmit` over every workspace, test and script |
| `bun run test` | unit + component + architecture + support tests |
| `bun run coverage` | same set under istanbul; fails below 100% lines/statements/functions/branches or if a source file is never loaded |
| `bun run test:e2e` | e2e tier with daemon coverage (INCOMPLETE until P4) |
| `bun run test:live` | real-account tier (never part of `verify`) |
| `bun run verify` | the full release gate |
| `bun run fetch:specs` | re-fetch the official wire specs into `docs/reference/specs/` |

## Evidence

- [P0-E1/E5: wire specs and default port](docs/reference/2026-10-06-00-32-p0-e1-e5-specs-and-port.md)
- [P0-E6: browser-login mechanisms](docs/reference/2026-10-06-00-32-p0-e6-browser-login-mechanisms.md)
