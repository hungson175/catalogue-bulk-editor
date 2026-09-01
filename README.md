# Catalogue Bulk Editor

Catalogue Bulk Editor lets an agent inspect and stage a policy across 14,000 catalogue records while
only a human can release the staged changes.

The static page registers four catalogue tools through WebMCP:

- `catalogue_summary`
- `preview_supplier_policy`
- `inspect_staged_changes`
- `discard_staged_changes`

None can write a catalogue record. Preview creates one immutable 340-record stage; Apply, Decline,
and Undo remain normal human buttons guarded by trusted browser gestures. **Unrig** visibly switches
from the 30-row virtualized view to all 14,000 real DOM rows without changing product state.

## Run from a fresh clone

No install, key, model, login, backend, build, or browser extension is required:

```sh
python3 -m http.server 4173 --bind 127.0.0.1
# open http://127.0.0.1:4173/
```

Use a current Chrome build for WebMCP. Browsers without `document.modelContext` fail closed while the
same keyless product interface and command palette continue to work.

## Watch mode

The visible recording overlay permanently labels itself `KEYLESS REPLAY · NOT A NATIVE AGENT`. It
runs 5 steps (5 adapter calls) against the page's real frozen callback. Those calls truthfully produce
9 zero-written ledger rows: Preview's UI composition adds four bounded inspections before the explicit
inspection. The actual output and live `{dom, staged, written, refusal, undo}` metrics are displayed;
scenario expectations are assertions, never canned output.

## Tests

```sh
npm test
python3 -m unittest tests/watch_mode_browser.py
```

The Node suite has no package dependency. Browser checks use Playwright and a compatible Chrome binary.
This project is static and can be hosted directly from the repository root.

## Claim boundary (local package only)

This is a **local, keyless replay** package. Local HTTP and programmatic replay do not prove the
registered public origin or a native model invocation.

**Pending until their separate gates pass — do not claim as proven:**

- public origin `https://hungson175.github.io/catalogue-bulk-editor/` and origin-trial invocation in
  stock Chrome 154 without flags — **pending**;
- WebMCP native agent invocation — `native agent: UNPROVEN` and
  `PROGRAMMATIC_ZERO_WRITE_TOOLS` only;
- public repository and GitHub Pages deployment — **pending**;
- narrated video and final capture proof — **pending**.

See `LICENSE` and `NOTICE.md` for MIT licensing and shared-module provenance.
