# @benvargas/pi-claude-code-use

`pi-claude-code-use` keeps Pi's built-in `anthropic` provider as the primary provider and patches outgoing Anthropic OAuth subscription requests so Claude sees a Claude Code-compatible payload shape.

This package targets the Anthropic subscription OAuth path for the built-in `anthropic` provider.

## What It Changes

When Pi is using Anthropic OAuth, this extension:

- rewrites `system[]` into Claude Code-compatible billing and agent blocks while preserving Pi's original system prompt blocks
- applies the minimal `pi itself` -> `the cli itself` rewrite needed for Anthropic OAuth classification
- injects Claude Code-style metadata, headers, and `?beta=true` on `/v1/messages`
- computes and injects the final-body `cch` billing signature used by Claude Code-style requests
- filters non-core extension tools by default for Anthropic OAuth requests

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

## Notes

- The extension applies to Anthropic OAuth requests in general, rather than a fixed model allowlist.
- Non-OAuth Anthropic usage is left unchanged.
- In practice, third-party extension tools were the remaining trigger for Anthropic extra-usage classification, so this package drops those tools by default on Anthropic OAuth requests.
- Pi `v0.66.0` may still show its built-in OAuth subscription warning banner even when the request path works. That banner is UI logic in Pi, not a signal that the upstream request is still being billed as extra usage.
- If Pi core later changes its Anthropic OAuth request shape, this package may need to be updated to match.
