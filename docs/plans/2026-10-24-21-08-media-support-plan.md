# Media support: measured evidence and the Antigravity media rules (plan M1)

Approved by the user on 2026-10-24 ("Can we proceed as recommended?"), after the media investigation listed four
gaps: G1 Antigravity refused `fileData` and media-output settings without proof either way; G2 audio and video were
never sent live; G3 OpenAI and the four gateways had no live media proof; G4 Claude URL sources and the Files API were
untested. This plan extends the live-evidence work of [live validation](2026-10-13-01-42-live-validation-plan.md) and
[P6](2026-10-17-22-59-p6-live-results-plan.md); no earlier plan is changed.

## 1. Steps

| Step | What | Status |
|---|---|---|
| M1.1 | Media fixtures that only a model that read the medium can answer: a PNG, a spoken WAV and a VP9 WebM carrying the code word `PELICAN` (`scripts/evidence/media-fixtures.ts`, `tests/fixtures/media/` with a sha256 manifest; the PDF is `codeWordPdf` of e3-fidelity.ts) | done |
| M1.2 | Live probe through the production daemon with the official SDKs, every provider, every medium its list names (`scripts/evidence/live/m1-media-probe.ts`, part D) | done |
| M1.3 | The Antigravity features the proxy refused, sent straight to Cloud Code Assist with no proxy rules (part U) | done |
| M1.4 | Allow on the Antigravity Gemini cell exactly what part U proved; unit and e2e tests | done |
| M1.5 | Claude: URL sources and the Files API through the proxy | measured; nothing changed (§3) |
| M1.6 | Docs: providers, format fields, AGENTS.md wire-law row; `bun run verify` | done (§4) |

Shared code: the daemon start/stop of the live matrix moved to `scripts/evidence/live/daemon.ts` (used by l1 and m1).
The live redactor gained `fixture()` (a committed payload is written as `<FIXTURE:name>`) and accepts the ordered
header pairs the Claude client profile sends (it failed on them: `out.split is not a function`).

## 2. Results (record: [M1 media probe](../reference/2026-10-24-21-05-m1-media-probe.md), captures `tests/fixtures/captures/p0-live/m1/`)

| Gap | Result |
|---|---|
| G1 | Upstream (part U): `fileData` by URL answered for a PDF (u2) and an image (u1); `responseModalities: ["TEXT","IMAGE"]` returned an image on `gemini-3.1-flash-image` (u3); `mediaResolution` LOW, MEDIUM and HIGH answered (u4–u6). The cell now carries them (M1.4) and the daemon probes confirm it end to end (`antigravity-filedata-pdf-url`, `antigravity-image-out`, `antigravity-media-resolution`). |
| G2 | Audio (WAV) and video (WebM) were read on Antigravity and OpenCode Gemini models, video on OpenCode Go `glm-5.3-flash`. Claude models on Antigravity read images and PDFs, but video answers the upstream's 500 "Unknown Error." in every run. |
| G3 | OpenAI: `input_image` and `input_file`, inline and by URL, read. OpenCode, OpenCode Go and Cheaper Inference: images read (Cheaper Inference on Chat and Responses). OpenRouter: not measurable, the stored key answers 401 "User not found.". |
| G4 | Claude: images and PDFs by `url` source read. The Files API is not served (§3). |

Observations from the console of the two earlier full runs of the same day (their captures were replaced by the final
run and are not kept): u1 once answered 400 "Cannot fetch content from the provided URL." for the Wikimedia image URL
before answering 200 on the next two runs, so a `fileData` URL depends on the upstream's own fetch; with an 8×8
single-colour PNG, Cheaper Inference answered "Black", then "Red" (Chat) and "I can't see the image" (Responses), which
is why the image probes now use a PNG carrying a word.

## 3. Decisions and what stays open

| Item | Decision / state |
|---|---|
| Claude Files API (`POST /anthropic/v1/files`, `file` sources with `files-api-2025-04-14`) | Not added. No capture shows Claude Code 2.1.304 calling it, and the proxy makes only calls its client makes (AGENTS.md, recon parity). Today the upload path answers 400 "request body is not valid JSON" and the beta answers 400 `unsupported_feature`. |
| Antigravity audio output (`responseModalities: AUDIO`), other `mediaResolution` values, `fileData.displayName`, `videoMetadata` | Still refused: never probed. |
| Antigravity Claude models and video | Measured upstream 500; the proxy forwards it unchanged (no refusal is invented). The model list still names video for these models (from the reference catalog). |
| OpenRouter media | Needs `bun run proxy login openrouter` by the user, then `ACCOUNTS_PROXY_LIVE=1 bun scripts/evidence/live/m1-media-probe.ts --only=openrouter`. |
| Cheaper Inference model list | States no input media on any of its 318 models; the reference catalog has no provider for it (rule M2). |

## 4. Verification

- Unit: `packages/provider-antigravity/tests/unit/native-gemini.test.ts` (fileData shapes, unknown fileData keys,
  modalities and resolutions strict and lossy), `scripts/tests/unit/live-evidence.test.ts` (ordered headers,
  fixtures).
- E2E: `apps/proxy/tests/e2e/gemini-cell.test.ts` drives every new rule through the daemon and asserts the request the
  replay upstream received.
- Fixtures: `bun scripts/evidence/media-fixtures.ts --check`. Tool provenance is in the manifest: the WebM was encoded
  by `ffmpeg n9.0.2-33-g4cf298e66a-20261022` (`ACCOUNTS_PROXY_FFMPEG`), because the Playwright ffmpeg build 1013 used
  first was removed from `~/.cache/ms-playwright` by another process at 20:46:59 during the work and build 1011 has no
  VP9 encoder.
- Gate: `bun run verify` on 2026-10-24: GATE: PASS, exit 0; 895 unit+component+arch tests and 257 e2e tests pass;
  100% lines, statements, functions and branches on every tier, complete, 0 deferrals; docs lint PASS (58 files).
- Account files: of the seven files in `~/.local/share/accounts-proxy/`, only `accounts-openai.json` changed during
  the probe runs: the proxy renewed its own OpenAI token (the `200 token` call of the first run), as the renewal
  rules require. No other file changed.
