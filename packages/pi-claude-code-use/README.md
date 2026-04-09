# @benvargas/pi-claude-code-use

`pi-claude-code-use` keeps Pi's built-in `anthropic` provider intact and applies the smallest payload changes needed for Anthropic OAuth subscription use in Pi.

It does not register a new provider or replace Pi's Anthropic request transport. Pi core remains in charge of OAuth transport, headers, model definitions, and streaming.

## What It Changes

When Pi is using Anthropic OAuth, this extension intercepts outbound API requests via the `before_provider_request` hook and:

- **System prompt rewrite** -- replaces `pi itself` with `the cli itself` in system prompt text. Preserves Pi's original `system[]` structure, `cache_control` metadata, and non-text blocks.
- **Tool filtering** -- passes through core Claude Code tools, Anthropic-native typed tools (e.g. `web_search`), and any tool prefixed with `mcp__`. Unknown flat-named tools are filtered out.
- **Companion tool remapping** -- renames known companion extension tools from their flat names to MCP-style aliases (e.g. `web_search_exa` becomes `mcp__exa__web_search`). Duplicate flat entries are removed after remapping.
- **tool_choice remapping** -- if `tool_choice` references a flat companion name that was remapped, the reference is updated to the MCP alias. If it references a tool that was filtered out, `tool_choice` is removed from the payload.
- **Message history rewriting** -- `tool_use` blocks in conversation history that reference flat companion names are rewritten to their MCP aliases so the model sees consistent tool names across the conversation.
- **Companion alias registration** -- at session start and before each agent turn, discovers loaded companion extensions, captures their tool definitions via a jiti-based shim, and registers MCP-alias copies so the model can invoke them under Claude Code-compatible names.
- **Alias activation tracking** -- auto-activates MCP aliases when their flat counterpart is active under Anthropic OAuth. Tracks provenance (auto-managed vs user-selected) so that disabling OAuth only removes auto-activated aliases, preserving any the user explicitly enabled.

Non-OAuth Anthropic usage and non-Anthropic providers are left completely unchanged.

## Install

```bash
pi install npm:@benvargas/pi-claude-code-use
```

Or load it directly without installing:

```bash
pi -e /path/to/pi-packages/packages/pi-claude-code-use/extensions/index.ts
```

## Usage

Install the package and continue using the normal `anthropic` provider with Anthropic OAuth login:

```bash
/login anthropic
/model anthropic/claude-opus-4-6
```

No extra configuration is required.

## Environment Variables

| Variable | Description |
|---|---|
| `PI_CLAUDE_CODE_USE_DEBUG_LOG` | Set to a file path to enable debug logging. Writes two JSON entries per Anthropic OAuth request: one with `"stage": "before"` (the original payload from Pi) and one with `"stage": "after"` (the transformed payload sent to Anthropic). |
| `PI_CLAUDE_CODE_USE_DISABLE_TOOL_FILTER` | Set to `1` to disable tool filtering. System prompt rewriting still applies, but all tools pass through unchanged. Useful for debugging whether a tool-filtering issue is causing a problem. |

Example:

```bash
PI_CLAUDE_CODE_USE_DEBUG_LOG=/tmp/pi-claude-debug.log pi -e /path/to/extensions/index.ts --model anthropic/claude-sonnet-4-20250514
```

## Companion Tool Aliases

When these companion extensions from this monorepo are loaded alongside `pi-claude-code-use`, MCP aliases are automatically registered and remapped:

| Flat name | MCP alias |
|---|---|
| `web_search_exa` | `mcp__exa__web_search` |
| `get_code_context_exa` | `mcp__exa__get_code_context` |
| `firecrawl_scrape` | `mcp__firecrawl__scrape` |
| `firecrawl_map` | `mcp__firecrawl__map` |
| `firecrawl_search` | `mcp__firecrawl__search` |
| `generate_image` | `mcp__antigravity__generate_image` |
| `image_quota` | `mcp__antigravity__image_quota` |

### How companion discovery works

The extension identifies companion tools by matching `sourceInfo` metadata that Pi attaches to each registered tool:

1. **baseDir match** -- if the tool's `sourceInfo.baseDir` directory name matches the companion's directory name (e.g. `pi-exa-mcp`).
2. **Path match** -- if the tool's `sourceInfo.path` contains the companion's scoped package name (e.g. `@benvargas/pi-exa-mcp`) or directory name as a path segment. This handles npm installs, git clones, and monorepo layouts where `baseDir` points to the repo root rather than the individual package.

Once a companion tool is identified, its extension factory is loaded via jiti into a capture shim to obtain the full tool definition, which is then re-registered under the MCP alias name.

## Core Tools Allowlist

The following tool names always pass through filtering (case-insensitive). This list mirrors Pi core's `claudeCodeTools` in `packages/ai/src/providers/anthropic.ts`:

`Read`, `Write`, `Edit`, `Bash`, `Grep`, `Glob`, `AskUserQuestion`, `EnterPlanMode`, `ExitPlanMode`, `KillShell`, `NotebookEdit`, `Skill`, `Task`, `TaskOutput`, `TodoWrite`, `WebFetch`, `WebSearch`

Additionally, any tool with a `type` field (Anthropic-native tools like `web_search`) and any tool prefixed with `mcp__` always passes through.

## Guidance For Extension Authors

Anthropic's OAuth subscription path appears to fingerprint tool names. Flat extension tool names such as `web_search_exa` were rejected in live testing, while MCP-style names such as `mcp__exa__web_search` were accepted.

If you want a custom tool to survive Anthropic OAuth filtering cleanly, prefer registering it directly under an MCP-style name:

```text
mcp__<server>__<tool>
```

Examples:

- `mcp__exa__web_search`
- `mcp__firecrawl__scrape`
- `mcp__mytools__lookup_customer`

If an extension keeps a flat legacy name for non-Anthropic use, it can also register an MCP-style alias alongside it. `pi-claude-code-use` already does this centrally for the known companion tools in this repo, but unknown non-MCP tool names will still be filtered out on Anthropic OAuth requests.

## Notes

- The extension activates for all Anthropic OAuth requests regardless of model, rather than using a fixed model allowlist.
- Non-OAuth Anthropic usage (API key auth) is left unchanged.
- In practice, unknown non-MCP extension tools were the remaining trigger for Anthropic's extra-usage classification, so this package keeps core tools, keeps MCP-style tools, auto-aliases the known companion tools above, and filters the rest.
- Pi may show its built-in OAuth subscription warning banner even when the request path works correctly. That banner is UI logic in Pi, not a signal that the upstream request is being billed as extra usage.
