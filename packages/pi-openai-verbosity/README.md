# @benvargas/pi-openai-verbosity

Per-model text verbosity overrides for pi's `openai-codex` provider.

## Why This Exists

This extension was originally created because pi sent OpenAI Codex provider requests with the default Responses
API text verbosity, which made some models, especially `gpt-5.5`, noticeably more verbose than the Codex CLI.
The goal was to align `openai-codex/gpt-5.5` with Codex CLI behavior by setting:

```json
{
  "text": {
    "verbosity": "low"
  }
}
```

pi has since shipped an upstream fix: OpenAI Codex Responses requests now default to `low` verbosity when no
explicit verbosity is provided.

That upstream change addresses the original `gpt-5.5` issue, but it also means pi now defaults every
`openai-codex` model to `low`. That may not be ideal for all model slugs. For example, you may prefer `low` on
`gpt-5.5`, but `medium` on an older or different model such as `gpt-5.3-codex`.

This extension now provides the missing user-facing control: per-slug verbosity settings for pi's
`openai-codex` provider.

Requires pi `0.57.0` or newer.

## What It Does

The extension uses pi's `before_provider_request` hook to rewrite outgoing provider payloads for configured
`openai-codex/<model>` keys.

For matching models, it sets:

```json
{
  "text": {
    "verbosity": "low | medium | high"
  }
}
```

Non-matching models are left unchanged.

## Install

```bash
pi install npm:@benvargas/pi-openai-verbosity
```

Or try without installing:

```bash
pi -e npm:@benvargas/pi-openai-verbosity
```

## Usage

Run pi with the extension enabled:

```bash
pi -e npm:@benvargas/pi-openai-verbosity --model openai-codex/gpt-5.5
```

Use `/openai-verbosity status` inside pi to report the configured rewrite for the current model. The command also
reloads the config file.

## Config

Config files follow pi's project-over-global pattern:

- Project: `<repo>/.pi/extensions/pi-openai-verbosity.json`
- Global: `~/.pi/agent/extensions/pi-openai-verbosity.json`

If neither exists, the extension writes a default global config on first run.

Example config:

```json
{
  "models": {
    "openai-codex/gpt-5.5": "low",
    "openai-codex/gpt-5.4": "low",
    "openai-codex/gpt-5.3-codex": "medium",
    "openai-codex/gpt-5.3-codex-spark": "medium",
    "openai-codex/gpt-5.2": "medium"
  }
}
```

Settings:

- `models`: object mapping `openai-codex/<model-id>` strings to `low`, `medium`, or `high`.

Project config overrides global config per model key. Any model not listed is left unchanged, which means pi's
native default behavior applies.

## Default Config

By default, the extension preserves the original workaround behavior and sets known supported OpenAI Codex models
to `low`:

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

You can change any value to `medium` or `high` to override pi's native low-verbosity default for that model.

## Debugging

Pi does not currently expose a simple CLI flag to print the final provider request body. To verify this extension is
matching and rewriting a request, set `PI_OPENAI_VERBOSITY_DEBUG_LOG` to a JSONL file path.

| Variable | Description |
|---|---|
| `PI_OPENAI_VERBOSITY_DEBUG_LOG` | Set to a file path to enable debug logging. Matching requests write `"before"` and `"after"` JSON entries with the full provider payload. Non-matching requests write one `"skipped"` entry. |

```bash
PI_OPENAI_VERBOSITY_DEBUG_LOG=/tmp/pi-openai-verbosity.jsonl \
  pi -e npm:@benvargas/pi-openai-verbosity \
  --model openai-codex/gpt-5.3-codex \
  -p "Reply in one short sentence."
```

Then inspect the last entries:

```bash
tail -n 5 /tmp/pi-openai-verbosity.jsonl | jq .
```

These entries include prompts, messages, tools, and the rest of the provider payload, so keep the file local and
delete it when you are done debugging.

## Notes

- This extension only changes outgoing provider request payloads.
- Existing `text` fields are preserved, and only `text.verbosity` is replaced.
- Only the `openai-codex` provider is supported.
- This extension is most useful if you want different verbosity settings for different OpenAI Codex model slugs.

## Uninstall

```bash
pi remove npm:@benvargas/pi-openai-verbosity
```

## License

MIT
