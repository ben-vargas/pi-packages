# @benvargas/pi-firecrawl

Firecrawl tools for [pi](https://github.com/badlogic/pi-mono), the AI coding agent.

Provides focused Firecrawl REST API (v2) access for:

- `firecrawl_scrape`
- `firecrawl_map`
- `firecrawl_search`

## Features

- **Scrape** (`firecrawl_scrape`) — Scrape a single URL
- **Map** (`firecrawl_map`) — Discover URLs on a site
- **Search** (`firecrawl_search`) — Search the web and optionally scrape results
- **Tool allowlist** — Enable/disable tools via `tools` config
- **Configurable limits** — Client-side truncation with configurable max bytes/lines
- **Multiple config sources** — JSON config, environment variables, or CLI flags
- **Direct REST API** — Simple, fast, no protocol overhead; targets Firecrawl API v2

> **Firecrawl v1 shutdown:** Firecrawl's v1 API stops working on December 10, 2026 (15:00 UTC). pi-firecrawl 1.2.0 and later call v2; upgrade before that date. See [API Version](#api-version).

## Installation

```bash
pi install npm:@benvargas/pi-firecrawl
```

Or try without installing:

```bash
pi -e npm:@benvargas/pi-firecrawl
```

## Setup

Get an API key from [firecrawl.dev](https://firecrawl.dev) and configure it using one of these methods.

### Option 1: Environment Variable

```bash
export FIRECRAWL_API_KEY="your_firecrawl_api_key"
pi
```

### Option 2: JSON Config

Create `firecrawl.json` in pi's agent extensions directory (`~/.pi/agent/extensions/firecrawl.json` by default; the agent directory honors `PI_CODING_AGENT_DIR`):

```json
{
  "url": "https://api.firecrawl.dev",
  "apiKey": "your_firecrawl_api_key",
  "headers": null,
  "tools": ["firecrawl_scrape", "firecrawl_map", "firecrawl_search"],
  "timeoutMs": 30000,
  "maxBytes": 51200,
  "maxLines": 2000
}
```

If you want to disable search, remove it from the `tools` array.

### Option 3: CLI Flags

```bash
pi --firecrawl-api-key=your_firecrawl_api_key
```

## Usage

Once installed, the AI can use these tools when appropriate:

```text
"Scrape https://example.com and get the main content"
"Map docs.example.com and list likely API pages"
"Search for React tutorials and summarize top results"
```

## Tools

### firecrawl_scrape

Scrape a single URL.

| Parameter | Description | Default |
|-----------|-------------|---------|
| `url` | Target URL (required) | — |
| `formats` | Output formats: strings (`markdown`, `html`, `links`, `summary`, ...) or objects (`{ "type": "json", "prompt", "schema" }`, `{ "type": "screenshot", "fullPage": true }`) | `["markdown"]` |
| `onlyMainContent` | Extract only main content | — |
| `maxAge` | Accept a cached copy up to this many milliseconds old; `0` forces a fresh scrape | 2 days |
| `waitFor` | Wait time in milliseconds | — |
| `timeout` | Request timeout | — |
| `mobile` | Use mobile viewport | — |
| `includeTags` | Tags to include | — |
| `excludeTags` | Tags to exclude | — |
| `skipTlsVerification` | Skip TLS verification | — |
| `piMaxBytes` | Client-side max bytes override | — |
| `piMaxLines` | Client-side max lines override | — |

### firecrawl_map

Discover URLs on a site.

| Parameter | Description | Default |
|-----------|-------------|---------|
| `url` | Base URL to map (required) | — |
| `search` | Search query to filter URLs | — |
| `sitemap` | Sitemap handling mode (`include`, `skip`, `only`) | — |
| `includeSubdomains` | Include subdomains | — |
| `limit` | Maximum URLs to return | — |
| `ignoreQueryParameters` | Ignore query parameters | — |
| `piMaxBytes` | Client-side max bytes override | — |
| `piMaxLines` | Client-side max lines override | — |

### firecrawl_search

Search the web and optionally scrape results.

| Parameter | Description | Default |
|-----------|-------------|---------|
| `query` | Search query (required) | — |
| `limit` | Maximum results per source | `5` |
| `sources` | Result types: `web`, `news`, `images` | `["web"]` |
| `tbs` | Time filter (e.g. `qdr:d`, `qdr:w`) | — |
| `location` | Geo-target location string | — |
| `country` | ISO country code | — |
| `scrapeOptions` | Scrape options for results | — |
| `piMaxBytes` | Client-side max bytes override | — |
| `piMaxLines` | Client-side max lines override | — |

## Configuration

### Config File Locations

Config files are loaded in order (first match wins):

1. Path from `--firecrawl-config` flag
2. Path from `FIRECRAWL_CONFIG` environment variable
3. `./.pi/extensions/firecrawl.json` (project-level)
4. `<agent-dir>/extensions/firecrawl.json` (global — `<agent-dir>` is pi's agent directory, `~/.pi/agent` by default or `$PI_CODING_AGENT_DIR` when set)
5. `~/.pi/agent/extensions/firecrawl.json` (legacy global — only checked when `$PI_CODING_AGENT_DIR` relocates the agent directory, so configs written before the relocation keep working)

If none exist, the extension writes a default config to the global path (`<agent-dir>/extensions/firecrawl.json`) with `apiKey` set to `null`.

### Config File Format

```json
{
  "url": "https://api.firecrawl.dev",
  "apiKey": null,
  "headers": null,
  "tools": ["firecrawl_scrape", "firecrawl_map", "firecrawl_search"],
  "timeoutMs": 30000,
  "maxBytes": 51200,
  "maxLines": 2000
}
```

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `FIRECRAWL_URL` | API base URL | `https://api.firecrawl.dev` |
| `FIRECRAWL_API_KEY` | Firecrawl API key (Bearer token) | — |
| `FIRECRAWL_TIMEOUT_MS` | Request timeout (ms) | `30000` |
| `FIRECRAWL_TOOLS` | Comma-separated tool list | — |
| `FIRECRAWL_MAX_BYTES` | Max bytes to keep from output | `51200` |
| `FIRECRAWL_MAX_LINES` | Max lines to keep from output | `2000` |
| `FIRECRAWL_CONFIG` | Path to JSON config file | — |

### CLI Flags

| Flag | Description |
|------|-------------|
| `--firecrawl-url` | Override the Firecrawl API base URL |
| `--firecrawl-api-key` | Firecrawl API key |
| `--firecrawl-timeout-ms` | HTTP timeout (milliseconds) |
| `--firecrawl-config` | Path to JSON config file |
| `--firecrawl-tools` | Comma-separated tool list |
| `--firecrawl-max-bytes` | Max bytes to keep from output |
| `--firecrawl-max-lines` | Max lines to keep from output |

## API Version

The tools call Firecrawl's v2 endpoints (`/v2/scrape`, `/v2/map`, `/v2/search`). The configured `url` is the API host; a trailing `/v1` or `/v2` is ignored. Self-hosted instances must serve the v2 API.

Differences from the v1-based releases (1.1.0 and earlier), as of 1.2.0:

- **Search output** is an object grouped by source (`{ "web": [...] }`, plus `news`/`images` when requested) instead of a bare array.
- **Search `lang`** no longer exists in v2 and is dropped; use `country`/`location`. The default `limit` stays at 5 (v2's own default is 10).
- **Scrape caching**: v2 serves cached pages up to 2 days old by default. Pass `maxAge: 0` for a fresh scrape.
- **v1 argument shapes are translated** so older prompts keep working: `screenshot@fullPage`, `extract`/`jsonOptions`, `changeTrackingOptions`, `parsePDF: false`, `geolocation`, and map `ignoreSitemap`/`sitemapOnly`. Map `maxDepth` and `allowBackwardLinks` have no v2 equivalent and are dropped.

## Output Truncation

Tool output is automatically truncated to prevent context window overflow:

- **Default limits**: 51200 bytes and 2000 lines
- **Client overrides**: models can request `piMaxBytes`/`piMaxLines` (clamped to configured max)
- **Temp files**: when truncated, full output is saved to a temp file with the path included in the response

## Requirements

- pi v0.74.0 or later
- Firecrawl API key from [firecrawl.dev](https://firecrawl.dev)

## Uninstall

```bash
pi remove npm:@benvargas/pi-firecrawl
```

## License

MIT
