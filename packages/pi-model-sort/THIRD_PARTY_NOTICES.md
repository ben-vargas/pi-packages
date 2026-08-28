# Third-Party Notices

## pi-model-sort

This package is adapted from [monotykamary/pi-model-sort](https://github.com/monotykamary/pi-model-sort),
version 0.3.2, by Tom X Nguyen. The upstream project is MIT-licensed (see its
`package.json`); it did not ship a standalone `LICENSE` file at the time of
forking.

Modifications in this fork:

- The MRU startup override skips continued sessions (`pi -c`, `--session`)
  so the model restored from the session file is preserved; continuation is
  detected by projecting the branch through pi's context-message rules
  (message, custom_message, non-empty branch_summary, compaction entries)
  because pi seeds new sessions with model/thinking entries before
  `session_start`.
- Continued sessions record their restored model as last-used (pi 0.84.3
  does not emit `model_select` for construction-time restoration).
- `unpatchRegistry()` (defined but never called upstream) is invoked on
  `session_shutdown` so registry cleanup is symmetric with the other patches.
- Upstream non-null assertions in the scoped-loader, filter, and cycle
  wrappers were replaced with runtime null guards.
- `findMruModel` moved into the shared helpers module and is exported for
  testing.
- Code reformatted to this repository's Biome configuration and restructured
  to the `extensions/` package layout; documentation corrected for the
  surfaces actually affected on pi 0.84.x.

MIT License

Copyright (c) 2026 Tom X Nguyen

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.