# Changelog

All notable changes to this package will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this package adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.0.5] - 2026-07-14

### Added
- Added fast mode support for GPT-5.6 Sol, Terra, and Luna on both the `openai` and `openai-codex` providers.
- Added regression coverage for GPT-5.6 model matching and default configuration.

### Changed
- Migrated the previous GPT-5.4-only and GPT-5.4/GPT-5.5 default model lists to include supported GPT-5.6 variants while preserving custom `supportedModels` lists.
