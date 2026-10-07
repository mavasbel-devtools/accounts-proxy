# Parity reference: opencode-claude-auth @ 62927412322eedfd5b1d8f08c4eb894f26e6c50a

These files are the **reference implementation** that `tests/component/parity.test.ts` compares the router against.
They are test-only and are excluded from typecheck and coverage.

| File | Origin (`git show 6292741:<path>`) | Source git blob | Edit |
|---|---|---|---|
| `RequestTransformService.ts` | `src/domain/services/RequestTransformService.ts` | `f0f2b9e6660dca7e99cf66ba2f63350d0fcb7fe4` | lines 1-2: import specifiers `@claude/domain/ports/outbound/index.ts` → `./TransformContext.ts` and `@claude/domain/services/ModelEnvelope.ts` → `./ModelEnvelope.ts` |
| `ModelEnvelope.ts` | `src/domain/services/ModelEnvelope.ts` | `ef95776e0317142bb6facdc08b0aede859c51f0d` | none |
| `TransformContext.ts` | `src/domain/ports/outbound/index.ts` lines 78-85 | — | extracted interface only |

The fixtures in `../../fixtures/plugin-6292741/` were exported the same way from `test/fixtures/` at that commit.
They are the plugin's sanitized captures of the real Claude CLI.
