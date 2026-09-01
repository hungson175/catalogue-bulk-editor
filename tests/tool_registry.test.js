import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { createCatalogueState } from '../src/catalogue_state.js';
import { generateCatalogue } from '../src/sample_catalogue.js';

function makeState() {
  let tick = 0;
  return createCatalogueState({
    records: generateCatalogue(),
    clock: () => `2026-09-01T01:00:${String(tick++).padStart(2, '0')}.000Z`,
    isTrustedGesture: (event) => event?.trustedForTest === true,
  });
}

test('one frozen four-tool registry is shared by Cmd-K and later WebMCP', () => {
  const state = makeState();
  const tools = state.getToolRegistry();

  assert.strictEqual(tools, state.getCommandRegistry());
  assert.ok(Object.isFrozen(tools));
  assert.deepEqual(tools.map((tool) => tool.name), [
    'catalogue_summary',
    'preview_supplier_policy',
    'inspect_staged_changes',
    'discard_staged_changes',
  ]);
  assert.deepEqual(
    tools.map((tool) => tool.annotations),
    [
      { readOnlyHint: true },
      { readOnlyHint: false },
      { readOnlyHint: true },
      { readOnlyHint: false },
    ],
  );
  for (const descriptor of tools) {
    assert.ok(Object.isFrozen(descriptor));
    assert.ok(Object.isFrozen(descriptor.handler));
    assert.doesNotMatch(descriptor.name, /apply|commit|approve|release/i);
    assert.doesNotMatch(descriptor.handler.name, /apply|commit|approve|release/i);
    assert.equal(descriptor.inputSchema.type, 'object');
    assert.ok(Object.isFrozen(descriptor.annotations));
  }
});

test('invoking every registry handler can stage and discard but never writes catalogue records', () => {
  const state = makeState();
  const before = state.getViewport({ unrigged: true }).rows;
  const tools = Object.fromEntries(state.getToolRegistry().map((tool) => [tool.name, tool.handler]));

  tools.catalogue_summary({});
  tools.preview_supplier_policy({ supplier: 'Fjord', cutoff: '2026-06-01', discountPct: 15 });
  tools.inspect_staged_changes({ offset: 0, limit: 10 });
  tools.discard_staged_changes({ reason: 'parity proof' });

  assert.deepEqual(state.getViewport({ unrigged: true }).rows, before);
  assert.equal(state.getSnapshot().stageId, null);
  assert.deepEqual(state.getLedger().map((entry) => entry.written), [0, 0, 0, 0]);
});

test('preview validates strict policy input and inspect pagination is bounded and frozen', () => {
  const state = makeState();
  const tools = Object.fromEntries(state.getToolRegistry().map((tool) => [tool.name, tool.handler]));

  assert.deepEqual(tools.preview_supplier_policy({ supplier: '', cutoff: 'June', discountPct: 15 }), {
    ok: false,
    matched: 0,
    staged: 0,
    written: 0,
    outcome: 'invalid_input',
    stageId: null,
  });
  tools.preview_supplier_policy({ supplier: 'Fjord', cutoff: '2026-06-01', discountPct: 15 });
  const page = tools.inspect_staged_changes({ offset: 10, limit: 10_000 });
  assert.equal(page.changes.length, 100);
  assert.ok(Object.isFrozen(page));
  assert.ok(Object.isFrozen(page.changes));
  assert.ok(Object.isFrozen(page.changes[0]));
});

test('product source has no network, credential, browser, DOM, persistence, or SDK seam', async () => {
  const paths = [
    new URL('../src/sample_catalogue.js', import.meta.url),
    new URL('../src/catalogue_state.js', import.meta.url),
    new URL('../src/tool_registry.js', import.meta.url),
  ];
  const source = (await Promise.all(paths.map((path) => readFile(path, 'utf8')))).join('\n');

  assert.doesNotMatch(source, /\bfetch\b|XMLHttpRequest|WebSocket|localStorage|indexedDB|navigator\.|process\.env|import\s+.*sdk/i);
});
