# @benvargas/pi-synthetic-provider

[Synthetic](https://synthetic.new) model provider for [pi](https://github.com/badlogic/pi-mono), the AI coding agent.

## Features

- **Dynamic model discovery** -- models fetched live from the Synthetic API at each session start
- **OpenAI Completions API** -- reuses pi's built-in streaming, no custom implementation
- **Tool calling** -- full support via OpenAI-compatible tool use
- **Vision support** -- image input for models that support it (e.g., Kimi-K2.5)
- **Reasoning support** -- extended thinking for reasoning-capable models
- **Cost tracking** -- accurate per-token pricing parsed from the API
- **Graceful degradation** -- fallback model list if the API is unreachable

## Installation

```bash
pi install npm:@benvargas/pi-synthetic-provider
```

Or try without installing:

```bash
pi -e npm:@benvargas/pi-synthetic-provider
```

## Setup

### Option 1: Environment Variable

```bash
export SYNTHETIC_API_KEY="syn_your_key_here"
pi
```

### Option 2: Auth Storage (persistent)

Add to `~/.pi/agent/auth.json`:

```json
{
  "synthetic": {
    "type": "api_key",
    "key": "syn_your_key_here"
  }
}
```

### Option 3: Runtime CLI Flag

```bash
pi --api-key synthetic=syn_your_key_here
```

## Usage

```bash
# Interactive model selection
pi /model

# Direct model selection
pi --model synthetic:hf:moonshotai/Kimi-K2.5

# Use default Synthetic model
pi --model synthetic
```

### Extension Command

- `/synthetic-models` -- display all available models with pricing and capabilities
- `/synthetic-quota` -- display current Synthetic API quota usage, including rolling five-hour, weekly token, and search limits when available

## Available Models

Models are fetched dynamically. As of 2026-03-31, Synthetic provides:

| Model | ID | Reasoning | Vision | Context | Max Output |
|-------|-----|-----------|--------|---------|------------|
| **Kimi K2.5** | `hf:moonshotai/Kimi-K2.5` | Yes | Yes | 262K | 65K |
| **MiniMax M2.1** | `hf:MiniMaxAI/MiniMax-M2.1` | Yes | No | 196K | 65K |
| **MiniMax M2.5** | `hf:MiniMaxAI/MiniMax-M2.5` | Yes | Yes | 191K | 65K |
| **GLM 5** | `hf:zai-org/GLM-5` | Yes | No | 192K | 65K |
| **GLM 4.7** | `hf:zai-org/GLM-4.7` | Yes | No | 202K | 65K |

Run `/synthetic-models` inside pi for the full, current catalog.

## API Key Priority

When multiple sources are configured, pi checks in this order:

1. CLI runtime flag (`--api-key`)
2. Auth storage (`~/.pi/agent/auth.json`)
3. OAuth credentials (if configured)
4. Environment variable (`SYNTHETIC_API_KEY`)

## Requirements

- pi v0.51.0 or later
- A Synthetic API key from [synthetic.new](https://synthetic.new)

## Notes

- On newer Synthetic accounts, `/synthetic-quota` prefers the current rolling five-hour and weekly token limits over the legacy subscription bucket, while still showing search usage when present.
- The provider refresh path is compatible with current pi releases that expect dynamic provider updates to go through `pi.registerProvider(...)`.

## Uninstall

```bash
pi remove npm:@benvargas/pi-synthetic-provider
```

## License

MIT
