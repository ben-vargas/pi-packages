# @benvargas/pi-claude-code-use

`pi-claude-code-use` keeps Pi's built-in `anthropic` provider intact and applies the smallest payload changes needed for Anthropic OAuth subscription use in Pi.

It does not register a new provider or replace Pi's Anthropic request transport. Pi core remains in charge of OAuth transport, headers, model definitions, and streaming.

## What It Changes

When Pi is using Anthropic OAuth, this extension intercepts outbound API requests via the `before_provider_request` hook and:

- **System prompt rewrite** -- rewrites a small set of Pi-identifying prompt phrases in system prompt text:
  - `pi itself` → `the cli itself`
  - `pi .md files` → `cli .md files`
  - `pi packages` → `cli packages`
  Preserves Pi's original `system[]` structure, `cache_control` metadata, and non-text blocks.
- **Tool filtering** -- passes through core Claude Code tools, Anthropic-native typed tools (e.g. `web_search`), and any tool prefixed with `mcp__`. Unknown flat-named tools are filtered out.
- **Automatic tool remapping** -- renames flat extension tool names to derived MCP-style aliases (e.g. `web_search_exa` becomes `mcp__exa_mcp__web_search_exa`). Duplicate flat entries are removed after remapping.
- **tool_choice remapping** -- if `tool_choice` references a flat name that was remapped, the reference is updated to the MCP alias. If it references a tool that was filtered out, `tool_choice` is removed from the payload.
- **Message history rewriting** -- `tool_use` blocks in conversation history that reference remapped flat names are rewritten to their MCP aliases so the model sees consistent tool names across the conversation.
- **Dynamic alias registration** -- at session start and before each agent turn, reads Pi's live tool registry via `getAllTools()` and registers a schema-only MCP alias for every non-core flat tool, from any extension. This includes tools that other extensions register from lifecycle hooks (e.g. `pi-web-providers`), with no hardcoded extension list to maintain.
- **Managed tool-call unaliasing** -- when the model calls an MCP alias registered by this extension, rewrites the finalized `toolCall` name back to the original flat tool name during `message_end`, before Pi resolves execution. Direct MCP tools from other extensions are left untouched.
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
| `PI_CLAUDE_CODE_USE_DISABLE_AUTO_ALIAS` | Set to `1` to disable automatic alias derivation. Only user-configured `toolAliases` are registered; other flat-named tools are filtered out on Anthropic OAuth requests as before. |

Example:

```bash
PI_CLAUDE_CODE_USE_DEBUG_LOG=/tmp/pi-claude-debug.log pi -e /path/to/extensions/index.ts --model anthropic/claude-sonnet-4-20250514
```

## Automatic Tool Aliases

Anthropic's OAuth subscription endpoint refuses flat-named custom tools but accepts any name shaped like `mcp__<server>__<tool>` (it does not validate that a real MCP server exists). Instead of maintaining a hardcoded list of known extensions, `pi-claude-code-use` derives an MCP alias for every non-core flat tool in Pi's live registry:

1. At `session_start` and `before_agent_start`, it calls `pi.getAllTools()` and inspects each tool's `sourceInfo`.
2. The `<server>` segment is derived from where the tool came from, in priority order:
   - Pi built-in / SDK synthetic sources → `pi`
   - npm installs → the unscoped package name from the `node_modules` path (e.g. `@benvargas/pi-exa-mcp` → `exa_mcp`)
   - single-file extensions → the file stem (e.g. `my-tool.ts` → `my_tool`)
   - directory-based extensions → the nearest non-generic directory name (skipping `extensions`, `src`, `dist`, `lib`, `build`, `out`)
   A leading `pi-` prefix is stripped and the segment is sanitized to `[a-z0-9_]`.
3. The alias is `mcp__<server>__<tool>` (sanitized, capped at Anthropic's 128-char limit). Name collisions are resolved deterministically with numeric suffixes (`_2`, `_3`, ...) in sorted flat-name order; derived names never shadow an existing tool.
4. A schema-only alias tool is registered carrying the source tool's parameter schema, description, and prompt guidelines. Its `execute` is a stub: when the assistant calls a managed alias, `pi-claude-code-use` rewrites the finalized `toolCall` back to the original flat name during `message_end`, before Pi resolves execution, so the source extension's original `execute` closure and state always run. Aliases are re-registered if the source tool's schema changes mid-session, and every alias keeps a permanent reverse route so stale aliases (after config changes) still resolve to their source tool.

Alias passes run at `session_start`, `before_agent_start`, and `before_provider_request` (OAuth requests only). The last pass catches tools that another extension registers from its own `before_agent_start` handler after this extension's handler already ran, so those tools are aliased in-payload on their first turn instead of the second.

Examples with the companion extensions from this monorepo installed via npm:

| Flat name | Derived MCP alias |
|---|---|
| `web_search_exa` | `mcp__exa_mcp__web_search_exa` |
| `get_code_context_exa` | `mcp__exa_mcp__get_code_context_exa` |
| `firecrawl_scrape` | `mcp__firecrawl__firecrawl_scrape` |

Because aliases are re-derived from the live registry on every agent turn, tools registered by other extensions **from lifecycle hooks** (such as `pi-web-providers`' managed `web_search`/`web_contents`/`web_answer`/`web_research` tools) are picked up automatically.

Session files always persist flat tool names (alias calls are rewritten back before persistence), so derived alias names can change across versions without corrupting resumed sessions.

## User-Defined Tool Aliases

Derived names are deterministic but mechanical. To choose specific alias names (for example, ones that mirror a real MCP server's naming), create `~/.pi/agent/extensions/pi-claude-code-use.json` (global) or `<project>/.pi/extensions/pi-claude-code-use.json` (project). Schema:

```json
{
  "toolAliases": [
    ["subagent", "mcp__subagent__run"],
    ["linear_search", "mcp__linear__search"]
  ]
}
```

Each entry maps an existing flat Pi tool name to the MCP-style name Anthropic should see. Use the flat tool name exactly as the source extension registers it; the alias must be in the form `mcp__<namespace>__<tool>`. Entries are validated and invalid ones are fully ignored with a warning (derivation applies instead): the alias must be `mcp__`-prefixed, trimmed, at most 128 characters, not already used by another entry, not the name of another extension's tool, and not an alias this extension already registered for a different flat tool.

User-configured aliases override automatic derivation for that flat tool. They are otherwise treated the same as derived aliases: Anthropic sees the MCP-style name, but managed alias calls are canonicalized back to the flat source tool before local execution. MCP-style tools that are provided directly by another extension are not rewritten unless `pi-claude-code-use` registered that same alias.

The project file replaces the global file as a whole. Set `"toolAliases": []` in the project file to disable inherited globals (automatic derivation still applies unless `PI_CLAUDE_CODE_USE_DISABLE_AUTO_ALIAS=1`).

## Core Tools Allowlist

The following tool names always pass through filtering (case-insensitive) and are never aliased. This list mirrors Pi core's `claudeCodeTools` in `packages/ai/src/api/anthropic-messages.ts`:

`Read`, `Write`, `Edit`, `Bash`, `Grep`, `Glob`, `AskUserQuestion`, `EnterPlanMode`, `ExitPlanMode`, `KillShell`, `NotebookEdit`, `Skill`, `Task`, `TaskOutput`, `TodoWrite`, `WebFetch`, `WebSearch`

Additionally, any tool with a `type` field (Anthropic-native tools like `web_search`) and any tool prefixed with `mcp__` always passes through provider-request filtering. Direct MCP tools remain direct MCP tools; only aliases registered by `pi-claude-code-use` are rewritten back to flat names before local execution.

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

That said, flat-named tools no longer require any special handling: `pi-claude-code-use` automatically derives and registers an MCP-style alias for every non-core flat tool it finds in Pi's registry, including tools registered from lifecycle hooks. Registering directly under an MCP-style name simply avoids the aliasing layer entirely.

## Known Limitations

Pi's `getAllTools()` exposes each tool's name, description, parameter schema, prompt guidelines, and source metadata — but not the full `ToolDefinition`. As a result, alias tools do not carry:

- `promptSnippet` -- the source tool's one-line entry in Pi's "Available tools" system prompt section keeps the flat name.
- `constrainedSampling` -- provider-side strict-schema sampling configured on the source tool does not apply to the alias.
- `renderCall` / `renderResult` / `renderShell` -- while a call is streaming, an aliased tool renders with Pi's generic renderer; execution itself is still routed to (and rendered by) the flat tool.

These are display/metadata-level gaps; execution correctness is unaffected. They would be resolved upstream if Pi expanded `ToolInfo` or exposed `getToolDefinition()` on the extension API.

## Notes

- The extension activates for all Anthropic OAuth requests regardless of model, rather than using a fixed model allowlist.
- Non-OAuth Anthropic usage (API key auth) is left unchanged.
- In practice, unknown non-MCP extension tools were the remaining trigger for Anthropic's extra-usage classification, so this package keeps core tools, keeps MCP-style tools, auto-aliases every other flat tool, and filters anything left over (aliases whose flat tool is inactive, and flat tools when auto-aliasing is disabled).
- Pi may show its built-in OAuth subscription warning banner even when the request path works correctly. That banner is UI logic in Pi, not a signal that the upstream request is being billed as extra usage.
