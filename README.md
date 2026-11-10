# pi-packages

These are packages built for my personal use and shared with the community of [pi](https://github.com/badlogic/pi-mono) in case it helps others.

Pi packages can include extensions, skills, prompt templates, and themes. See the [pi packages docs](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/packages.md) for details.

## Packages

| Package | Type | Description |
|---------|------|-------------|
| [@benvargas/pi-synthetic-provider](./packages/pi-synthetic-provider/) | Extension | [Synthetic](https://synthetic.new) model provider (Kimi, GLM, MiniMax, Qwen, Nemotron, gpt-oss) |
| [@benvargas/pi-antigravity-image-gen](./packages/pi-antigravity-image-gen/) | Extension | Antigravity image generation (Gemini 3 Pro, inline rendering) |
| [@benvargas/pi-exa-mcp](./packages/pi-exa-mcp/) | Extension | **Deprecated**, use Pi's built-in MCP support. Exa MCP tools — web search + code context |
| [@benvargas/pi-firecrawl](./packages/pi-firecrawl/) | Extension | **Deprecated**, use Pi's built-in MCP support. Firecrawl tools — scrape, map, search |
| [@benvargas/pi-themes](./packages/pi-themes/) | Themes | Theme collection with GitHub, Orng, and monochrome light/dark palettes |
| [@benvargas/pi-ancestor-discovery](./packages/pi-ancestor-discovery/) | Extension | Ancestor discovery for skills, prompts, themes |
| [@benvargas/pi-cut-stack](./packages/pi-cut-stack/) | Extension | Cut-stack editor shortcuts |
| [@benvargas/pi-openai-fast](./packages/pi-openai-fast/) | Extension | `/fast` toggle for OpenAI priority service tier on supported GPT-5.4 models |
| [@benvargas/pi-openai-verbosity](./packages/pi-openai-verbosity/) | Extension | Config-backed OpenAI Codex text verbosity rewrites |
| [@benvargas/pi-claude-code-use](./packages/pi-claude-code-use/) | Extension | Anthropic/Claude OAuth compatibility patching |
| [@benvargas/pi-model-sort](./packages/pi-model-sort/) | Extension | Last-usage sorting for the `/model` picker and scoped cycling; fresh starts on the most recently used model |

Each package has its own README with setup instructions, usage, and configuration details.

`pi-exa-mcp` and `pi-firecrawl` are deprecated: Pi 0.99.0 added built-in MCP support, which connects to Exa's and Firecrawl's MCP servers directly. Installing this repository from git (`pi install git:github.com/ben-vargas/pi-packages`) no longer loads them, so after `pi update` their tools are gone from existing git installs. Each package's README explains how to move to Pi's MCP support. Both remain installable from npm.

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

## Install One Package

Install a single package via npm:

```bash
pi install npm:@benvargas/<package-name>
```

Use the specific command from the table above for each package.

<details>
<summary>Install commands by package</summary>

```bash
pi install npm:@benvargas/pi-synthetic-provider
pi install npm:@benvargas/pi-antigravity-image-gen
pi install npm:@benvargas/pi-themes
pi install npm:@benvargas/pi-ancestor-discovery
pi install npm:@benvargas/pi-cut-stack
pi install npm:@benvargas/pi-openai-fast
pi install npm:@benvargas/pi-openai-verbosity
pi install npm:@benvargas/pi-claude-code-use
pi install npm:@benvargas/pi-model-sort
```

</details>

## Uninstall

If installed via git:

```bash
pi remove git:github.com/ben-vargas/pi-packages
```

If installed individually via npm:

```bash
pi remove npm:@benvargas/<package-name>
```

<details>
<summary>Uninstall commands by package</summary>

```bash
pi remove npm:@benvargas/pi-synthetic-provider
pi remove npm:@benvargas/pi-antigravity-image-gen
pi remove npm:@benvargas/pi-exa-mcp
pi remove npm:@benvargas/pi-firecrawl
pi remove npm:@benvargas/pi-themes
pi remove npm:@benvargas/pi-ancestor-discovery
pi remove npm:@benvargas/pi-cut-stack
pi remove npm:@benvargas/pi-openai-fast
pi remove npm:@benvargas/pi-openai-verbosity
pi remove npm:@benvargas/pi-claude-code-use
pi remove npm:@benvargas/pi-model-sort
```

</details>

## Contributing

Each package under `packages/` is independent with its own `package.json`. There is no shared build system — each package is self-contained.

### Testing locally

```bash
cd packages/<package-name>
pi -e .
```

## License

MIT
