# @benvargas/pi-themes

A collection of themes for [pi](https://github.com/earendil-works/pi).

## Included Themes

| Theme | Appearance | Description |
|-------|------------|-------------|
| `github-light-default` | Light | GitHub Light Default-inspired interface, Markdown, tool, diff, syntax, and thinking-level colors |
| `orng-light` | Light | Adaptation of OpenCode's warm orange Orng theme |

## Install

```bash
pi install npm:@benvargas/pi-themes
```

Or try it without installing:

```bash
pi -e npm:@benvargas/pi-themes
```

For local development from this repository:

```bash
pi -e ./packages/pi-themes
```

## Select a Theme

Choose an installed theme from `/settings`, or set its name in `~/.pi/agent/settings.json`:

```json
{
  "theme": "github-light-default"
}
```

### GitHub Light Default

`github-light-default` is designed for a terminal with a light background, ideally `#ffffff` or `#f6f8fa`. Pi does not set the terminal's full background, so dark terminal profiles will not display this theme correctly.

Its palette is adapted from the MIT-licensed [GitHub VS Code theme](https://github.com/primer/github-vscode-theme) by Primer. The pi token mapping was designed as a light companion to Benjamin Davis's [`github-dark-default`](https://github.com/davis7dotsh/my-pi-setup/blob/main/themes/github-dark-default.json) theme.

This project is not affiliated with or endorsed by GitHub.

### Orng Light

`orng-light` adapts the light variant of OpenCode's built-in [Orng theme](https://github.com/anomalyco/opencode/blob/dev/packages/tui/src/theme/assets/orng.json). It preserves the orange, blue, cyan, red, gold, and warm neutral palette while mapping OpenCode's interface, Markdown, syntax, and diff roles to pi's theme tokens.

The original Orng theme was created by Matt Silverlock and is distributed with OpenCode under the MIT license. This adaptation uses a darker recurring muted-text color for readability while retaining Orng's original `#8a8a8a` for deliberately dim content such as comments.

Like the other light theme, `orng-light` expects a terminal with a light background.

## Versioning

This package follows [Semantic Versioning](https://semver.org/). See [CHANGELOG.md](./CHANGELOG.md) for release history.

## Uninstall

```bash
pi remove npm:@benvargas/pi-themes
```

## License

MIT. See [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md) for upstream palette licenses.
