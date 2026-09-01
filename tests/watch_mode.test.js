import assert from 'node:assert/strict';
import test from 'node:test';

import { createCatalogueState } from '../src/catalogue_state.js';
import { generateCatalogue } from '../src/sample_catalogue.js';
import { createWatchSession } from '../src/watch/watch_session.mjs';
import {
  CATALOGUE_WATCH_SCENARIO,
  createCatalogueWatchAdapter,
} from '../src/watch_mode.js';

const EXPECTED_IDS = [
  'reset-preview',
  'read-summary',
  'stage-fjord-policy',
  'inspect-first-page',
  'discard-preview',
];
const EXPECTED_TOOLS = [
  'discard_staged_changes',
  'catalogue_summary',
  'preview_supplier_policy',
  'inspect_staged_changes',
  'discard_staged_changes',
];

function freezeDemo(runTool, getWatchMetrics, extra = {}) {
  Object.freeze(runTool);
  Object.freeze(getWatchMetrics);
  return Object.freeze({ runTool, getWatchMetrics, ...extra });
}

function makeState() {
  let tick = 0;
  return createCatalogueState({
    records: generateCatalogue(),
    clock: () => `2026-09-01T03:30:${String(tick++).padStart(2, '0')}.000Z`,
    isTrustedGesture: () => false,
  });
}

function realDemo(state, calls) {
  const registry = state.getCommandRegistry();
  const byName = Object.fromEntries(registry.map((descriptor) => [descriptor.name, descriptor]));
  let written = 0;
  return freezeDemo(
    ({ name, input }) => {
      calls.push({ name, input });
      if (!Object.hasOwn(byName, name)) throw new Error('unknown_tool');
      const result = byName[name].handler(input);
      if (name === 'preview_supplier_policy' && result.ok && result.staged > 0) {
        for (const offset of [0, 100, 200, 300]) {
          byName.inspect_staged_changes.handler({ offset, limit: 100 });
        }
      }
      written = result.written ?? 0;
      return Object.freeze({
        result,
        snapshot: state.getSnapshot(),
        ledgerTail: state.getLedger().at(-1) ?? Object.freeze({}),
      });
    },
    () => {
      const snapshot = state.getSnapshot();
      return Object.freeze({
        dom: 30,
        staged: snapshot.stagedCount,
        written,
        refusal: snapshot.refusalCount,
        undo: snapshot.undoDepth,
      });
    },
  );
}

test('scenario is the frozen minimal five-step zero-write composition', () => {
  assert.ok(Object.isFrozen(CATALOGUE_WATCH_SCENARIO));
  assert.deepEqual(CATALOGUE_WATCH_SCENARIO.steps.map(({ id }) => id), EXPECTED_IDS);
  assert.deepEqual(CATALOGUE_WATCH_SCENARIO.steps.map(({ tool }) => tool), EXPECTED_TOOLS);
  assert.deepEqual(CATALOGUE_WATCH_SCENARIO.steps[2].input, {
    supplier: 'Fjord', cutoff: '2026-06-01', discountPct: 15,
  });
  assert.deepEqual(CATALOGUE_WATCH_SCENARIO.steps[3].input, { offset: 0, limit: 20 });
  assert.equal(new Set(EXPECTED_IDS).size, 5);
  assert.ok(CATALOGUE_WATCH_SCENARIO.steps.every(({ tool }) => !/apply|commit|approve|release|undo|human|edit/i.test(tool)));
});

test('adapter is an exact frozen two-function capability and rejects broader demos', () => {
  const demo = freezeDemo(
    ({ name }) => Object.freeze({ result: Object.freeze({ ok: true, name }) }),
    () => Object.freeze({ dom: 30, staged: 0, written: 0, refusal: 0, undo: 0 }),
  );
  const adapter = createCatalogueWatchAdapter(demo);
  assert.deepEqual(Object.keys(adapter), ['executeTool', 'getMetrics']);
  assert.ok(Object.isFrozen(adapter));
  assert.equal('demo' in adapter, false);
  assert.throws(() => createCatalogueWatchAdapter({ ...demo }), /frozen/i);
  assert.throws(
    () => createCatalogueWatchAdapter(freezeDemo(demo.runTool, demo.getWatchMetrics, { apply: () => {} })),
    /exact|keys|surface/i,
  );
});

test('adapter copies and freezes input/output while calling only the allowed owner callback once', async () => {
  let calls = 0;
  let captured;
  const demo = freezeDemo(
    ({ name, input }) => {
      calls += 1;
      captured = input;
      input.offset = 99;
      return { result: { ok: true, name }, nested: [{ offset: input.offset }] };
    },
    () => ({ dom: 30, staged: 0, written: 0, refusal: 0, undo: 0 }),
  );
  const adapter = createCatalogueWatchAdapter(demo);
  const source = { offset: 0, limit: 20 };
  const output = await adapter.executeTool('inspect_staged_changes', source, { signal: new AbortController().signal });
  assert.equal(calls, 1);
  assert.deepEqual(source, { offset: 0, limit: 20 });
  assert.notEqual(captured, source);
  assert.ok(Object.isFrozen(output));
  assert.ok(Object.isFrozen(output.nested));
  assert.ok(Object.isFrozen(output.nested[0]));
  assert.throws(() => { output.nested[0].offset = 0; }, TypeError);
  assert.throws(() => adapter.executeTool('apply_changes', {}, {}), /unknown_tool/);
});

test('adapter aborts before owner call and bounds owner errors', async () => {
  let calls = 0;
  const demo = freezeDemo(
    () => { calls += 1; throw new Error('secret stack and arbitrary owner detail'); },
    () => ({ dom: 30, staged: 0, written: 0, refusal: 0, undo: 0 }),
  );
  const adapter = createCatalogueWatchAdapter(demo);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    Promise.resolve().then(() => adapter.executeTool('catalogue_summary', {}, { signal: controller.signal })),
    (error) => error.name === 'AbortError',
  );
  assert.equal(calls, 0);
  await assert.rejects(
    Promise.resolve().then(() => adapter.executeTool('catalogue_summary', {}, {})),
    (error) => error.message === 'watch_tool_failed' && !error.message.includes('secret'),
  );
});

test('metrics are exact finite non-negative frozen values', () => {
  const valid = createCatalogueWatchAdapter(freezeDemo(
    () => ({ result: { ok: true } }),
    () => ({ dom: 30, staged: 0, written: 0, refusal: 0, undo: 0 }),
  )).getMetrics();
  assert.deepEqual(valid, { dom: 30, staged: 0, written: 0, refusal: 0, undo: 0 });
  assert.ok(Object.isFrozen(valid));
  for (const metrics of [
    { dom: 30, staged: 0, written: 0, refusal: 0 },
    { dom: 30, staged: 0, written: 0, refusal: 0, undo: 0, extra: 1 },
    { dom: 30, staged: -1, written: 0, refusal: 0, undo: 0 },
    { dom: Number.NaN, staged: 0, written: 0, refusal: 0, undo: 0 },
  ]) {
    const adapter = createCatalogueWatchAdapter(freezeDemo(() => ({}), () => metrics));
    assert.throws(() => adapter.getMetrics(), /metrics/i);
  }
});

test('real five-call session composes to nine zero-written ledger rows and cleans stage', async () => {
  const state = makeState();
  const before = JSON.stringify(state.getViewport({ unrigged: true }).rows);
  const calls = [];
  const session = createWatchSession({
    scenario: CATALOGUE_WATCH_SCENARIO,
    adapter: createCatalogueWatchAdapter(realDemo(state, calls)),
    now: (() => { let now = 0; return () => (now += 10); })(),
  });
  const transitions = [];
  session.subscribe((event) => {
    if (event.type === 'step-pass') transitions.push(event.metricsAfter.staged);
  });
  const receipt = await session.run();
  const ledger = state.getLedger();
  assert.equal(receipt.status, 'PASS');
  assert.equal(calls.length, 5, 'five adapter calls');
  assert.deepEqual(calls.map(({ name }) => name), EXPECTED_TOOLS);
  assert.deepEqual(transitions, [0, 0, 340, 340, 0]);
  assert.equal(receipt.steps[2].actualResult.result.staged, 340);
  assert.equal(receipt.steps[3].actualResult.result.limit, 20);
  assert.equal(receipt.steps[4].actualResult.result.outcome, 'discarded');
  assert.equal(ledger.length, 9, 'reset+summary+preview(1+4)+inspect+discard');
  assert.equal(ledger.filter(({ written }) => written === 0).length, 9);
  assert.equal(ledger.filter(({ op }) => op === 'inspect_staged_changes').length, 5);
  assert.equal(state.getSnapshot().stagedCount, 0);
  assert.equal(JSON.stringify(state.getViewport({ unrigged: true }).rows), before);
});
