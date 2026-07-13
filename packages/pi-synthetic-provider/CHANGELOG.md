# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.2.0] - 2026-07-12

### Added
- Thinking-level support for all six Synthetic reasoning models ([#23](https://github.com/ben-vargas/pi-packages/pull/23), follow-up to [#21](https://github.com/ben-vargas/pi-packages/issues/21)). Per-model `thinkingLevelMap` values were verified against 37 live probes of Synthetic's chat completions endpoint:
  - `hf:zai-org/GLM-5.2` and `hf:Qwen/Qwen3.6-27B`: `off` → `none`, `medium` → `medium`, `high` → `high`, `xhigh` → `max`.
  - `hf:zai-org/GLM-4.7-Flash` and `hf:nvidia/NVIDIA-Nemotron-3-Super-120B-A12B-NVFP4`: same, minus `xhigh` — their backends reject `reasoning_effort: "max"` with HTTP 400.
  - `hf:moonshotai/Kimi-K2.7-Code`: `medium`/`high`/`xhigh` (→ `max`) only; `none`/`low` leak raw `</think>` tags into message content, so `off` stays hidden.
  - `hf:MiniMaxAI/MiniMax-M3`: `medium` only; no probed value disables its reasoning, so `off` stays hidden.
  - `low` and `minimal` are hidden on all six: the provider-side `low` value verifiably *disables* reasoning on GLM-5.2, GLM-4.7-Flash, Qwen3.6-27B, and Nemotron, so mapping pi's `low` to it would silently behave like `off`.

### Changed
- `reasoning: true` is now pinned on all six reasoning overrides (previously GLM-5.2 only), so a live catalog row missing `supported_features` can no longer silently disable effort emission for the other five models.
- Supersedes two 1.1.16 claims that live probing disproved: Synthetic *does* support disabling GLM-5.2 reasoning (`reasoning_effort: "none"`), so `off` is now selectable, and pi's `low`/`medium` no longer collapse to `high` — `medium` maps to `medium` directly.

## [1.1.17] - 2026-07-04

### Changed
- Refreshed the hardcoded Synthetic fallback catalog from the live `/openai/v1/models` endpoint: added `hf:moonshotai/Kimi-K2.7-Code`, removed stale direct fallbacks that are no longer always-on, and updated current model metadata for MiniMax M3 and GPT OSS 120B.

## [1.1.16] - 2026-07-02

### Added
- Thinking-level support for `hf:zai-org/GLM-5.2` ([#21](https://github.com/ben-vargas/pi-packages/issues/21)): pi's thinking levels now map onto GLM's supported `reasoning_effort` values (`low`/`medium`/`high` → `high`, `xhigh` → `max`). `off` and `minimal` are hidden — Synthetic has no documented way to disable GLM reasoning, and omitting the field would silently run at GLM's `max` default, so the lightest selectable level is `low` (sends `high`). Applied on both the live-catalog and fallback registration paths via a new per-model compat override, which also pins `reasoning: true` so a live catalog row missing `supported_features` cannot silently disable the effort mapping; all other Synthetic models keep the shared compat until their native thinking parameters are verified through Synthetic's proxy.

## [1.1.15] - 2026-06-18

### Fixed
- Fetch and register Synthetic models during extension startup so saved defaults and enabled/scoped Synthetic models are available before pi resolves the startup model.
- Added a three-second timeout for Synthetic model catalog fetches and fall back to hardcoded models when the live catalog is unavailable or filters to no supported models.

### Changed
- Kept the session-start model refresh path aligned with startup registration by re-registering the provider with either live models or fallback models.
- Refreshed the hardcoded Synthetic fallback catalog from the authenticated `/openai/v1/models` endpoint.

## [1.1.14] - 2026-06-08

### Fixed
- Updated Synthetic provider registrations to reference `$SYNTHETIC_API_KEY` so pi resolves the environment variable instead of using a literal API key.

### Changed
- Raised the pi coding-agent peer dependency floor to 0.77.0.

## [1.1.13] - 2026-05-07

### Changed
- Updated pi SDK imports and peer dependency from `@mariozechner/*` to `@earendil-works/*` for pi 0.74.0.

## [1.1.12] - 2026-05-01

### Changed
- Replaced the hardcoded `hf:moonshotai/Kimi-K2.5` fallback with `hf:moonshotai/Kimi-K2.6`.
- Updated Kimi K2.6 fallback pricing to match the Synthetic catalog: $0.95 input / $4.00 output per million tokens.
- Updated extension usage comments and fallback tests for the Kimi K2.6 default.

### Fixed
- Corrected the fallback Kimi lineup to match the intended hardcoded defaults by removing the nonexistent `hf:nvidia/Kimi-K2.6-NVFP4` fallback.

### Removed
- Removed `hf:nvidia/Kimi-K2.5-NVFP4` from hardcoded fallback models. It can still appear from live Synthetic model discovery when available.

## [1.1.11] - 2026-04-12

### Added
- Added `hf:nvidia/NVIDIA-Nemotron-3-Super-120B-A12B-NVFP4` and `hf:zai-org/GLM-5.1` to fallback models.

### Removed
- Removed `hf:MiniMaxAI/MiniMax-M2.1`, `hf:zai-org/GLM-5`, and `hf:zai-org/GLM-4.7` from fallback models (no longer always-on).

### Changed
- Updated fallback pricing to match current Synthetic API rates:
  - `hf:moonshotai/Kimi-K2.5`: $0.45 input / $3.40 output (was $0.55/$2.19)
  - `hf:nvidia/Kimi-K2.5-NVFP4`: $0.45 input / $3.40 output (was $0.55/$2.19)
  - `hf:MiniMaxAI/MiniMax-M2.5`: $0.40 input / $2.00 output (was $0.60/$3.00)

## [1.1.10] - 2026-03-31

### Added
- Added `hf:zai-org/GLM-5` to fallback models so the provider exposes the new always-on model before the live catalog refresh completes and when the Synthetic API is unavailable.

### Docs
- Refreshed Synthetic provider docs/comments/tests to reflect GLM-5 availability and current fallback metadata.

## [1.1.9] - 2026-03-29

### Changed
- Updated the `session_start` live provider refresh path to use `pi.registerProvider(...)`, keeping Synthetic model refresh aligned with current pi runtime behavior.
- Updated `/synthetic-quota` to recognize Synthetic's hybrid and enhanced quota payloads, prioritizing rolling five-hour and weekly token limits ahead of search usage for newer accounts.
- Increased quota percentage precision in the overlay from one decimal place to two decimals for closer parity with the Synthetic website.

### Fixed
- Hid empty zero-limit tool-call buckets such as `freeToolCalls: { limit: 0, requests: 0 }` when the feature is not enabled.
- Fixed `/synthetic-quota` overlay dismissal so `Esc`, standard `Enter`, and keypad `Enter` all close the window consistently across terminal input modes.

### Docs
- Documented `/synthetic-quota` in the package README and added notes covering newer Synthetic quota systems and current pi compatibility expectations.

## [1.1.8] - 2026-02-25

### Added
- Added `hf:MiniMaxAI/MiniMax-M2.5` to fallback models for early provider registration.

### Fixed
- Mitigated startup scoped-model warnings for `synthetic/hf:MiniMaxAI/MiniMax-M2.5` when `enabledModels` are resolved before `session_start` live model refresh.
- Updated fallback metadata/docs/tests for the new MiniMax M2.5 fallback entry.

## [1.1.7] - 2026-02-19

### Changed
- Refactored monolithic `extensions/index.ts` (945 lines) into focused modules: `types.ts`, `config.ts`, `formatting.ts`, `models.ts`, `auth.ts`, `quota.ts`, and `commands/` handlers
- Main `index.ts` is now a thin orchestrator that re-exports public symbols and registers the provider, events, and commands

### Added
- New `commands.test.ts` with 15 tests covering interactive command handler flows: guard clauses, TUI overlay rendering, model selection/switch, cancel-close, and error handling
- Total test count increased from 48 to 63 across the project

## [1.1.6] - 2026-02-19

### Fixed
- Adjusted `/synthetic-models` overlay anchoring/offset so the modal opens higher (top-centered), matching `/synthetic-quota` behavior on typical terminal sizes.

## [1.1.5] - 2026-02-18

### Fixed
- Updated `/synthetic-quota` parsing to support Synthetic’s current `/v2/quotas` response key `freeToolCalls` in addition to older `toolCallDiscounts` payloads.

## [1.1.4] - 2026-02-11

### Added
- Added `/synthetic-quota` command to display Synthetic API quota usage from `/v2/quotas`
- Added a themed interactive quota overlay with progress bars and color-coded usage states
- Added helper utilities for quota display formatting and usage coloring

## [1.1.3] - 2026-02-11

### Added
- Redesigned `/synthetic-models` as an interactive, bordered overlay catalog instead of raw terminal log output
- Added direct model switching from the catalog: pressing `Enter` now sets the active model immediately
- Added responsive overlay sizing/placement for smaller terminals (dynamic width/height/offset behavior)
- Added datacenter location display with full country names (for example, `United States (US)`)

### Changed
- Prioritized Synthetic-hosted models in the catalog sort order (shown before other providers)
- Improved catalog row alignment with fixed-width columns and clearer headers

### Fixed
- Fixed `/synthetic-models` overlay rendering clashes with the footer/status area caused by raw `console.log` output
- Fixed details panel crash when `context_length` or `max_output_length` is missing in API responses
- Clarified cache pricing label in table header as `R-Cache`

## [1.1.2] - 2026-02-11

### Added
- Added CHANGELOG.md to track version history
- Added datacenter locations section to `/synthetic-models` output for Synthetic-hosted models
- New `datacenters` field in `SyntheticModel` interface to capture API-provided location data

## [1.1.1] - 2026-02-10

### Added
- Added `hf:nvidia/Kimi-K2.5-NVFP4` to fallback models (NVIDIA FP4 quantized variant)

### Fixed
- Updated pricing for all fallback models to match current Synthetic API rates:
  - `hf:moonshotai/Kimi-K2.5`: $0.55 input / $2.19 output (was $1.20/$1.20)
  - `hf:nvidia/Kimi-K2.5-NVFP4`: $0.55 input / $2.19 output
  - `hf:MiniMaxAI/MiniMax-M2.1`: $0.30 input / $1.20 output (was $0.55/$2.19)
  - `hf:zai-org/GLM-4.7`: $0.55 input / $2.19 output

## [1.1.0] - 2026-02-01

### Added
- Added root `pi` manifest for git-based installs
- Added LICENSE file to package
- Expanded npm keywords for discoverability
- Added CI checks and lightweight extension tests

### Fixed
- Updated extension for pi 0.51.0 compatibility
- Fixed to use `ctx.modelRegistry.registerProvider()` for live model updates in `session_start` handler
- Fixed to register provider synchronously during loading (not just in event handler)
- Fixed `/synthetic-models` to show all always-on models, not just tools-annotated ones
- Redesigned `/synthetic-models` table layout for better readability
- Renamed "Cache" column to "R-Cache" for clarity
- Reduced startup log noise

### Changed
- Scoped npm package name to `@benvargas/pi-synthetic-provider`
- Documentation: clarified root `index.ts` as extension entry point
- Documentation: added git install option to README

## [1.0.0] - 2026-01-29

### Added
- Initial release of Synthetic (synthetic.new) model provider for pi
- Dynamic model discovery from Synthetic API at session start
- Fallback models for offline operation: Kimi-K2.5, MiniMax-M2.1, GLM-4.7
- OpenAI Completions API compatibility with built-in streaming support
- Automatic capability detection: reasoning, vision, and tool calling
- Cost tracking with per-token pricing from API
- Multiple authentication methods: env var (`SYNTHETIC_API_KEY`), `auth.json`, CLI flag
- `/synthetic-models` slash command for browsing the model catalog with pricing
- Graceful degradation: uses fallback models if Synthetic API is unavailable
