# @benvargas/pi-ancestor-discovery

Recursive ancestor discovery for pi resources (skills, prompts, themes).

This extension uses the `resources_discover` hook (pi v0.51.0+) to walk upward from your current working directory and discover resource folders at each ancestor level.

## Install

```bash
pi install npm:@benvargas/pi-ancestor-discovery
```

## Default behavior

- Enabled: skills
- Disabled: prompts, themes
- Search paths: `.pi/skills`, `.agents/skills`
- Boundary: home directory (`~`)

This means it will look for `.pi/skills` and `.agents/skills` at each ancestor directory from `cwd` up to your home directory.

## Configuration

Create a JSON config file in one of these locations:

- Project: `.pi/extensions/pi-ancestor-discovery.json`
- Global: `~/.pi/agent/extensions/pi-ancestor-discovery.json`

Project config overrides global config.
If neither exists, the extension writes the default config to the global path on first run.

### Example: enable prompts and themes

```json
{
  "boundary": "home",
  "resources": {
    "skills": {
      "enabled": true,
      "searchPaths": [".pi/skills", ".agents/skills"]
    },
    "prompts": {
      "enabled": true,
      "searchPaths": [".pi/prompts"]
    },
    "themes": {
      "enabled": true,
      "searchPaths": [".pi/themes"]
    }
  }
}
```

### Example: include Claude skills too

```json
{
  "resources": {
    "skills": {
      "enabled": true,
      "searchPaths": [".pi/skills", ".agents/skills", ".claude/skills"]
    }
  }
}
```

## Boundary options

- `"home"` or `"~"`: stop at the home directory (default)
- `"root"` or `"/"`: stop at the filesystem root
- `"/absolute/path"`: stop when that absolute path is reached

The boundary directory is included in the search.

## Notes

- Paths are returned closest-first, so nearer resources win name collisions.
- Absolute or `~`-prefixed search paths are treated as fixed locations and appended after ancestor discovery.

## Uninstall

```bash
pi remove npm:@benvargas/pi-ancestor-discovery
```

## License

MIT
