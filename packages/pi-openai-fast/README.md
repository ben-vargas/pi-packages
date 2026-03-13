# @benvargas/pi-openai-fast

Session-scoped `/fast` toggle for pi that enables OpenAI priority service tier on supported GPT-5.4 models.

This extension does not change the model, thinking level, tools, or prompts. It only adds `service_tier=priority` to provider requests when fast mode is active and the current model supports it.

Requires pi `0.57.0` or newer.

## Install

```bash
pi install npm:@benvargas/pi-openai-fast
```

Or try without installing:

```bash
pi -e npm:@benvargas/pi-openai-fast
```

## Usage

- `/fast` toggles fast mode on or off.
- `/fast on` explicitly enables fast mode.
- `/fast off` explicitly disables fast mode.
- `/fast status` reports the current fast-mode state.
- `--fast` starts the session with fast mode enabled.

Example:

```bash
pi -e npm:@benvargas/pi-openai-fast --fast
```

## Supported Models

- `openai/gpt-5.4`
- `openai-codex/gpt-5.4`

If fast mode is enabled on an unsupported model, the setting stays on but requests are left unchanged until you switch back to a supported model.

## Notes

- Fast mode is stored as session state, so it persists with the session branch.
- On supported models, fast mode maps to OpenAI `service_tier=priority`.

## Uninstall

```bash
pi remove npm:@benvargas/pi-openai-fast
```

## License

MIT
