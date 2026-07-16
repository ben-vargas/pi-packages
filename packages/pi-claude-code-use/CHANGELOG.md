# Changelog

All notable changes to this package will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this package adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.0.5] - 2026-07-16

### Fixed
- Added Pi 0.80.8+ `registerEntryRenderer` support to the companion capture shim while suppressing duplicate renderer registrations, validated against Pi 0.80.9.
- Added regression coverage for entry-renderer registration and legacy Pi namespace aliases during companion tool capture.

## [1.0.4] - 2026-05-21

### Added
- Rewrites managed MCP alias `toolCall` names back to their canonical flat tool names during `message_end`, so Pi executes the original extension tool rather than the captured alias duplicate.
- Added regression coverage to ensure direct MCP tools from other extensions are not rewritten.

## [1.0.3] - 2026-05-07

### Changed
- Updated pi SDK imports and peer dependencies from `@mariozechner/*` to `@earendil-works/*` for pi 0.74.0.
- Kept compatibility aliases for dynamically loaded companion extensions that still import the old pi SDK namespace.

## [1.0.2] - 2026-05-02

### Added
- Added user-defined `toolAliases` config so flat-named tools from other extensions can be exposed under MCP-style aliases.
- Documented global and project-level alias configuration for custom extension tools.
