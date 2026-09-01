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

Four tools are deliberate depth, not a padded count: summary proves page-owned reach, preview creates
real staged state, inspect reads it through bounded pages, and discard closes the zero-write lifecycle.
Row CRUD and Apply/Undo tools are absent because they would enlarge agent authority and bypass the
human release boundary.

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

## Strongest-case DOM comparison: atomicity before speed

The comparison arm is intentionally the strongest possible classical baseline. It receives the exact
parsed Fjord policy, has no model latency, activates the visible Unrig toggle, and reads all 14,000
real table rows in one snapshot. Measurement showed that it completes 340 actual one-row submits
against an **isolated legacy workbench** quickly. This is not a speed claim, and it is not a claim that
the DOM path cannot finish.

The measured advantage is **atomicity** and **co-presence**: the strongest DOM arm still creates 340
undo entries and moves focus through 340 editors, while WebMCP stages one attributable transaction,
refuses release, and waits for one human Apply that creates one undo entry. The disclosed typing probe
records live lost keystrokes rather than asserting a fixed value. Attribution and the refusal boundary
follow those two headline facts; reach, discovery turns, and elapsed time remain context only.
In the measured comparison, 340 row operations create **340 undo entries versus one**.

The WebMCP arm discovers the same four tools from the browser-owned `document.modelContext`, stages
the same 340, inspects 20, and waits at `READY FOR HUMAN RELEASE`. Only the existing trusted Apply
button can create the one canonical undo entry. The comparison is programmatic browser-API evidence,
**not native model selection**; native-agent selection remains **UNPROVEN**. No result receipt contains
the catalogue corpus.

## Tests

```sh
npm test
python3 tests/head_to_head_browser.py
```

The dependency-free Node suite currently contains 68 tests. The head-to-head browser journey
self-hosts on an ephemeral localhost port and uses the pinned compatible Chrome binary. The existing
UI/WebMCP/watch journeys expect the `4173` server from the run instructions to remain open. This
project is static and can be hosted directly from the repository root.

## Public evidence and claim boundary

The corrected public repository and GitHub Pages build are at commit
[`a79c783`](https://github.com/hungson175/catalogue-bulk-editor/commit/a79c78394e1508620fde0ca93e3c6dc2e012e670).
Live URL: https://hungson175.github.io/catalogue-bulk-editor/
Independent fresh-profile Chrome 154 evidence passed exact four-tool discovery plus a randomized
14,000 → 340 → inspect → discard run at the registered public origin, with all ledger rows
`written:0`, unchanged records/state version, and a clean second profile.

That proves browser-owned registration and programmatic execution. It does **not** prove that a native
model or agent selected the tools. Permanent boundary: `native agent: UNPROVEN` and
`PROGRAMMATIC_ZERO_WRITE_TOOLS` only.

Narrated video and final submission remain pending separate gates.

See `LICENSE` and `NOTICE.md` for MIT licensing and shared-module provenance.
