# pi-packages

These are packages built for my personal use and shared with the community of [pi](https://github.com/badlogic/pi-mono) in case it helps others.

Pi packages can include extensions, skills, prompt templates, and themes. See the [pi packages docs](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/packages.md) for details.

## Packages

| Package | Type | Description | Install |
|---------|------|-------------|---------|
| [@benvargas/pi-synthetic-provider](./packages/pi-synthetic-provider/) | Extension | [Synthetic](https://synthetic.new) model provider — access Kimi, GLM, MiniMax, DeepSeek, Qwen, and more | `pi install npm:@benvargas/pi-synthetic-provider` |
| [@benvargas/pi-antigravity-image-gen](./packages/pi-antigravity-image-gen/) | Extension | Google Antigravity image generation — Gemini 3 Pro Image with inline terminal rendering | `pi install npm:@benvargas/pi-antigravity-image-gen` |
| [@benvargas/pi-exa-mcp](./packages/pi-exa-mcp/) | Extension | Exa MCP tools — real-time web search and code context via Exa's Model Context Protocol | `pi install npm:@benvargas/pi-exa-mcp` |
| [@benvargas/pi-firecrawl-mcp](./packages/pi-firecrawl-mcp/) | Extension | Firecrawl MCP tools — web scraping, crawling, and data extraction via Firecrawl's Model Context Protocol | `pi install npm:@benvargas/pi-firecrawl-mcp` |
| [@benvargas/pi-ancestor-discovery](./packages/pi-ancestor-discovery/) | Extension | Recursive ancestor discovery for skills, prompts, and themes | `pi install npm:@benvargas/pi-ancestor-discovery` |

Each package has its own README with setup instructions, usage, and configuration details.

Security notes and dependency audit status are tracked in `SECURITY.md`.

## Install All

Install every package in this repo with a single command:

```bash
pi install git:github.com/ben-vargas/pi-packages
```

Or try without installing:

```bash
pi -e git:github.com/ben-vargas/pi-packages
```

To install a single package, use the npm command from the table above.

## Uninstall

If installed via git:

```bash
pi remove git:github.com/ben-vargas/pi-packages
```

If installed individually via npm:

```bash
pi remove npm:@benvargas/pi-synthetic-provider
pi remove npm:@benvargas/pi-antigravity-image-gen
pi remove npm:@benvargas/pi-exa-mcp
pi remove npm:@benvargas/pi-firecrawl-mcp
pi remove npm:@benvargas/pi-ancestor-discovery
```

## Contributing

Each package under `packages/` is independent with its own `package.json`. There is no shared build system — each package is self-contained.

### Testing locally

```bash
cd packages/<package-name>
pi -e .
```

## License

MIT
