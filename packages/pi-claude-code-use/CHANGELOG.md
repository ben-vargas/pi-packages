# Changelog

All notable changes to this package will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this package adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [3.0.1] - 2026-10-25

### Fixed
- Turn tool aliasing back on by default. 3.0.0 made it opt-in after live tests with a single synthetic tool, but Anthropic also fingerprints some real flat tool names: `web_search_exa` and `get_code_context_exa` each route OAuth requests to extra usage (`400 You're out of extra usage`), so 3.0.0 broke sessions using pi-exa-mcp. Disable aliasing with `PI_CLAUDE_CODE_USE_TOOL_ALIASES=0` or `"toolAliasing": false` in `pi-claude-code-use.json`; `PI_CLAUDE_CODE_USE_TOOL_ALIASES=1` forces it on.

## [3.0.0] - 2026-10-25

### Changed
- **Tool aliasing is now opt-in.** *(Superseded by 3.0.1: some flat tool names, such as `web_search_exa`, do route requests to extra usage, so aliasing is on by default again.)* Live tests against Anthropic's OAuth endpoint on 2026-10-25 (Pi 1.4.0) showed the system prompt phrases `pi itself` and `pi packages` are what route requests to extra usage; flat custom tool names are accepted. By default the extension now only rewrites the system prompt and leaves tools, `tool_choice`, transcript tool changes, and tool calls untouched. Enable the previous MCP-alias behavior with `PI_CLAUDE_CODE_USE_TOOL_ALIASES=1` or `"toolAliasing": true` in `pi-claude-code-use.json`; `toolAliases` entries apply only while it is enabled.
- Split the extension into modules: the prompt rewrite (`extensions/prompt.ts`) and the opt-in aliasing (`extensions/tool-aliases/`: registry, payload transform, rendering, and shared state).

### Fixed
- Support Pi 1.x inline tool definitions. Pi 1.x keeps the top-level Anthropic tool list fixed and defines tools added mid-conversation by value in `tool_addition` blocks (`tool_definition`). These were not recognized, so flat custom tool names (for example `web_search_exa`) reached the OAuth endpoint without their `mcp__` aliases. Inline definitions now follow the top-level rules: flat tools are renamed to their aliases, flat+alias pairs collapse to one definition using the flat source's schema, and unaliased flat tools are dropped with their cache breakpoint relocated. Removals and `tool_choice` resolve against tools that were only defined inline.
- Keep same-name inline redefinitions of an already-active tool, which Pi 1.x uses for schema updates, instead of discarding them as redundant additions.
- Register alias tools with `exposure: "model-only"` (Pi 0.99+). Pi defaulted them to `direct`, which made them callable through `ctx.executeTool()` and listed in codemode, where calls failed in the alias stub. Other tools and codemode scripts now reach only the source tool, with its own output schema. An alias is withdrawn (`hidden`) when its source tool is hidden.
- Leave out an alias when its source tool is active but Pi left its declaration out of the request, as codemode's `only` mode does for direct tools. Pi does not hide model-only tools, so the alias follows its source here; an alias kept active while its source is inactive remains a user selection and stays declared.
- Pi 0.86 `tool_reference` additions remain supported. Validated against Pi 1.4.0.

## [2.2.1] - 2026-09-20

### Fixed
- Keep historical tool-call aliases stable when outgoing tool definitions change, while the alias mapping stays unchanged. Cover consecutive request-hook refreshes, omitted/restored definitions, and preservation of call/result metadata (PR #37).
- Remap Pi 0.86 native `tool_addition` and `tool_removal` references alongside tool definitions. Merge flat/alias updates without disabling aliases that remain selected, preserve initial activation and declaration order, and remove references to filtered tools.
- Preserve Pi's reserved deferred placeholder and cache metadata across transcript tool changes.
- Relocate history cache breakpoints to preceding eligible user or system content when filtered or redundant tool updates disappear. Preserve cache TTLs and existing breakpoints, and retain effort-only messages.
- Apply system-prompt phrase rewriting to mid-conversation system messages, including when tool filtering is disabled, without changing user or assistant text.
- Add offline regression tests using Pi 0.86's actual Anthropic request builder and extension hooks, validated against Pi 0.86.1.

## [2.2.0] - 2026-08-10

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
