import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  createClassicalDomArm,
  parseCatalogueRows,
  selectPolicyTargets,
} from '../src/classical_dom_arm.js';

function row(id, supplier, lastSoldAt, price, status = 'active') {
  const values = [id, `SKU-${id}`, `${supplier} ${id}`, supplier, lastSoldAt, price, status];
  return {
    dataset: { id },
    cells: values.map((textContent) => ({ textContent })),
  };
}

test('parses exactly seven live DOM cells and derives cents without a catalogue import', () => {
  const parsed = parseCatalogueRows([
    row('record-00001', 'Fjord', '2026-05-31', '$12.34'),
    row('record-00002', 'Aster', '2026-06-01', '$1,234.56'),
  ]);
  assert.deepEqual(parsed, [
    {
      id: 'record-00001', sku: 'SKU-record-00001', name: 'Fjord record-00001', supplier: 'Fjord',
      lastSoldAt: '2026-05-31', priceCents: 1234, status: 'active',
    },
    {
      id: 'record-00002', sku: 'SKU-record-00002', name: 'Aster record-00002', supplier: 'Aster',
      lastSoldAt: '2026-06-01', priceCents: 123456, status: 'active',
    },
  ]);
  assert.ok(Object.isFrozen(parsed));
  assert.ok(Object.isFrozen(parsed[0]));
});

test('rejects malformed rows and duplicate ids before any edit', () => {
  assert.throws(() => parseCatalogueRows([{ dataset: { id: 'x' }, cells: [] }]), /seven_cells/);
  assert.throws(() => parseCatalogueRows([
    row('record-00001', 'Fjord', '2026-05-31', '$12.34'),
    row('record-00001', 'Fjord', '2026-06-01', '$10.00'),
  ]), /duplicate_id/);
  assert.throws(() => parseCatalogueRows([
    row('record-00003', 'Fjord', '31 May 2026', '$12.34'),
  ]), /invalid_date/);
});

test('tuned exact policy derives status and rounded price patches from parsed DOM text', () => {
  const parsed = parseCatalogueRows([
    row('record-00003', 'Fjord', '2026-06-01', '$10.01'),
    row('record-00001', 'Fjord', '2026-05-31', '$12.34'),
    row('record-00002', 'Aster', '2026-01-01', '$9.99'),
  ]);
  const targets = selectPolicyTargets(parsed, {
    supplier: 'Fjord', cutoff: '2026-06-01', discountPct: 15,
  });
  assert.deepEqual(targets, [
    { id: 'record-00001', patch: { status: 'discontinued' } },
    { id: 'record-00003', patch: { priceCents: 851 } },
  ]);
  assert.ok(Object.isFrozen(targets));
  assert.ok(Object.isFrozen(targets[0].patch));
});

test('classical arm rejects a declaration-only or non-DOM implementation', () => {
  assert.equal(typeof createClassicalDomArm, 'function');
  assert.throws(() => createClassicalDomArm({}), /document/i);
});

test('classical source is mechanically isolated from private state, registry, and WebMCP seams', () => {
  const source = readFileSync(new URL('../src/classical_dom_arm.js', import.meta.url), 'utf8');
  for (const forbidden of [
    'catalogue_state', 'sample_catalogue', 'tool_registry', 'webmcp_adapter',
    'window.catalogueDemo', 'document.modelContext',
  ]) {
    assert.equal(source.includes(forbidden), false, forbidden);
  }
  assert.match(source, /querySelectorAll/);
  assert.match(source, /performance\.now|now\s*[:=]/);
  assert.doesNotMatch(source, /reachableRows\s*:\s*14_?000/);
  assert.doesNotMatch(source, /undoDepth\s*:\s*340/);
});

test('classical source fail-closes count mismatch, abort, concurrent start, and derives every receipt counter', () => {
  const source = readFileSync(new URL('../src/classical_dom_arm.js', import.meta.url), 'utf8');
  assert.match(source, /initialRows[^\n]+querySelectorAll|querySelectorAll[^\n]+initialRows/s);
  assert.match(source, /reachableRows[^\n]+querySelectorAll|querySelectorAll[^\n]+reachableRows/s);
  assert.match(source, /targets\.length\s*!==\s*EXPECTED_MATCHED/);
  assert.match(source, /statusEdits\.length/);
  assert.match(source, /priceEdits\.length/);
  assert.match(source, /undoStack\.length/);
  assert.match(source, /signal\?\.aborted|signal\.aborted/);
  assert.match(source, /ABORTED/);
  assert.match(source, /run_unavailable/);
  assert.match(source, /Object\.freeze|deepFreeze/);
});
