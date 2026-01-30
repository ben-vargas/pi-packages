# @benvargas/pi-exa-mcp

Exa MCP tools for [pi](https://github.com/badlogic/pi-mono), the AI coding agent.

Provides real-time web search and code/documentation search via [Exa's](https://exa.ai) Model Context Protocol (MCP) over HTTP.

## Features

- **Web search** (`web_search_exa`) — Real-time web search for up-to-date information
- **Code context** (`get_code_context_exa`) — Search code and documentation for API usage and examples
- **Configurable limits** — Client-side truncation with configurable max bytes/lines
- **Multiple config sources** — JSON config, environment variables, or CLI flags
- **MCP protocol** — Full JSON-RPC 2.0 and SSE support for streaming responses

## Installation

```bash
pi install npm:@benvargas/pi-exa-mcp
```

Or try without installing:

```bash
pi -e npm:@benvargas/pi-exa-mcp
```

## Setup

No API key is required for basic usage. For higher rate limits, configure your Exa API key using one of these methods:

### Option 1: Environment Variable

```bash
export EXA_API_KEY="your_exa_api_key"
pi
```

### Option 2: JSON Config

Create `~/.pi/agent/extensions/exa-mcp.json`:

```json
{
  "url": "https://mcp.exa.ai/mcp",
  "apiKey": "your_exa_api_key",
  "tools": ["web_search_exa", "get_code_context_exa"],
  "timeoutMs": 30000,
  "maxBytes": 51200,
  "maxLines": 2000
}
```

### Option 3: CLI Flags

```bash
pi --exa-mcp-api-key=your_exa_api_key
```

## Usage

Once installed, the AI will automatically use these tools when appropriate:

```
"Search the web for the latest React features"
"Find code examples for Rust error handling"
"Look up the TypeScript 5.0 release notes"
```

### Tools

#### web_search_exa

Real-time web search for up-to-date information.

| Parameter | Description | Default |
|-----------|-------------|---------|
| `query` | Search query (required) | — |
| `numResults` | Number of results to return | — |
| `type` | Search mode: `auto`, `fast`, `deep` | — |
| `livecrawl` | Live crawl behavior: `fallback`, `preferred` | — |
| `contextMaxCharacters` | Max characters in extracted content | — |
| `piMaxBytes` | Client-side max bytes override | — |
| `piMaxLines` | Client-side max lines override | — |

#### get_code_context_exa

Search code and documentation for API usage and examples.

| Parameter | Description | Default |
|-----------|-------------|---------|
| `query` | Code search query (required) | — |
| `tokensNum` | Token budget for retrieved context (1000-50000) | — |
| `piMaxBytes` | Client-side max bytes override | — |
| `piMaxLines` | Client-side max lines override | — |

## Configuration

### Config File Locations

Config files are loaded in order (first match wins):

1. Path from `--exa-mcp-config` flag
2. Path from `EXA_MCP_CONFIG` environment variable
3. `./.pi/extensions/exa-mcp.json` (project-level)
4. `~/.pi/agent/extensions/exa-mcp.json` (global)

### Config File Format

```json
{
  "url": "https://mcp.exa.ai/mcp",
  "tools": ["web_search_exa", "get_code_context_exa"],
  "apiKey": "your_api_key",
  "timeoutMs": 30000,
  "protocolVersion": "2025-06-18",
  "maxBytes": 51200,
  "maxLines": 2000
}
```

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `EXA_MCP_URL` | MCP endpoint URL | `https://mcp.exa.ai/mcp` |
| `EXA_MCP_TOOLS` | Comma-separated tool list | — |
| `EXA_API_KEY` / `EXA_MCP_API_KEY` | Exa API key | — |
| `EXA_MCP_TIMEOUT_MS` | Request timeout (ms) | `30000` |
| `EXA_MCP_PROTOCOL_VERSION` | MCP protocol version | `2025-06-18` |
| `EXA_MCP_MAX_BYTES` | Max bytes to keep from output | `51200` |
| `EXA_MCP_MAX_LINES` | Max lines to keep from output | `2000` |
| `EXA_MCP_CONFIG` | Path to JSON config file | — |

### CLI Flags

| Flag | Description |
|------|-------------|
| `--exa-mcp-url` | Override the Exa MCP endpoint |
| `--exa-mcp-tools` | Comma-separated MCP tool list |
| `--exa-mcp-api-key` | Exa API key |
| `--exa-mcp-timeout-ms` | HTTP timeout (milliseconds) |
| `--exa-mcp-protocol` | MCP protocol version |
| `--exa-mcp-config` | Path to JSON config file |
| `--exa-mcp-max-bytes` | Max bytes to keep from output |
| `--exa-mcp-max-lines` | Max lines to keep from output |

## Output Truncation

Tool output is automatically truncated to prevent context window overflow:

- **Default limits**: 51200 bytes and 2000 lines
- **Client overrides**: Models can request higher limits via `piMaxBytes`/`piMaxLines` (clamped to configured max)
- **Temp files**: When truncated, full output is saved to a temp file with the path included in the response

## Requirements

- pi v0.50.0 or later
- Optional: Exa API key for higher rate limits

## Uninstall

```bash
pi remove npm:@benvargas/pi-exa-mcp
```

## License

MIT
