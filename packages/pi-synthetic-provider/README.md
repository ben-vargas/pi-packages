# @benvargas/pi-synthetic-provider

[Synthetic](https://synthetic.new) model provider for [pi](https://github.com/badlogic/pi-mono), the AI coding agent.

## Features

- **Dynamic model discovery** -- models fetched live from the Synthetic API at each session start
- **OpenAI Completions API** -- reuses pi's built-in streaming, no custom implementation
- **Tool calling** -- full support via OpenAI-compatible tool use
- **Vision support** -- image input for models that support it (e.g., Kimi-K3)
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
pi --model synthetic/hf:moonshotai/Kimi-K3 --api-key syn_your_key_here
```

## Usage

```bash
# Interactive model selection
pi /model

# Direct model selection
pi --model synthetic/hf:moonshotai/Kimi-K3

# Or use provider + model flags separately
pi --provider synthetic --model hf:moonshotai/Kimi-K3
```

### Extension Command

- `/synthetic-models` -- display all available models with pricing and capabilities
- `/synthetic-quota` -- display current Synthetic API quota usage, including rolling five-hour, weekly token, and search limits when available

## Available Models

Models are fetched at startup from the [Synthetic models endpoint](https://dev.synthetic.new/docs/api/models). If the startup fetch fails, times out after three seconds, or returns no supported models, the provider falls back to the following hardcoded defaults:

Prices are $ per million tokens, current as of 2026-08-30.

| Model | ID | Reasoning | Vision | Context | Max Output | In / Out / Cache |
|-------|-----|-----------|--------|---------|------------|------------------|
| **Synthetic Large Text** | `syn:large:text` | Yes | Yes | 524K | 65K | 0.15 / 0.50 / 0.04 |
| **Synthetic Small Text** | `syn:small:text` | Yes | No | 196K | 65K | 0.10 / 0.50 / 0.02 |
| **Synthetic Large Vision** | `syn:large:vision` | Yes | Yes | 524K | 65K | 3.00 / 15.00 / 0.45 |
| **Synthetic Small Vision** | `syn:small:vision` | Yes | Yes | 262K | 65K | 0.45 / 2.20 / 0.09 |
| **GLM 5.3 Flash** | `hf:zai-org/GLM-5.3-Flash` | Yes | Yes | 524K | 65K | 0.15 / 0.50 / 0.04 |
| **GLM 5.2** | `hf:zai-org/GLM-5.2` | Yes | No | 524K | 65K | 1.00 / 3.00 / 0.16 |
| **GPT OSS 120B** | `hf:openai/gpt-oss-120b` | Yes | No | 131K | 65K | 0.10 / 0.10 / 0.02 |
| **Kimi K3** | `hf:moonshotai/Kimi-K3` | Yes | Yes | 524K | 65K | 3.00 / 15.00 / 0.45 |
| **Qwen 3.8 27B** | `hf:Qwen/Qwen3.8-27B` | Yes | Yes | 262K | 65K | 0.45 / 2.20 / 0.09 |
| **GLM 4.7 Flash** | `hf:zai-org/GLM-4.7-Flash` | Yes | No | 196K | 65K | 0.10 / 0.50 / 0.02 |
| **Nemotron 3 Super 120B** | `hf:nvidia/NVIDIA-Nemotron-3-Super-120B-A12B-NVFP4` | Yes | No | 262K | 65K | 0.30 / 1.00 / 0.06 |

The `syn:*` ids are permalinks that Synthetic re-points as models rotate, so configs using them survive model retirements — `syn:large:text` moved from GLM 5.2 to the vision-capable GLM 5.3-Flash, and `syn:small:vision` from Qwen 3.6 to Qwen 3.8. The `hf:*` ids pin a specific model and break when it is retired.

### Thinking levels

During live discovery, the extension derives each model's exact pi thinking levels from the catalog's `reasoning_parameters.efforts`. Unsupported levels are hidden instead of being mapped onto values the route does not advertise. This works for pinned `hf:*` ids and for `syn:*` permalinks, so a permalink automatically follows its current target's effort controls when Synthetic re-points it.

Kimi K3 and GLM 5.3-Flash advertise `low`, `high`, and `max`. They always reason, so `off` is unavailable; pi sends those values unchanged as top-level `reasoning_effort`. Qwen 3.8-27B similarly has no `none` and tops out at `xhigh`. `/synthetic-models` shows the advertised values in the selected model details.

If the catalog request fails, pinned fallback models use hardcoded snapshots of their last advertised effort lists. Offline permalinks deliberately emit no `reasoning_effort`: without a live row there is no trustworthy way to know what an alias currently targets. Pi still displays its generic `off` through `high` levels for those fallback aliases because they declare `reasoning: true`, but the selections have no effect on the request.

An explicit non-reasoning capability list or an empty/unrecognized live effort list fails closed and emits no `reasoning_effort`. A rejected value can fail the entire request, while omission uses the server-side default.

Kimi K3 is at beta launch pricing; Synthetic expects to lower it as engine optimization improves. Run `/synthetic-models` inside pi for the live catalog.

## API Key Priority

When multiple sources are configured, pi checks in this order:

1. CLI runtime flag (`--api-key`)
2. Auth storage (`~/.pi/agent/auth.json`)
3. OAuth credentials (if configured)
4. Environment variable (`SYNTHETIC_API_KEY`)

## Requirements

- pi v0.77.0 or later
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
