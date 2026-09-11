# Changelog

All notable changes to this package will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this package adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.1.1] - 2026-09-11

### Added
- Added fast mode support for `gpt-6-astra` (new in pi 0.85.1) on both the `openai` and `openai-codex` providers. OpenAI's pricing page lists a Fast-mode row for `gpt-6-astra` at 2x Standard ($20 input, $2 cached input, $25 cache writes, $100 output per 1M tokens, short context) and the Fast mode guide notes Astra Fast mode has no latency SLA and is unavailable with EU data residency; the Codex CLI model catalog advertises a `priority` ("Fast", "2x speed, increased usage") service tier for it. `service_tier: "priority"` remains accepted alongside `"fast"`.

### Changed
- Extended the legacy default model list migration so configs on the previous eleven-model default (1.1.0) upgrade to the current defaults; customized `supportedModels` lists are left untouched.

## [1.1.0] - 2026-08-06

### Added
- Added fast mode support for `openai/gpt-5.4-mini`, which OpenAI's Fast pricing table lists at $1.50 input, $0.15 cached input, and $9.00 output. `gpt-5.4-nano`, `gpt-5.4-pro`, and `gpt-5.5-pro` are absent from that table and remain excluded.
- Added support for relocated agent directories: the global config path now resolves through pi's `getAgentDir()`, honoring `PI_CODING_AGENT_DIR`.

### Changed
- A config written by an earlier release to `~/.pi/agent/extensions/` is copied once into a relocated agent directory that has no config of its own. The legacy file is never overwritten or deleted, and the copy is skipped when the paths are identical. Because this extension persists state at runtime, migrating gives it a single source of truth rather than splitting reads and writes across two files.
- Extended the legacy default model list migration so configs on the previous ten-model default upgrade cleanly; customized `supportedModels` lists are left untouched.

### Note
- `openai-codex` coverage is unchanged and remains correct: the Codex model cache grants a `priority` service tier to exactly the five listed models, and leaves `gpt-5.4-mini` and `gpt-5.3-codex-spark` with no service tiers.
- OpenAI renamed priority processing to Fast mode on 2026-07-30. Both `service_tier: "priority"` and `service_tier: "fast"` remain accepted, so the value this extension sends is still valid.

## [1.0.5] - 2026-07-14

### Added
- Added fast mode support for GPT-5.6 Sol, Terra, and Luna on both the `openai` and `openai-codex` providers.
- Added regression coverage for GPT-5.6 model matching and default configuration.

### Changed
- Migrated the previous GPT-5.4-only and GPT-5.4/GPT-5.5 default model lists to include supported GPT-5.6 variants while preserving custom `supportedModels` lists.
