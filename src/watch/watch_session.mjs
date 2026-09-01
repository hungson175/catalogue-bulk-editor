const TOP_LEVEL_KEYS = new Set([
  'schemaVersion', 'entryId', 'title', 'metricLabels', 'steps',
]);
const STEP_KEYS = new Set(['id', 'label', 'tool', 'input', 'expected']);
const EXPECTED_KEYS = new Set(['result', 'metricsAfter']);
const FORBIDDEN_TOOL_NAME = /apply|commit|approve|release|undo|human/i;
const SAFE_METRIC_KEY = /^[a-z][a-z0-9_-]{0,31}$/;
const FORBIDDEN_DATA_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const FORBIDDEN_RECEIPT_KEYS = new Set([
  'token', 'cookie', 'cookievalue', 'localstorage', 'authorization',
  'browserprofile', 'profilepath', 'auth',
]);

function isPlainObject(value) {
  if (value === null || typeof value !== 'object') return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertExactKeys(value, allowed, label) {
  assertPlainObject(value, label);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new TypeError(`${label} has unknown key: ${key}`);
  }
}

function assertPlainObject(value, label) {
  if (!isPlainObject(value)) throw new TypeError(`${label} must be a plain object`);
}

function assertSafeData(value, path = 'value') {
  if (Array.isArray(value)) {
    value.forEach((child, index) => assertSafeData(child, `${path}[${index}]`));
    return;
  }
  if (isPlainObject(value)) {
    for (const [key, child] of Object.entries(value)) {
      if (FORBIDDEN_DATA_KEYS.has(key)) {
        throw new TypeError(`${path} contains forbidden key: ${key}`);
      }
      assertSafeData(child, `${path}.${key}`);
    }
    return;
  }
  if (
    value !== null
    && typeof value !== 'string'
    && typeof value !== 'number'
    && typeof value !== 'boolean'
  ) {
    throw new TypeError(`${path} must be JSON data`);
  }
  if (typeof value === 'number' && !Number.isFinite(value)) {
    throw new TypeError(`${path} must be a finite number`);
  }
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

function cloneJson(value, label = 'value') {
  assertSafeData(value, label);
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new TypeError(`${label} is not JSON serializable`);
  return JSON.parse(encoded);
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, stableValue(value[key])]),
    );
  }
  return value;
}

export function stableStringify(value) {
  assertSafeData(value);
  return JSON.stringify(stableValue(value));
}

export function digestJson(value) {
  const text = stableStringify(value);
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `fnv1a32:${hash.toString(16).padStart(8, '0')}`;
}

function isDeepSubset(actual, expected) {
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual) || actual.length !== expected.length) return false;
    return expected.every((child, index) => isDeepSubset(actual[index], child));
  }
  if (isPlainObject(expected)) {
    if (!isPlainObject(actual)) return false;
    return Object.entries(expected).every(
      ([key, child]) => Object.hasOwn(actual, key) && isDeepSubset(actual[key], child),
    );
  }
  return Object.is(actual, expected);
}

function requireNonEmptyString(value, label) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`${label} must be a non-empty string`);
  }
  return value;
}

export function validateScenario(rawScenario) {
  assertExactKeys(rawScenario, TOP_LEVEL_KEYS, 'scenario');
  if (rawScenario.schemaVersion !== 1) {
    throw new TypeError('scenario.schemaVersion must equal 1');
  }
  requireNonEmptyString(rawScenario.entryId, 'scenario.entryId');
  requireNonEmptyString(rawScenario.title, 'scenario.title');
  assertPlainObject(rawScenario.metricLabels, 'scenario.metricLabels');
  const metricEntries = Object.entries(rawScenario.metricLabels);
  if (metricEntries.length < 1 || metricEntries.length > 5) {
    throw new TypeError('scenario.metricLabels must contain one to five cards');
  }
  for (const [key, label] of metricEntries) {
    if (!SAFE_METRIC_KEY.test(key)) {
      throw new TypeError(`metric key must match ${SAFE_METRIC_KEY}: ${key}`);
    }
    requireNonEmptyString(label, `metric label ${key}`);
  }
  if (!Array.isArray(rawScenario.steps) || rawScenario.steps.length === 0) {
    throw new TypeError('scenario.steps must be a non-empty array');
  }

  const ids = new Set();
  for (const [index, step] of rawScenario.steps.entries()) {
    const path = `scenario.steps[${index}]`;
    assertExactKeys(step, STEP_KEYS, path);
    const id = requireNonEmptyString(step.id, `${path}.id`);
    if (ids.has(id)) throw new TypeError('scenario step ids must be unique');
    ids.add(id);
    requireNonEmptyString(step.label, `${path}.label`);
    const tool = requireNonEmptyString(step.tool, `${path}.tool`);
    if (FORBIDDEN_TOOL_NAME.test(tool)) {
      throw new TypeError(`human-write tool is forbidden in watch mode: ${tool}`);
    }
    assertPlainObject(step.input, `${path}.input`);
    assertSafeData(step.input, `${path}.input`);
    assertExactKeys(step.expected, EXPECTED_KEYS, `${path}.expected`);
    if (!Object.hasOwn(step.expected, 'result') || !Object.hasOwn(step.expected, 'metricsAfter')) {
      throw new TypeError(`${path}.expected needs result and metricsAfter`);
    }
    assertPlainObject(step.expected.result, `${path}.expected.result`);
    assertPlainObject(step.expected.metricsAfter, `${path}.expected.metricsAfter`);
    assertSafeData(step.expected, `${path}.expected`);
  }

  return deepFreeze(cloneJson(rawScenario, 'scenario'));
}

export function assertReceiptSafe(value) {
  function walk(current) {
    if (Array.isArray(current)) {
      current.forEach(walk);
      return;
    }
    if (!isPlainObject(current)) return;
    for (const [key, child] of Object.entries(current)) {
      const normalized = key.toLowerCase().replaceAll('_', '');
      if (FORBIDDEN_RECEIPT_KEYS.has(normalized)) {
        throw new TypeError(`receipt contains forbidden key: ${key}`);
      }
      walk(child);
    }
  }
  walk(value);
  return true;
}

export class WatchSessionError extends Error {
  constructor(message, receipt) {
    super(message);
    this.name = 'WatchSessionError';
    this.receipt = receipt;
  }
}

function createReceipt({ scenario, status, startedAt, endedAt, steps, failure }) {
  const receipt = {
    schemaVersion: 1,
    status,
    entryId: scenario.entryId,
    scenarioDigest: digestJson(scenario),
    elapsedMs: Math.max(0, endedAt - startedAt),
    steps: cloneJson(steps, 'receipt.steps'),
    browserApiInvocation: 'PROGRAMMATIC_ZERO_WRITE_TOOLS',
    nativeAgentInvocation: 'UNPROVEN',
  };
  if (failure) receipt.failure = cloneJson(failure, 'receipt.failure');
  assertReceiptSafe(receipt);
  return deepFreeze(receipt);
}

export function createWatchSession({ scenario: rawScenario, adapter, now }) {
  const scenario = validateScenario(rawScenario);
  if (!adapter || typeof adapter.executeTool !== 'function' || typeof adapter.getMetrics !== 'function') {
    throw new TypeError('adapter must provide executeTool and getMetrics');
  }
  const monotonicNow = now ?? (() => performance.now());
  if (typeof monotonicNow !== 'function') throw new TypeError('now must be callable');

  const subscribers = new Set();
  let running = false;
  let stopRequested = false;
  let activeController = null;

  function emit(event) {
    const safeEvent = deepFreeze(cloneJson(event, 'event'));
    for (const subscriber of subscribers) subscriber(safeEvent);
  }

  function subscribe(subscriber) {
    if (typeof subscriber !== 'function') throw new TypeError('subscriber must be callable');
    subscribers.add(subscriber);
    return () => subscribers.delete(subscriber);
  }

  function stop() {
    stopRequested = true;
    activeController?.abort();
  }

  async function run() {
    if (running) throw new Error('watch session is already running');
    running = true;
    stopRequested = false;
    const startedAt = monotonicNow();
    const stepReceipts = [];
    emit({ type: 'state', state: 'RUNNING', stepCount: scenario.steps.length });
    try {
      for (const [zeroIndex, step] of scenario.steps.entries()) {
        if (stopRequested) throw new DOMException('Stopped', 'AbortError');
        const stepNumber = zeroIndex + 1;
        activeController = new AbortController();
        const metricsBefore = cloneJson(await adapter.getMetrics(), 'metricsBefore');
        emit({ type: 'step-start', stepNumber, stepCount: scenario.steps.length, stepId: step.id, metricsBefore });

        let actualResult;
        try {
          actualResult = cloneJson(
            await adapter.executeTool(
              step.tool,
              cloneJson(step.input, 'step.input'),
              { signal: activeController.signal },
            ),
            'actualResult',
          );
        } catch (error) {
          const stopped = stopRequested || error?.name === 'AbortError';
          const status = stopped ? 'STOPPED' : 'FAIL';
          const failure = {
            code: stopped ? 'aborted' : 'execute_failed',
            stepId: step.id,
            message: stopped ? 'watch replay stopped' : String(error?.message ?? error),
          };
          const receipt = createReceipt({
            scenario,
            status,
            startedAt,
            endedAt: monotonicNow(),
            steps: stepReceipts,
            failure,
          });
          emit({ type: 'state', state: status, failure });
          throw new WatchSessionError(failure.message, receipt);
        } finally {
          activeController = null;
        }

        const metricsAfter = cloneJson(await adapter.getMetrics(), 'metricsAfter');
        const stepReceipt = {
          id: step.id,
          tool: step.tool,
          input: cloneJson(step.input),
          actualResult,
          actualResultDigest: digestJson(actualResult),
          metricsBefore,
          metricsAfter,
          resultMatches: isDeepSubset(actualResult, step.expected.result),
          metricsMatch: isDeepSubset(metricsAfter, step.expected.metricsAfter),
        };
        stepReceipts.push(stepReceipt);
        if (!stepReceipt.resultMatches || !stepReceipt.metricsMatch) {
          const failure = {
            code: 'expectation_mismatch',
            stepId: step.id,
            message: 'actual live output or metrics did not match the scenario assertion',
          };
          const receipt = createReceipt({
            scenario,
            status: 'FAIL',
            startedAt,
            endedAt: monotonicNow(),
            steps: stepReceipts,
            failure,
          });
          emit({ type: 'step-fail', stepNumber, stepCount: scenario.steps.length, stepId: step.id, result: actualResult, metricsAfter });
          emit({ type: 'state', state: 'FAIL', failure });
          throw new WatchSessionError(failure.message, receipt);
        }
        emit({ type: 'step-pass', stepNumber, stepCount: scenario.steps.length, stepId: step.id, result: actualResult, metricsAfter });
      }
      const receipt = createReceipt({
        scenario,
        status: 'PASS',
        startedAt,
        endedAt: monotonicNow(),
        steps: stepReceipts,
      });
      emit({ type: 'state', state: 'PASS', receipt });
      return receipt;
    } finally {
      activeController = null;
      running = false;
    }
  }

  return Object.freeze({ run, stop, subscribe, scenario });
}
