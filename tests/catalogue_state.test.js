import test from 'node:test';
import assert from 'node:assert/strict';

import { createCatalogueState } from '../src/catalogue_state.js';
import { generateCatalogue } from '../src/sample_catalogue.js';

const POLICY = Object.freeze({ supplier: 'Fjord', cutoff: '2026-06-01', discountPct: 15 });
const TRUSTED = Object.freeze({ trustedForTest: true });

function clock() {
  let tick = 0;
  return () => `2026-09-01T00:00:${String(tick++).padStart(2, '0')}.000Z`;
}

function makeState() {
  return createCatalogueState({
    records: generateCatalogue(),
    clock: clock(),
    isTrustedGesture: (event) => event?.trustedForTest === true,
  });
}

function tool(state, name) {
  const descriptor = state.getToolRegistry().find((item) => item.name === name);
  assert.ok(descriptor, `missing tool ${name}`);
  return descriptor.handler;
}

function businessRows(state) {
  return state.getViewport({ unrigged: true }).rows.map(({ _version, ...row }) => row);
}

test('state validates required options and clones caller-owned records', () => {
  assert.throws(() => createCatalogueState({}), /records|clock/i);

  const records = generateCatalogue();
  const state = createCatalogueState({ records, clock: clock(), isTrustedGesture: () => true });
  const originalPrice = state.getViewport().rows[0].priceCents;
  records[0].priceCents = 1;
  assert.equal(state.getViewport().rows[0].priceCents, originalPrice);
});

test('viewport is capped at 30 or explicitly unrigged to all 14,000 without state mutation', () => {
  const state = makeState();
  const before = state.getSnapshot();
  const beforeLedger = state.getLedger();
  const rigged = state.getViewport({ offset: 10, limit: 999 });
  const unrigged = state.getViewport({ offset: 100, limit: 1, unrigged: true });

  assert.equal(rigged.returnedCount, 30);
  assert.equal(rigged.rows.length, 30);
  assert.equal(unrigged.returnedCount, 14_000);
  assert.equal(unrigged.rows.length, 14_000);
  assert.equal(unrigged.total, 14_000);
  assert.ok(Object.isFrozen(rigged));
  assert.ok(Object.isFrozen(rigged.rows));
  assert.ok(Object.isFrozen(rigged.rows[0]));
  assert.throws(() => { rigged.rows[0].priceCents = 1; }, TypeError);
  assert.deepEqual(state.getSnapshot(), before);
  assert.deepEqual(state.getLedger(), beforeLedger);
});

test('canonical preview stages 340 deterministic non-noop diffs and writes zero records', () => {
  const state = makeState();
  const before = businessRows(state);
  const result = tool(state, 'preview_supplier_policy')(POLICY);
  const after = businessRows(state);
  const inspect = tool(state, 'inspect_staged_changes');
  const pages = [0, 100, 200, 300].map((offset) => inspect({ offset, limit: 100 }));
  const preview = {
    total: pages[0].total,
    changes: pages.flatMap((page) => page.changes),
  };

  assert.deepEqual(result, {
    ok: true,
    matched: 340,
    staged: 340,
    written: 0,
    outcome: 'staged',
    stageId: 'stage-0001',
  });
  assert.deepEqual(after, before);
  assert.equal(preview.total, 340);
  assert.equal(preview.changes.length, 340);
  assert.deepEqual(preview.changes.map((change) => change.id), [...preview.changes.map((change) => change.id)].sort());
  assert.equal(preview.changes.filter((change) => change.patch.status === 'discontinued').length, 170);
  assert.equal(preview.changes.filter((change) => 'priceCents' in change.patch).length, 170);
  const nonFjordIds = new Set(generateCatalogue().filter((row) => row.supplier !== 'Fjord').map((row) => row.id));
  assert.ok(preview.changes.every((change) => !nonFjordIds.has(change.id)));
  assert.ok(Object.isFrozen(preview.changes[0]));
  assert.equal(state.getSnapshot().stagedCount, 340);
});

test('every staged diff carries an immutable truthful before value for exactly its patch keys', () => {
  const state = makeState();
  const originals = new Map(state.getViewport({ unrigged: true }).rows.map((row) => [row.id, row]));
  tool(state, 'preview_supplier_policy')(POLICY);
  const inspect = tool(state, 'inspect_staged_changes');
  const changes = [0, 100, 200, 300].flatMap((offset) => inspect({ offset, limit: 100 }).changes);

  assert.equal(changes.length, 340);
  for (const change of changes) {
    const original = originals.get(change.id);
    assert.deepEqual(Object.keys(change.before), Object.keys(change.patch));
    assert.ok(Object.isFrozen(change.before));
    assert.ok(Object.isFrozen(change.patch));
    assert.ok(Object.isFrozen(change));
    for (const [key, after] of Object.entries(change.patch)) {
      assert.equal(change.before[key], original[key]);
      assert.notEqual(after, change.before[key]);
    }
  }

  const first = changes[0];
  assert.throws(() => { first.before[Object.keys(first.before)[0]] = 'tampered'; }, TypeError);
  const reread = inspect({ offset: 0, limit: 1 }).changes[0];
  assert.deepEqual(reread.before, first.before);
  assert.equal(state.getViewport({ unrigged: true }).rows.find((row) => row.id === first.id)._version, 0);
});

test('second preview refuses rather than replacing an active stage', () => {
  const state = makeState();
  const preview = tool(state, 'preview_supplier_policy');
  const first = preview(POLICY);
  const second = preview({ ...POLICY, discountPct: 20 });

  assert.equal(first.stageId, 'stage-0001');
  assert.deepEqual(second, {
    ok: false,
    matched: 0,
    staged: 0,
    written: 0,
    outcome: 'refused_stage_active',
    stageId: 'stage-0001',
  });
  assert.equal(state.getSnapshot().stageId, 'stage-0001');
});

test('untrusted apply visibly refuses, writes zero, and retains stage', () => {
  const state = makeState();
  tool(state, 'preview_supplier_policy')(POLICY);
  const before = businessRows(state);
  const result = state.human.apply(new Event('click'));

  assert.deepEqual(result, { ok: false, reason: 'gesture_required', written: 0 });
  assert.deepEqual(businessRows(state), before);
  assert.equal(state.getSnapshot().stagedCount, 340);
  assert.equal(state.getSnapshot().refusalCount, 1);
  assert.equal(state.getLedger().at(-1).outcome, 'refused_gesture');
});

test('every human mutation requires the same trusted-gesture boundary', () => {
  const state = makeState();
  tool(state, 'preview_supplier_policy')(POLICY);
  const firstId = state.getViewport().rows[0].id;
  const before = businessRows(state);

  assert.deepEqual(state.human.apply(null), { ok: false, reason: 'gesture_required', written: 0 });
  assert.deepEqual(state.human.decline(null), { ok: false, reason: 'gesture_required', written: 0 });
  assert.deepEqual(state.human.undo(null), { ok: false, reason: 'gesture_required', written: 0 });
  assert.deepEqual(
    state.human.editRecord(null, { id: firstId, patch: { name: 'blocked edit' } }),
    { ok: false, reason: 'gesture_required', written: 0 },
  );
  assert.deepEqual(businessRows(state), before);
  assert.equal(state.getSnapshot().stageId, 'stage-0001');
  assert.equal(state.getSnapshot().undoDepth, 0);
  assert.equal(state.getSnapshot().refusalCount, 4);
});

test('trusted apply writes exactly 340 in one transaction and one undo restores business fields', () => {
  const state = makeState();
  const original = businessRows(state);
  tool(state, 'preview_supplier_policy')(POLICY);
  const committed = state.human.apply(TRUSTED);

  assert.deepEqual(committed, { ok: true, written: 340, txId: 'stage-0001', stateVersion: 1 });
  assert.equal(state.getSnapshot().stateVersion, 1);
  assert.equal(state.getSnapshot().undoDepth, 1);
  assert.equal(state.getSnapshot().stageId, null);
  const fjord = state.getViewport({ unrigged: true }).rows.filter((row) => row.supplier === 'Fjord');
  assert.equal(fjord.filter((row) => row.status === 'discontinued').length, 170);
  assert.equal(fjord.filter((row) => row.lastSoldAt >= POLICY.cutoff && row.status === 'active').length, 170);
  assert.ok(fjord.every((row) => row._version === 1));
  assert.equal(state.getLedger().at(-1).written, 340);

  const undone = state.human.undo(TRUSTED);
  assert.deepEqual(undone, { ok: true, written: 340, stateVersion: 2 });
  assert.deepEqual(businessRows(state), original);
  assert.equal(state.getSnapshot().undoDepth, 0);
  assert.ok(state.getViewport({ unrigged: true }).rows.filter((row) => row.supplier === 'Fjord').every((row) => row._version === 2));
  assert.deepEqual(state.human.undo(TRUSTED), { ok: false, reason: 'no_transaction', written: 0 });
});

test('a trusted single-row edit creates a real version conflict and bulk apply writes no subset', () => {
  const state = makeState();
  tool(state, 'preview_supplier_policy')(POLICY);
  const firstChange = tool(state, 'inspect_staged_changes')({ offset: 0, limit: 1 }).changes[0];
  const beforeEdit = state.getViewport({ unrigged: true }).rows.find((row) => row.id === firstChange.id);
  const edited = state.human.editRecord(TRUSTED, { id: firstChange.id, patch: { name: `${beforeEdit.name} reviewed` } });
  const beforeApply = businessRows(state);
  const result = state.human.apply(TRUSTED);

  assert.deepEqual(edited, { ok: true, written: 1, stateVersion: 1 });
  assert.deepEqual(result, { ok: false, reason: 'conflict', written: 0, conflicts: [firstChange.id] });
  assert.deepEqual(businessRows(state), beforeApply);
  assert.equal(state.getSnapshot().stagedCount, 340);
  assert.equal(state.getSnapshot().refusalCount, 1);
  assert.equal(state.getLedger().at(-1).outcome, 'refused_conflict');
});

test('tool discard and human decline both clear whole stage with zero writes and distinct actors', () => {
  const state = makeState();
  const before = businessRows(state);
  tool(state, 'preview_supplier_policy')(POLICY);
  const toolDiscard = tool(state, 'discard_staged_changes')({ reason: 'agent cleanup' });
  assert.equal(toolDiscard.written, 0);
  assert.equal(state.getLedger().at(-1).actor, 'tool');
  assert.equal(state.getSnapshot().stageId, null);

  tool(state, 'preview_supplier_policy')(POLICY);
  const humanDecline = state.human.decline(TRUSTED);
  assert.deepEqual(humanDecline, { ok: true, written: 0, outcome: 'declined' });
  assert.equal(state.getLedger().at(-1).actor, 'human');
  assert.equal(state.getSnapshot().stageId, null);
  assert.deepEqual(businessRows(state), before);
});

test('ledger and projections are frozen copies and counters derive from entries', () => {
  const state = makeState();
  tool(state, 'catalogue_summary')({});
  tool(state, 'preview_supplier_policy')(POLICY);
  state.human.apply(null);
  const ledger = state.getLedger();
  const snapshot = state.getSnapshot();

  assert.equal(ledger.length, 3);
  assert.equal(snapshot.refusalCount, 1);
  assert.ok(Object.isFrozen(ledger));
  assert.ok(Object.isFrozen(ledger[0]));
  assert.ok(Object.isFrozen(snapshot));
  assert.throws(() => { ledger[0].written = 999; }, TypeError);
  assert.throws(() => { snapshot.refusalCount = 999; }, TypeError);
  assert.equal(state.getLedger()[0].written, 0);
  assert.equal(state.getSnapshot().refusalCount, 1);
});
