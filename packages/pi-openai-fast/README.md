# @benvargas/pi-openai-fast

`/fast` toggle for pi that enables OpenAI priority service tier on configured models.

This extension does not change the model, thinking level, tools, or prompts. It only adds `service_tier=priority` to provider requests when fast mode is active and the current model matches the configured supported-model list.

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
- By default, fast mode persists across new pi sessions via a JSON config file.
- Startup state comes from the selected config file, not from resumed session/thread history.

Example:

```bash
pi -e npm:@benvargas/pi-openai-fast --fast
```

## Config

Config files follow the same project-over-global pattern as the other packages:

- Project: `<repo>/.pi/extensions/pi-openai-fast.json`
- Global: `~/.pi/agent/extensions/pi-openai-fast.json`

If neither exists, the extension writes a default global config on first run.

Default config:

```json
{
  "persistState": true,
  "active": false,
  "supportedModels": [
    "openai/gpt-5.4",
    "openai-codex/gpt-5.4"
  ]
}
```

Settings:

- `persistState`: when `true`, `/fast` writes the current on/off state to config so it resumes in new pi sessions. Default: `true`.
- `active`: persisted fast-mode state used on startup when `persistState` is enabled.
- `supportedModels`: list of `provider/model-id` strings that should receive `service_tier=priority`.

Project config overrides global config. `/fast on` and `/fast off` write to the selected config file, so if a project config exists the remembered state is project-specific. If fast mode is enabled on a model that is not in `supportedModels`, the setting stays on but requests are left unchanged until you switch back to a configured model.

## Notes

- When `persistState` is enabled, the last `/fast` setting also carries across brand-new pi sessions.
- Resumed sessions do not override the config-backed startup state.
- On configured models, fast mode maps to OpenAI `service_tier=priority`.

## Uninstall

```bash
pi remove npm:@benvargas/pi-openai-fast
```

## License

MIT
