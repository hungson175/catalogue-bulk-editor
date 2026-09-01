import test from 'node:test';
import assert from 'node:assert/strict';

import { generateCatalogue } from '../src/sample_catalogue.js';

const CUTOFF = '2026-06-01';

test('fixture is deterministic, unique, and exactly 14,000 rows', () => {
  const first = generateCatalogue();
  const second = generateCatalogue();

  assert.equal(first.length, 14_000);
  assert.deepEqual(first, second);
  assert.equal(new Set(first.map((row) => row.id)).size, 14_000);
  assert.equal(new Set(first.map((row) => row.sku)).size, 14_000);
  assert.ok(first.every((row) => Number.isInteger(row._version) && row._version === 0));
  assert.ok(first.every((row) => Number.isInteger(row.priceCents)));
  assert.ok(first.every((row) => row.priceCents >= 199 && row.priceCents <= 99_999));
  assert.ok(first.every((row) => /^\d{4}-\d{2}-\d{2}$/.test(row.lastSoldAt)));
});

test('fixture has an honest 170/170 Fjord split and every canonical change is non-noop', () => {
  const rows = generateCatalogue();
  const fjord = rows.filter((row) => row.supplier === 'Fjord');
  const unsold = fjord.filter((row) => row.lastSoldAt < CUTOFF);
  const sold = fjord.filter((row) => row.lastSoldAt >= CUTOFF);

  assert.equal(fjord.length, 340);
  assert.equal(unsold.length, 170);
  assert.equal(sold.length, 170);
  assert.ok(fjord.every((row) => row.status === 'active'));
  assert.ok(unsold.every((row) => row.lastSoldAt >= '2025-01-01' && row.lastSoldAt <= '2026-05-31'));
  assert.ok(sold.every((row) => row.lastSoldAt >= '2026-06-01' && row.lastSoldAt <= '2026-08-15'));
  assert.ok(sold.every((row) => Math.round(row.priceCents * 85 / 100) !== row.priceCents));

  const otherSuppliers = new Set(rows.filter((row) => row.supplier !== 'Fjord').map((row) => row.supplier));
  assert.ok(otherSuppliers.size >= 5);
  assert.ok([...otherSuppliers].every((supplier) => supplier.toLowerCase() !== 'fjord'));
});

test('fixture generator honors a stable alternate seed and total', () => {
  const shortA = generateCatalogue({ seed: 123, total: 500 });
  const shortB = generateCatalogue({ seed: 123, total: 500 });
  const shortC = generateCatalogue({ seed: 124, total: 500 });

  assert.equal(shortA.length, 500);
  assert.deepEqual(shortA, shortB);
  assert.notDeepEqual(shortA, shortC);
});
