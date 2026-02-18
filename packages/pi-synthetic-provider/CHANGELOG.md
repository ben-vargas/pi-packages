# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
