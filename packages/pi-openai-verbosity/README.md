# @benvargas/pi-openai-verbosity

Per-model text verbosity overrides for pi's `openai` and `openai-codex` providers.

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
`openai-codex` model to `low`. That may not be ideal for all model slugs. For example, the Codex CLI's own
default for `gpt-5.4-mini` is `medium`, not `low`, and you may prefer `high` on a model you use for
long-form writing.

This extension now provides the missing user-facing control: per-slug verbosity settings for pi's
`openai-codex` provider.

pi 1.x supersedes `openai-codex` (now "OpenAI Codex (legacy)") with Sign in with ChatGPT on the `openai`
provider. That provider sends no `text.verbosity`, so requests run at the Responses API default (`medium`) rather
than the Codex CLI's per-model defaults. The extension applies the same Codex CLI defaults to `openai/<model>`
keys, so ChatGPT-backed sessions keep their Codex verbosity.

Requires pi `0.74.0` or newer.

## What It Does

The extension uses pi's `before_provider_request` hook to rewrite outgoing provider payloads for configured
`openai/<model>` and `openai-codex/<model>` keys.

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
- Global: `<agent-dir>/extensions/pi-openai-verbosity.json`

The global path uses pi's agent directory — `~/.pi/agent` by default, or wherever `PI_CODING_AGENT_DIR`
points if you have relocated it.

Older versions of this extension always used `~/.pi/agent`, even when `PI_CODING_AGENT_DIR` was set. If you
have relocated the agent directory and it contains no config, a config left at the legacy
`~/.pi/agent/extensions/pi-openai-verbosity.json` path is still honored; it is read in place and never
modified. A config in the relocated directory takes precedence once you create one there.

If no config exists at any of these locations, the extension writes a default global config on first run.

Example config:

```json
{
  "models": {
    "openai-codex/gpt-5.6-sol": "low",
    "openai-codex/gpt-5.5": "low",
    "openai-codex/gpt-5.4-mini": "medium",
    "openai-codex/gpt-5.3-codex-spark": "medium"
  }
}
```

Settings:

- `models`: object mapping `openai/<model-id>` or `openai-codex/<model-id>` strings to `low`, `medium`, or `high`.

Project config overrides global config per model key. Any model not listed is left unchanged, which means pi's
native default behavior applies.

## Default Config

By default, the extension mirrors the Codex CLI's own per-model verbosity defaults for every model in pi's
`openai-codex` catalog and for the matching current models on `openai`. That means `low` everywhere except
`gpt-5.4-mini`, whose upstream default is `medium` (pi's blanket `openai-codex` fallback would otherwise force it
to `low`):

```json
{
  "models": {
    "openai/gpt-5.3-codex-spark": "low",
    "openai/gpt-5.4": "low",
    "openai/gpt-5.4-mini": "medium",
    "openai/gpt-5.5": "low",
    "openai/gpt-5.6-luna": "low",
    "openai/gpt-5.6-sol": "low",
    "openai/gpt-5.6-terra": "low",
    "openai/gpt-6-astra": "low",
    "openai/gpt-6-luna": "low",
    "openai/gpt-6-sol": "low",
    "openai/gpt-6.1-sol": "low",
    "openai-codex/gpt-5.3-codex-spark": "low",
    "openai-codex/gpt-5.4": "low",
    "openai-codex/gpt-5.4-mini": "medium",
    "openai-codex/gpt-5.5": "low",
    "openai-codex/gpt-5.6-luna": "low",
    "openai-codex/gpt-5.6-sol": "low",
    "openai-codex/gpt-5.6-terra": "low",
    "openai-codex/gpt-6-astra": "low"
  }
}
```

You can change any value to override the default for that model. If you have an existing config file from an
older version of this extension, your file's entries win over these defaults, and entries for model slugs pi no
longer exposes are simply ignored.

## Why not `samplingParams`?

pi 0.84.0 added `samplingParams`, which lets you pass arbitrary OpenAI-compatible parameters through
`models.json`, model overrides, and extension providers. Reading those release notes, it is natural to assume
this extension is now redundant and that you can write:

```json
{
  "modelOverrides": {
    "openai-codex/gpt-5.5": {
      "samplingParams": { "text": { "verbosity": "medium" } }
    }
  }
}
```

**On `openai-codex` this silently does nothing.** There is no error and no warning; the setting is simply never
applied. `samplingParams` is explicitly scoped to OpenAI-*compatible* adapters — pi-ai documents it as "only
applied by OpenAI-compatible adapters (completions, responses, Azure responses); other APIs ignore it" — and
the Codex adapter is not one of them. It builds its own request and hardcodes `text: { verbosity: ... }`,
defaulting to `low`.

So for the `openai-codex` provider, this extension remains the only way to set per-model verbosity.

### If you use `samplingParams` on the plain `openai` provider

There it *is* applied, so `samplingParams` is a native alternative for `openai` models. However, the merge is a shallow top-level `Object.assign`. That means:

```json
{ "samplingParams": { "text": { "verbosity": "medium" } } }
```

replaces the **entire** `text` object rather than merging into it, discarding any other `text` fields pi had
already set. This extension deliberately does the opposite: it preserves existing `text` fields and replaces
only `text.verbosity`.

## Debugging

Pi does not currently expose a simple CLI flag to print the final provider request body. To verify this extension is
matching and rewriting a request, set `PI_OPENAI_VERBOSITY_DEBUG_LOG` to a JSONL file path.

| Variable | Description |
|---|---|
| `PI_OPENAI_VERBOSITY_DEBUG_LOG` | Set to a file path to enable debug logging. Matching requests write `"before"` and `"after"` JSON entries with the full provider payload. Non-matching requests write one `"skipped"` entry. |

```bash
PI_OPENAI_VERBOSITY_DEBUG_LOG=/tmp/pi-openai-verbosity.jsonl \
  pi -e npm:@benvargas/pi-openai-verbosity \
  --model openai-codex/gpt-5.6-sol \
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
- The `openai` and `openai-codex` providers are supported. pi's `samplingParams` does not reach `openai-codex`, so
  this extension remains the only per-model verbosity control for it — see
  [Why not `samplingParams`?](#why-not-samplingparams).
- On `openai`, the shipped defaults change requests from the API default (`medium`) to the Codex CLI defaults. Set a
  model to `medium` in your config to keep the API default for it.
- Older OpenAI models such as `gpt-4.1` reject `text.verbosity`, so only add models that support it.

## Uninstall

```bash
pi remove npm:@benvargas/pi-openai-verbosity
```

## License

MIT
