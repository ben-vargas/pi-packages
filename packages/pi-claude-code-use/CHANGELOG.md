# Changelog

All notable changes to this package will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this package adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [2.0.0] - 2026-07-31

### Changed
- **Breaking:** replaced the hardcoded companion extension list (`pi-exa-mcp`, `pi-firecrawl`) and the jiti-based factory capture with dynamic alias registration driven by `pi.getAllTools()`. Every non-core flat tool in Pi's live registry now gets a deterministic MCP-style alias derived from its `sourceInfo` (e.g. `web_search_exa` → `mcp__exa_mcp__web_search_exa`), including tools that other extensions register from lifecycle hooks (e.g. `pi-web-providers`), which the previous capture approach missed.
- Alias tools are now schema-only stubs built from `getAllTools()` metadata (parameters, description, prompt guidelines). Managed alias calls were already rewritten back to their flat source names at `message_end` before execution, so the captured duplicate `execute` was never used; the stub throws if that rewrite is ever bypassed.
- Derived alias names resolve collisions deterministically with numeric suffixes and respect Anthropic's 128-char tool name limit. Derived names never shadow existing tools (including real MCP tools from other extensions).
- User-configured `toolAliases` entries now act as overrides on top of automatic derivation and must be `mcp__`-prefixed (invalid entries are ignored with a warning).
- Removed the `@mariozechner/jiti` dependency and the `pi-ai`/`pi-agent-core`/`pi-tui`/`typebox` peer dependencies; only `@earendil-works/pi-coding-agent` remains.

### Added
- `PI_CLAUDE_CODE_USE_DISABLE_AUTO_ALIAS=1` environment variable to disable automatic alias derivation while keeping user-configured aliases.

### Migration notes
- Previously curated alias names (`mcp__exa__web_search`, `mcp__firecrawl__scrape`, ...) change to derived names (`mcp__exa_mcp__web_search_exa`, `mcp__firecrawl__firecrawl_scrape`, ...). Session files persist flat tool names, so resumed sessions are unaffected. To keep the old names, add them as `toolAliases` overrides in `pi-claude-code-use.json`.

## [1.0.5] - 2026-07-16

### Fixed
- Added Pi 0.80.8+ `registerEntryRenderer` support to the companion capture shim while suppressing duplicate renderer registrations, validated against Pi 0.80.9.
- Added regression coverage for entry-renderer registration and legacy Pi namespace aliases during companion tool capture.

## [1.0.4] - 2026-05-21

### Added
- Rewrites managed MCP alias `toolCall` names back to their canonical flat tool names during `message_end`, so Pi executes the original extension tool rather than the captured alias duplicate.
- Added regression coverage to ensure direct MCP tools from other extensions are not rewritten.

## [1.0.3] - 2026-05-07

### Changed
- Updated pi SDK imports and peer dependencies from `@mariozechner/*` to `@earendil-works/*` for pi 0.74.0.
- Kept compatibility aliases for dynamically loaded companion extensions that still import the old pi SDK namespace.

## [1.0.2] - 2026-05-02

### Added
- Added user-defined `toolAliases` config so flat-named tools from other extensions can be exposed under MCP-style aliases.
- Documented global and project-level alias configuration for custom extension tools.
