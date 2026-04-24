# @benvargas/pi-openai-verbosity

Config-backed text verbosity rewrites for pi provider requests.

This extension uses pi's `before_provider_request` hook to set provider request verbosity when the current model matches a configured `provider/model-id` key. It initially supports OpenAI Codex provider models that Codex marks as verbosity-capable.

Requires pi `0.57.0` or newer.

## Install

```bash
pi install npm:@benvargas/pi-openai-verbosity
```

Or try without installing:

```bash
pi -e npm:@benvargas/pi-openai-verbosity
```

## Usage

By default, the extension sets `text.verbosity` to `low` for supported `openai-codex/*` models.

```bash
pi -e npm:@benvargas/pi-openai-verbosity --model openai-codex/gpt-5.5
```

Use `/openai-verbosity status` to report the configured rewrite for the current model. The command also reloads the config file.

## Config

Config files follow the same project-over-global pattern as the other packages:

- Project: `<repo>/.pi/extensions/pi-openai-verbosity.json`
- Global: `~/.pi/agent/extensions/pi-openai-verbosity.json`

If neither exists, the extension writes a default global config on first run.

Default config:

```json
{
  "models": {
    "openai-codex/gpt-5.4": "low",
    "openai-codex/gpt-5.5": "low",
    "openai-codex/gpt-5.4-mini": "low",
    "openai-codex/gpt-5.3-codex": "low",
    "openai-codex/gpt-5.3-codex-spark": "low",
    "openai-codex/gpt-5.2": "low",
    "openai-codex/codex-auto-review": "low"
  }
}
```

Settings:

- `models`: object mapping supported `provider/model-id` strings to `low`, `medium`, or `high`. Currently, supported keys must use the `openai-codex` provider.

Project config overrides global config per model key. Any model not listed is left unchanged.

The default model list comes from `~/.codex/models_cache.json` entries with `support_verbosity: true`, mapped to pi's `openai-codex/<slug>` provider keys.

Example:

```json
{
  "models": {
    "openai-codex/gpt-5.5": "low",
    "openai-codex/gpt-5.4": "low"
  }
}
```

## Environment Variables

Pi does not currently expose a simple CLI flag to print the final provider request body. To verify this extension is matching and rewriting a request, set `PI_OPENAI_VERBOSITY_DEBUG_LOG` to a JSONL file path.

| Variable | Description |
|---|---|
| `PI_OPENAI_VERBOSITY_DEBUG_LOG` | Set to a file path to enable debug logging. Matching requests write `"before"` and `"after"` JSON entries with the full provider payload. Non-matching requests write one `"skipped"` entry. |

```bash
PI_OPENAI_VERBOSITY_DEBUG_LOG=/tmp/pi-openai-verbosity.jsonl \
  pi -e npm:@benvargas/pi-openai-verbosity \
  --model openai-codex/gpt-5.5 \
  -p "Reply in one short sentence."
```

Then inspect the last entries:

```bash
tail -n 5 /tmp/pi-openai-verbosity.jsonl | jq .
```

These entries include prompts, messages, tools, and the rest of the provider payload, so keep the file local and delete it when you are done debugging.

## Notes

- The extension only changes the outgoing request payload.
- Existing `text` fields are preserved, and only `text.verbosity` is replaced.
- Non-matching models are ignored.

## Uninstall

```bash
pi remove npm:@benvargas/pi-openai-verbosity
```

## License

MIT
