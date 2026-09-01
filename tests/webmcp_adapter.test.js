import test from 'node:test';
import assert from 'node:assert/strict';

import { createCatalogueState } from '../src/catalogue_state.js';
import { generateCatalogue } from '../src/sample_catalogue.js';
import { registerCatalogueWebMCP } from '../src/webmcp_adapter.js';

function makeState() {
  let tick = 0;
  return createCatalogueState({
    records: generateCatalogue(),
    clock: () => `2026-09-01T03:00:${String(tick++).padStart(2, '0')}.000Z`,
    isTrustedGesture: () => false,
  });
}

function makeHarness({ failAt = 0 } = {}) {
  const calls = [];
  const modelContext = {
    async registerTool(descriptor, options) {
      calls.push({ descriptor, options });
      if (failAt && calls.length === failAt) throw new Error('private provider marker');
    },
  };
  return { documentRef: { modelContext }, calls };
}

function canonicalExecutor(state, observed = []) {
  const byName = Object.fromEntries(
    state.getCommandRegistry().map((descriptor) => [descriptor.name, descriptor]),
  );
  return ({ name, input }) => {
    observed.push({ name, input });
    if (!Object.hasOwn(byName, name)) throw new Error('unknown_tool');
    const result = byName[name].handler(input);
    return Object.freeze({
      result,
      snapshot: state.getSnapshot(),
      ledgerTail: state.getLedger().at(-1),
    });
  };
}

const EXPECTED_NAMES = [
  'catalogue_summary',
  'preview_supplier_policy',
  'inspect_staged_changes',
  'discard_staged_changes',
];

test('registers the one frozen catalogue registry exactly once in order with truthful descriptors', async () => {
  const state = makeState();
  const registry = state.getCommandRegistry();
  const harness = makeHarness();
  const controller = new AbortController();
  const receipt = await registerCatalogueWebMCP({
    documentRef: harness.documentRef,
    registry,
    executeTool: canonicalExecutor(state),
    registrationController: controller,
  });

  assert.deepEqual(receipt, { state: 'registered', registered: EXPECTED_NAMES, errors: [] });
  assert.ok(Object.isFrozen(receipt));
  assert.ok(Object.isFrozen(receipt.registered));
  assert.equal(harness.calls.length, 4);
  assert.deepEqual(harness.calls.map(({ descriptor }) => descriptor.name), EXPECTED_NAMES);
  assert.deepEqual(
    harness.calls.map(({ descriptor }) => descriptor.annotations.readOnlyHint),
    [true, false, true, false],
  );
  for (const { descriptor, options } of harness.calls) {
    assert.deepEqual(Object.keys(descriptor), [
      'name', 'description', 'inputSchema', 'annotations', 'execute',
    ]);
    assert.equal(typeof descriptor.execute, 'function');
    assert.equal(descriptor.handler, undefined);
    assert.deepEqual(Object.keys(options), ['signal']);
    assert.strictEqual(options.signal, controller.signal);
  }
});

test('browser execute delegates once through canonical seam, clones input, and returns actual frozen state', async () => {
  const state = makeState();
  const observed = [];
  const harness = makeHarness();
  await registerCatalogueWebMCP({
    documentRef: harness.documentRef,
    registry: state.getCommandRegistry(),
    executeTool: canonicalExecutor(state, observed),
    registrationController: new AbortController(),
  });
  const preview = harness.calls[1].descriptor;
  const callerInput = { supplier: 'Fjord', cutoff: '2026-06-01', discountPct: 15 };
  const result = await preview.execute(callerInput, { signal: new AbortController().signal });

  assert.deepEqual(callerInput, { supplier: 'Fjord', cutoff: '2026-06-01', discountPct: 15 });
  assert.notStrictEqual(observed[0].input, callerInput);
  assert.deepEqual(observed.map(({ name }) => name), ['preview_supplier_policy']);
  assert.equal(result.result.staged, 340);
  assert.equal(result.result.written, 0);
  assert.equal(result.snapshot.stagedCount, 340);
  assert.equal(result.ledgerTail.written, 0);
  assert.ok(Object.isFrozen(result));
  assert.equal(state.getLedger().length, 1);
});

test('pre-aborted invocation refuses before canonical execution and ledger mutation', async () => {
  const state = makeState();
  const observed = [];
  const harness = makeHarness();
  await registerCatalogueWebMCP({
    documentRef: harness.documentRef,
    registry: state.getCommandRegistry(),
    executeTool: canonicalExecutor(state, observed),
    registrationController: new AbortController(),
  });
  const aborted = new AbortController();
  aborted.abort();

  await assert.rejects(
    () => harness.calls[0].descriptor.execute({}, { signal: aborted.signal }),
    (error) => error?.name === 'AbortError',
  );
  assert.deepEqual(observed, []);
  assert.equal(state.getLedger().length, 0);
});

test('unsupported browser is frozen fail-closed and never executes a tool', async () => {
  const state = makeState();
  const receipt = await registerCatalogueWebMCP({
    documentRef: {},
    registry: state.getCommandRegistry(),
    executeTool: canonicalExecutor(state),
    registrationController: new AbortController(),
  });
  assert.deepEqual(receipt, { state: 'unsupported', registered: [], errors: [] });
  assert.ok(Object.isFrozen(receipt));
  assert.equal(state.getLedger().length, 0);
});

test('invalid or human-capable registry fails before the first browser call', async () => {
  const state = makeState();
  const original = state.getCommandRegistry()[0];
  const unsafe = Object.freeze([
    Object.freeze({ ...original, name: 'apply_catalogue' }),
    ...state.getCommandRegistry().slice(1),
  ]);
  const harness = makeHarness();
  const receipt = await registerCatalogueWebMCP({
    documentRef: harness.documentRef,
    registry: unsafe,
    executeTool: canonicalExecutor(state),
    registrationController: new AbortController(),
  });
  assert.deepEqual(receipt, { state: 'failed', registered: [], errors: ['invalid_registry'] });
  assert.equal(harness.calls.length, 0);
});

test('circular schema and invented declaration or annotation fields fail as sanitized registry errors', async () => {
  const state = makeState();
  const [first, ...tail] = state.getCommandRegistry();
  const circularSchema = { type: 'object', properties: {} };
  circularSchema.loop = circularSchema;
  Object.freeze(circularSchema.properties);
  Object.freeze(circularSchema);
  const variants = [
    Object.freeze([Object.freeze({ ...first, inputSchema: circularSchema }), ...tail]),
    Object.freeze([Object.freeze({ ...first, invented: true }), ...tail]),
    Object.freeze([
      Object.freeze({ ...first, annotations: Object.freeze({ readOnlyHint: true, invented: false }) }),
      ...tail,
    ]),
  ];

  for (const registry of variants) {
    const harness = makeHarness();
    const receipt = await registerCatalogueWebMCP({
      documentRef: harness.documentRef,
      registry,
      executeTool: canonicalExecutor(state),
      registrationController: new AbortController(),
    });
    assert.deepEqual(receipt, { state: 'failed', registered: [], errors: ['invalid_registry'] });
    assert.equal(harness.calls.length, 0);
  }
});

test('partial registration failure aborts all lifecycle registrations and sanitizes receipt', async () => {
  const state = makeState();
  const harness = makeHarness({ failAt: 3 });
  const controller = new AbortController();
  const receipt = await registerCatalogueWebMCP({
    documentRef: harness.documentRef,
    registry: state.getCommandRegistry(),
    executeTool: canonicalExecutor(state),
    registrationController: controller,
  });

  assert.equal(harness.calls.length, 3);
  assert.equal(controller.signal.aborted, true);
  assert.deepEqual(receipt, { state: 'failed', registered: [], errors: ['registration_failed'] });
  assert.doesNotMatch(JSON.stringify(receipt), /private|provider|marker/i);
});

test('repeated initialization for one document reuses the first receipt without duplicate calls', async () => {
  const state = makeState();
  const harness = makeHarness();
  const input = {
    documentRef: harness.documentRef,
    registry: state.getCommandRegistry(),
    executeTool: canonicalExecutor(state),
    registrationController: new AbortController(),
  };
  const first = await registerCatalogueWebMCP(input);
  const second = await registerCatalogueWebMCP({ ...input, registrationController: new AbortController() });
  assert.strictEqual(first, second);
  assert.equal(harness.calls.length, 4);
});

test('schema and declarations are cloned so later caller mutations cannot cross the browser boundary', async () => {
  const state = makeState();
  const harness = makeHarness();
  const registry = state.getCommandRegistry();
  await registerCatalogueWebMCP({
    documentRef: harness.documentRef,
    registry,
    executeTool: canonicalExecutor(state),
    registrationController: new AbortController(),
  });
  assert.notStrictEqual(harness.calls[0].descriptor.inputSchema, registry[0].inputSchema);
  assert.deepEqual(harness.calls[0].descriptor.inputSchema, registry[0].inputSchema);
  assert.notStrictEqual(harness.calls[0].descriptor.annotations, registry[0].annotations);
  assert.ok(Object.isFrozen(harness.calls[0].descriptor.inputSchema));
  assert.ok(Object.isFrozen(harness.calls[0].descriptor.annotations));
});
