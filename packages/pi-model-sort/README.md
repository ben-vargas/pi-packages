# @benvargas/pi-model-sort

Sorts pi's model picker by last usage and starts fresh sessions on your most recently used model.

- `/model` picker — both "Scope: all" and "Scope: scoped" views, including fuzzy-search results — is sorted by recency: current model first → most recently used → provider/id alphabetical
- Ctrl+P / Ctrl+Shift+P **scoped** cycling follows last-used order (scoped models come from `enabledModels` or `--models`)
- Fresh starts and `/new` begin on your most recently used model instead of `enabledModels[0]` or the hardcoded provider default
- Continued sessions (`pi -c`, `--session`, `/resume`, forks) keep the model saved in the session file, and that restored model is recorded as last-used (fresh `/new` sessions and `/reload` are excluded from that recording)
- Remembers the thinking level you last used on each model and restores it on every switch, clamped to what each model supports
- No configuration needed — tracking starts on first use and degrades to the default alphabetical order with no history

> Forked from [monotykamary/pi-model-sort](https://github.com/monotykamary/pi-model-sort) (MIT, v0.3.2). See `THIRD_PARTY_NOTICES.md` for the full list of fork changes and attribution.

## Install

```bash
pi install npm:@benvargas/pi-model-sort
```

Or try without installing:

```bash
pi -e npm:@benvargas/pi-model-sort
```

## Usage

The extension works automatically — there are no commands to learn.

```
/model                    # Most recently used models appear at the top
Ctrl+P / Ctrl+Shift+P     # Cycle through scoped models in last-used order
pi                        # Fresh starts use MRU
pi -c                     # Continuations keep the session's model
```

## How It Works

- Tracking uses pi's documented extension events: `/model` switches (`model_select`) and thinking-level changes (`thinking_level_select`) are timestamped into `~/.pi/agent/extensions/pi-model-sort.json`. Continued sessions restore their model during construction without emitting `model_select` (pi 0.84.3), so the extension records the restored model at `session_start` itself.
- Sorting has no SDK hook, so the extension wraps (monkey-patches) internal methods: `ModelSelectorComponent.sortModels`, its scoped loader and `filterModels`, and `AgentSession._cycleScopedModel` for scoped cycling. All original methods are preserved and restored on shutdown/reload; the patches survive `modelRegistry.refresh()`.
- The MRU startup override calls `pi.setModel()` on `session_start` for fresh starts and `/new` only. A continued session is detected by projecting its branch through pi's own context-message rules (`message`, `custom_message`, non-empty `branch_summary`, and `compaction` entries — exactly what `buildSessionContext()` counts) — pi seeds every new session with `model_change` + `thinking_level_change` entries before `session_start` fires, so raw branch length cannot distinguish fresh from continued.

### Known limitations on pi 0.84.x

- `--list-models` output is **not** sorted: the CLI lists models before extensions load and re-sorts by provider/id internally.
- `/scoped-models` and unscoped Ctrl+P cycling are **not** re-sorted: they read `ModelRuntime` snapshots directly, not the extension-facing `ModelRegistry` facade this extension wraps. (Scoped cycling — the common case with `enabledModels` set — is sorted via the `_cycleScopedModel` wrapper.)

## Configuration

Usage history lives in `~/.pi/agent/extensions/pi-model-sort.json`:

```json
{
  "lastUsed": {
    "provider/modelId": 1717000000000
  },
  "thinking": {
    "provider/modelId": "high"
  }
}
```

No manual editing is needed. To clear usage history, delete the file and `/reload`.

## Notes

- Ctrl+P cycling does not update last-used timestamps — doing so would create a sort feedback loop (each cycle step re-sorts the selected model to the top, making the cycle toggle forever between the top two). Manual selections and session restores still update it.
- Patches are coupled to pi internals; this package is maintained against current pi releases (peer requirement `>=0.84.0`, the version it is tested with).

## Uninstall

```bash
pi remove npm:@benvargas/pi-model-sort
```