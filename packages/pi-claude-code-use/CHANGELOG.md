# Changelog

All notable changes to this package will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this package adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Compact result renderer for generated alias tools. `getAllTools()` does not expose source tool renderers, so live alias rows (rendered under the `mcp__` name before the `message_end` rewrite) previously fell back to Pi's unbounded generic output. Alias results now render through a compact renderer that follows Pi's default display pipeline and hardens its terminal normalization: fully assembled output, including MIME-derived `imageFallback` placeholders, is normalized before truncation and styling, stripping ANSI CSI/OSC sequences in ESC and 8-bit C1 forms, remaining C0/C1 controls except tab/LF, DEL, unsafe binary/format characters, and carriage returns; collapsed views show at most 3 visual lines / 2000 characters (truncated on Unicode code point boundaries) with a keybinding-aware `keyHint("app.tools.expand", "to expand")` hint; partial (streaming) results render through the same path as they arrive; inline images are left to Pi's tool row, with a textual `imageFallback` placeholder only when images are hidden or unsupported; and `(empty result)` appears only for genuinely empty final results (never for image-only inline results or still-streaming partials).
- New `@earendil-works/pi-tui` peer dependency (`>=0.77.0`, matching this package's Pi floor) for the `Component`/`Text` primitives and public terminal-image utilities (`getCapabilities`, `getImageDimensions`, `imageFallback`) used by the renderer.

### Changed
- README Known Limitations now documents live-vs-restored alias rendering: source custom renderers still cannot be copied onto aliases, live alias rows use the compact generic result renderer, and restored sessions render via the persisted flat tool name (the source tool's own renderers).

## [2.1.0] - 2026-08-06

### Added
- Added display-only un-cloaking of alias tool names in assistant prose through pi 0.84's `pi.registerMarkdownTransformer()`. The model sees MCP-style aliases on the wire, so its prose mentions them ("I'll call `mcp__exa_mcp__web_search_exa`") while rendered `toolCall` blocks already showed flat names. The transformer rewrites aliases registered by this extension back to their flat source names when rendering the transcript; the session file and model context keep the original text.
- Added `PI_CLAUDE_CODE_USE_DISABLE_PROSE_UNALIAS=1` to disable the display transform.

### Changed
- The transformer applies to streaming and final assistant messages alike. Skipping streaming updates would make names flip when the message finalizes.
- The hook is feature-detected rather than required, so the declared peer floor stays at `>=0.77.0` even though `registerMarkdownTransformer` is new in pi 0.84.
- Replaced `!model || model.provider !== "anthropic"` with `model?.provider !== "anthropic"` in the `before_provider_request` guard. Behaviorally identical; satisfies Biome 2.5.7's `useOptionalChain`.

## [2.0.0] - 2026-07-31

### Changed
- **Breaking:** replaced the hardcoded companion extension list (`pi-exa-mcp`, `pi-firecrawl`) and the jiti-based factory capture with dynamic alias registration driven by `pi.getAllTools()`. Every non-core flat tool in Pi's live registry now gets a deterministic MCP-style alias derived from its `sourceInfo` (e.g. `web_search_exa` → `mcp__exa_mcp__web_search_exa`), including tools that other extensions register from lifecycle hooks (e.g. `pi-web-providers`), which the previous capture approach missed.
- Alias tools are now schema-only stubs built from `getAllTools()` metadata (parameters, description, prompt guidelines). Managed alias calls were already rewritten back to their flat source names at `message_end` before execution, so the captured duplicate `execute` was never used; the stub throws if that rewrite is ever bypassed.
- Derived alias names resolve collisions deterministically with numeric suffixes and respect Anthropic's 128-char tool name limit. Derived names never shadow existing tools (including real MCP tools from other extensions).
- User-configured `toolAliases` entries now act as overrides on top of automatic derivation and must be `mcp__`-prefixed (invalid entries are ignored with a warning).
- Removed the `@mariozechner/jiti` dependency and the `pi-ai`/`pi-agent-core`/`pi-tui`/`typebox` peer dependencies; only `@earendil-works/pi-coding-agent` remains, with the floor raised to `>=0.77.0` (first release exposing `promptGuidelines` in `ToolInfo`).

### Added
- `PI_CLAUDE_CODE_USE_DISABLE_AUTO_ALIAS=1` environment variable to disable automatic alias derivation while keeping user-configured aliases.
- An additional alias pass during `before_provider_request` so tools registered by other extensions' `before_agent_start` handlers (running after this extension's) are aliased in-payload on their first turn.
- Aliases are re-registered when the source tool's schema/description changes mid-session, and permanent reverse routes keep stale aliases resolving to their source tool after config changes.
- Freshly registered aliases are tracked as auto-activated (Pi implicitly activates newly registered tools), so they are correctly deactivated for non-OAuth models and when their flat source tool is inactive.
- `toolAliases` validation: entries with whitespace, over-length names, duplicate targets, collisions with other extensions' tools, or targets owned by a different flat tool are fully ignored with a warning (derivation applies instead).
- Payload remapping now renames the flat tool entry (which always carries the source tool's current schema) instead of substituting the advertised alias stub, preserving the alias entry's `cache_control`. This keeps the advertised schema fresh even when a source tool re-registers with a new schema mid-turn.
- Case-insensitive duplicate flat tool names are excluded from aliasing entirely (alias state is lowercase-keyed while Pi's execution lookup is exact-name, so aliasing either variant could misroute).
- Alias activation sync records its managed baseline even on no-op syncs, so a user who later removes a flat tool but keeps its alias gets the alias correctly promoted to user-selected.
- Same-name alias re-registrations (schema refresh) no longer flip a user-selected alias back to auto-managed.

### Known limitations
- `getAllTools()` does not expose `promptSnippet`, `constrainedSampling`, or custom renderers, so aliases do not carry them (execution routing is unaffected; the flat tool's renderers apply once execution starts). Would be resolved upstream by expanding Pi's `ToolInfo`.

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
