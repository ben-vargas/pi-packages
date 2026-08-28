# Changelog

All notable changes to this package will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this package adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.0.0] - 2026-08-28

### Added
- Initial `@benvargas/pi-model-sort` package, forked from
  [monotykamary/pi-model-sort](https://github.com/monotykamary/pi-model-sort)
  v0.3.2 (MIT): last-usage sorting for the `/model` picker (all and scoped
  views, fuzzy-search results) and scoped Ctrl+P cycling; MRU model selection
  on fresh starts; per-model thinking level memory; persistent usage history
  in `~/.pi/agent/extensions/pi-model-sort.json`.
- Continued sessions (`pi -c`, `--session`, `/resume`, context-bearing
  forks) record their restored model as last-used — pi 0.84.3 restores without
  emitting `model_select`, so the extension timestamps it at `session_start`
  (fresh `new` sessions and `reload` are excluded).
- Unit tests for continuation detection (including pi's new-session entry
  seeding, context-only summarized branches, and compaction-only branches),
  MRU auth fallback, restore-timestamp gating, and config sanitization.

### Changed
- Fork change from upstream: the MRU startup override skips continued
  sessions. Upstream applies the override on every `startup` session start,
  which replaces the model restored by `pi -c` (or `--session`) with the
  global most-recently-used model. Continuation is detected by projecting
  the branch through pi's context-message rules (`message`, `custom_message`,
  non-empty `branch_summary`, `compaction` — the same predicate
  `buildSessionContext()` uses) — pi seeds every new session with
  `model_change` + `thinking_level_change` entries before `session_start`
  fires, so raw branch length would disable the override everywhere, and
  literal-message-only detection would miss context-only summarized
  branches.
- Registry cleanup on `session_shutdown` (`unpatchRegistry` is defined but
  never called upstream).
- Documentation narrowed to the surfaces actually affected on pi 0.84.x:
  `--list-models`, `/scoped-models`, and unscoped Ctrl+P cycling read
  `ModelRuntime` directly and are not re-sorted (upstream README claims
  otherwise for older pi versions).
- Peer dependency floor set to the tested-with release
  (`@earendil-works/pi-coding-agent >=0.84.0`).