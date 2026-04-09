# @benvargas/pi-claude-code-use

`pi-claude-code-use` keeps Pi's built-in `anthropic` provider as the primary provider and patches outgoing Anthropic OAuth subscription requests so Claude sees a Claude Code-compatible payload shape.

This package targets the Anthropic subscription OAuth path for the built-in `anthropic` provider.

## What It Changes

When Pi is using Anthropic OAuth, this extension:

- rewrites `system[]` into Claude Code-compatible billing and agent blocks while preserving Pi's original system prompt blocks
- applies the minimal `pi itself` -> `the cli itself` rewrite needed for Anthropic OAuth classification
- injects Claude Code-style metadata, headers, and `?beta=true` on `/v1/messages`
- computes and injects the final-body `cch` billing signature used by Claude Code-style requests
- auto-aliases the known companion tools in this monorepo to MCP-style names for Anthropic OAuth
- filters unknown non-MCP extension tools by default for Anthropic OAuth requests

It does not register a new provider. Pi continues to own:

- Anthropic model definitions
- OAuth and API key resolution
- streaming behavior
- prompt caching behavior already produced by Pi, including cache metadata on preserved system prompt blocks

## Install

```bash
pi install npm:@benvargas/pi-claude-code-use
```

Or try it without installing:

```bash
pi -e .
```

## Usage

Install the package and continue using the normal `anthropic` provider with Anthropic OAuth login:

```bash
/login anthropic
/model anthropic/claude-opus-4-6
```

No extra configuration is required.

Optional environment variables:

- `PI_CLAUDE_CODE_USE_DEBUG_LOG=/tmp/pi-claude-code-use.log` writes the final outbound Anthropic request URL, headers, and body for debugging.
- `PI_CLAUDE_CODE_USE_DISABLE_TOOL_FILTER=1` disables the default non-core tool filtering. This is mainly for debugging; the filtered mode is what avoided Anthropic's extra-usage classification in the normal Pi environment.

## Companion Tool Aliases

When these companion extensions are loaded, `pi-claude-code-use` registers Anthropic-safe MCP aliases for them:

- `web_search_exa` -> `mcp__exa__web_search`
- `get_code_context_exa` -> `mcp__exa__get_code_context`
- `firecrawl_scrape` -> `mcp__firecrawl__scrape`
- `firecrawl_map` -> `mcp__firecrawl__map`
- `firecrawl_search` -> `mcp__firecrawl__search`
- `generate_image` -> `mcp__antigravity__generate_image`
- `image_quota` -> `mcp__antigravity__image_quota`

This lets the model see Claude-Code-like MCP tool names while the local Pi session still executes the real tool implementations from the companion extensions.

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

- The extension applies to Anthropic OAuth requests in general, rather than a fixed model allowlist.
- Non-OAuth Anthropic usage is left unchanged.
- In practice, third-party extension tools were the remaining trigger for Anthropic extra-usage classification, so this package keeps core tools, keeps MCP-style tools, auto-aliases the known companion tools above, and filters the rest.
- Pi `v0.66.0` may still show its built-in OAuth subscription warning banner even when the request path works. That banner is UI logic in Pi, not a signal that the upstream request is still being billed as extra usage.
- If Pi core later changes its Anthropic OAuth request shape, this package may need to be updated to match.
