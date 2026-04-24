# @benvargas/pi-antigravity-image-gen

Deprecated and disabled.

Google has started banning accounts that use third-party harnesses against Antigravity. To avoid putting users' Google accounts at risk, this package no longer registers image-generation tools.

The extension remains in the repository only so existing installs fail closed with a clear warning instead of continuing to send requests with stale Antigravity client fingerprints.

## Migration

Remove this package from your installed pi extensions:

```bash
pi uninstall @benvargas/pi-antigravity-image-gen
```

Use a provider-supported image generation workflow instead of an Antigravity harness.
