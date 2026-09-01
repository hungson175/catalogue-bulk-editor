import assert from 'node:assert/strict';
import test from 'node:test';

const MODULE_URL = new URL('../src/watch/watch_session.mjs', import.meta.url);

async function loadModule() {
  try {
    return await import(MODULE_URL.href);
  } catch (error) {
    assert.fail(`required watch-session module is missing or invalid: ${error.message}`);
  }
}

function validScenario() {
  return {
    schemaVersion: 1,
    entryId: 'entry-a',
    title: 'Catalogue preview',
    metricLabels: {
      dom: 'DOM rows',
      staged: 'Staged',
      written: 'Written',
    },
    steps: [
      {
        id: 'summary',
        label: 'Read catalogue summary',
        tool: 'catalogue_summary',
        input: {},
        expected: {
          result: { ok: true },
          metricsAfter: { staged: 0, written: 0 },
        },
      },
      {
        id: 'preview',
        label: 'Preview Fjord policy',
        tool: 'preview_supplier_policy',
        input: { supplier: 'Fjord', cutoff: '2026-06-01', discountPct: 15 },
        expected: {
          result: { ok: true, staged: 340 },
          metricsAfter: { staged: 340, written: 0 },
        },
      },
      {
        id: 'inspect',
        label: 'Inspect staged changes',
        tool: 'inspect_staged_changes',
        input: { offset: 0, limit: 20 },
        expected: {
          result: { ok: true, total: 340 },
          metricsAfter: { staged: 340, written: 0 },
        },
      },
    ],
  };
}

test('scenario validation freezes a strict zero-write manifest', async () => {
  const { validateScenario } = await loadModule();
  const scenario = validateScenario(validScenario());
  assert.equal(scenario.steps.length, 3);
  assert.ok(Object.isFrozen(scenario));
  assert.ok(Object.isFrozen(scenario.steps));
  assert.ok(Object.isFrozen(scenario.steps[1].input));
});

test('scenario validation rejects canned outputs, unknown keys, and prototype keys', async () => {
  const { validateScenario } = await loadModule();
  for (const mutation of [
    (scenario) => { scenario.steps[0].outputJson = '{}'; },
    (scenario) => { scenario.steps[0].result = { canned: true }; },
    (scenario) => { scenario.steps[0].unknown = true; },
    (scenario) => { scenario.unknown = true; },
    (scenario) => { scenario.steps[0].input = JSON.parse('{"__proto__":{"polluted":true}}'); },
  ]) {
    const scenario = validScenario();
    mutation(scenario);
    assert.throws(() => validateScenario(scenario));
  }
});

test('scenario validation rejects human-write tool names and duplicate step ids', async () => {
  const { validateScenario } = await loadModule();
  for (const tool of ['apply_changes', 'commit', 'approve_release', 'human_undo']) {
    const scenario = validScenario();
    scenario.steps[0].tool = tool;
    assert.throws(() => validateScenario(scenario), /human-write/i);
  }
  const duplicate = validScenario();
  duplicate.steps[1].id = duplicate.steps[0].id;
  assert.throws(() => validateScenario(duplicate), /unique/i);
});

test('scenario validation rejects metric keys that are unsafe in DOM selectors', async () => {
  const { validateScenario } = await loadModule();
  for (const unsafeKey of ['selected"]', 'UPPER', 'two words', '-leading', 'a'.repeat(33)]) {
    const scenario = validScenario();
    scenario.metricLabels = { [unsafeKey]: 'Unsafe metric' };
    assert.throws(() => validateScenario(scenario), /metric key/i);
  }
});

test('watch session executes each real callback once, preserves stateful order, and emits actual output', async () => {
  const { createWatchSession } = await loadModule();
  const scenario = validScenario();
  let staged = 0;
  let now = 0;
  const calls = [];
  const actualOutputs = [];
  const adapter = {
    async executeTool(name, input, { signal }) {
      assert.equal(signal.aborted, false);
      calls.push({ name, input });
      if (name === 'catalogue_summary') return { ok: true, total: 14000 };
      if (name === 'preview_supplier_policy') {
        staged = 340;
        return { ok: true, staged, proof: 'live-preview-only' };
      }
      return { ok: true, total: staged, firstId: 'fjord-0001' };
    },
    getMetrics() {
      return { dom: 30, staged, written: 0 };
    },
  };
  const session = createWatchSession({ scenario, adapter, now: () => (now += 10) });
  session.subscribe((event) => {
    if (event.type === 'step-pass') actualOutputs.push(event.result);
  });
  const receipt = await session.run();
  assert.deepEqual(calls.map(({ name }) => name), scenario.steps.map(({ tool }) => tool));
  assert.equal(calls.length, 3);
  assert.equal(actualOutputs[1].proof, 'live-preview-only');
  assert.equal(receipt.status, 'PASS');
  assert.equal(receipt.steps[2].actualResult.firstId, 'fjord-0001');
  assert.equal(receipt.steps[2].metricsAfter.staged, 340);
  assert.equal(receipt.nativeAgentInvocation, 'UNPROVEN');
});

test('expected values only assert; a mismatch cannot substitute canned output', async () => {
  const { createWatchSession, WatchSessionError } = await loadModule();
  const scenario = validScenario();
  const adapter = {
    async executeTool() { return { ok: false, actual: 'from-engine' }; },
    getMetrics() { return { dom: 30, staged: 0, written: 0 }; },
  };
  const session = createWatchSession({ scenario, adapter, now: () => 1 });
  await assert.rejects(
    session.run(),
    (error) => error instanceof WatchSessionError
      && error.receipt.status === 'FAIL'
      && error.receipt.steps[0].actualResult.actual === 'from-engine'
  );
});

test('stop aborts the active call and prevents every later step', async () => {
  const { createWatchSession, WatchSessionError } = await loadModule();
  const scenario = validScenario();
  const calls = [];
  let rejectActive;
  const adapter = {
    executeTool(name, _input, { signal }) {
      calls.push(name);
      return new Promise((_resolve, reject) => {
        rejectActive = reject;
        signal.addEventListener('abort', () => reject(new DOMException('Stopped', 'AbortError')));
      });
    },
    getMetrics() { return { dom: 30, staged: 0, written: 0 }; },
  };
  const session = createWatchSession({ scenario, adapter, now: () => 1 });
  const running = session.run();
  await Promise.resolve();
  session.stop();
  await assert.rejects(
    running,
    (error) => error instanceof WatchSessionError && error.receipt.status === 'STOPPED'
  );
  assert.equal(typeof rejectActive, 'function');
  assert.deepEqual(calls, ['catalogue_summary']);
});

test('one session cannot run concurrently and receipts reject sensitive keys', async () => {
  const { createWatchSession, assertReceiptSafe } = await loadModule();
  let release;
  const adapter = {
    executeTool() { return new Promise((resolve) => { release = resolve; }); },
    getMetrics() { return { dom: 30, staged: 0, written: 0 }; },
  };
  const session = createWatchSession({ scenario: validScenario(), adapter, now: () => 1 });
  const first = session.run();
  await Promise.resolve();
  await assert.rejects(session.run(), /already running/i);
  release({ ok: true });
  session.stop();
  await assert.rejects(first);
  for (const unsafe of [
    { token: 'x' }, { cookie: 'x' }, { localStorage: {} },
    { authorization: 'x' }, { profilePath: '/tmp/x' },
  ]) {
    assert.throws(() => assertReceiptSafe(unsafe));
  }
});
