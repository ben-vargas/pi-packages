# Changelog

All notable changes to this package will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this package adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.2.1] - 2026-10-25

### Fixed
- Pointed each theme's `$schema` at `https://pi.dev/schemas/theme.schema.json`. Pi 1.2.0 moved the published theme schema there, and the old GitHub source path no longer exists. All themes validate with Pi 1.4.0's theme loader.

## [1.2.0] - 2026-08-11

### Added
- Added `mono-black` and `mono-light`, adapted from the MIT-licensed `kartikkabadi/pi-mono-themes` project.
- Added documentation for using the monochrome themes as a pi 0.84.0 automatic light/dark pair.
- Added explicit HTML export color mappings for both monochrome themes.

### Changed
- Added visible grayscale `scrollbarThumb` colors instead of relying on the low-contrast `selectedBg` fallback.
- Added the upstream source snapshot, local modifications, copyright, and complete MIT license to the third-party notices.

## [1.1.0] - 2026-08-06

### Added
- Added the `scrollbarThumb` color to both themes for pi 0.84's fullscreen transcript scrollbar. The token is optional and falls back to `selectedBg`, which both themes set to a tinted surface — rendering the thumb at 1.07:1 (`github-light-default`) and 1.13:1 (`orng-light`) against the page background, effectively invisible.
- `github-light-default` gains a `borderStrong` var, `#8c959f`, which is GitHub's own scrollbar thumb color and follows the existing `surface`/`surfaceStrong` naming. Contrast rises to 2.85:1.
- `orng-light` reuses the existing `primary` var, which already backs `border`, so the scrollbar matches the theme's other edges. Contrast rises to 3.44:1.

### Note
- Both files continue to reference vars rather than literals, matching the existing style. The key is optional and pi's runtime theme validator accepts unknown color keys, so this introduces no version floor for users on older pi.

## [1.0.0] - 2026-07-14

### Added
- Initial `@benvargas/pi-themes` package with Pi theme discovery for npm and repository-level installs.
- Added `github-light-default`, adapted from the MIT-licensed GitHub VS Code theme by Primer.
- Added `orng-light`, adapted from OpenCode's MIT-licensed Orng theme with Pi-specific semantic mappings and muted-text contrast adjustments.
- Added package documentation, local testing instructions, licensing, and third-party attribution.
