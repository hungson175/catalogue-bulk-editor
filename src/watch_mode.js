import { mountRecordingOverlay } from './watch/recording_overlay.mjs';
import { createWatchSession, validateScenario } from './watch/watch_session.mjs';

const METRIC_KEYS = Object.freeze(['dom', 'staged', 'written', 'refusal', 'undo']);

// Minimal repeatable watch: reset (idempotent) → summary (14k/30 gap) → preview
// (340 staged) → inspect (bounded 20) → discard (clean zero-write). Removing any
// step loses repeatability or judge legibility; the order is load-bearing.
export const CATALOGUE_WATCH_SCENARIO = validateScenario({
  schemaVersion: 1,
  entryId: 'catalogue-bulk-editor',
  title: 'Five real calls · zero records written',
  metricLabels: {
    dom: 'DOM rows',
    staged: 'Staged',
    written: 'Written',
    refusal: 'Refusals',
    undo: 'Undo depth',
  },
  steps: [
    {
      id: 'reset-preview',
      label: 'Reset any staged preview',
      tool: 'discard_staged_changes',
      input: { reason: 'watch-mode-reset' },
      expected: {
        result: { result: { ok: true, written: 0 }, snapshot: { stagedCount: 0 } },
        metricsAfter: { staged: 0, written: 0 },
      },
    },
    {
      id: 'read-summary',
      label: 'Read the 14,000-record summary',
      tool: 'catalogue_summary',
      input: {},
      expected: {
        result: { result: { ok: true, total: 14000 }, snapshot: { stagedCount: 0 } },
        metricsAfter: { dom: 30, staged: 0, written: 0 },
      },
    },
    {
      id: 'stage-fjord-policy',
      label: 'Stage the Fjord supplier policy',
      tool: 'preview_supplier_policy',
      input: { supplier: 'Fjord', cutoff: '2026-06-01', discountPct: 15 },
      expected: {
        result: { result: { ok: true, staged: 340, written: 0 }, snapshot: { stagedCount: 340 } },
        metricsAfter: { staged: 340, written: 0 },
      },
    },
    {
      id: 'inspect-first-page',
      label: 'Inspect the first bounded page',
      tool: 'inspect_staged_changes',
      input: { offset: 0, limit: 20 },
      expected: {
        result: { result: { ok: true, total: 340, limit: 20 }, snapshot: { stagedCount: 340 } },
        metricsAfter: { staged: 340, written: 0 },
      },
    },
    {
      id: 'discard-preview',
      label: 'Discard the staged preview',
      tool: 'discard_staged_changes',
      input: { reason: 'watch-mode-complete' },
      expected: {
        result: { result: { ok: true, written: 0, outcome: 'discarded' }, snapshot: { stagedCount: 0 } },
        metricsAfter: { staged: 0, written: 0 },
      },
    },
  ],
});

const ALLOWED_TOOLS = new Set(CATALOGUE_WATCH_SCENARIO.steps.map(({ tool }) => tool));

function isPlainObject(value) {
  if (value === null || typeof value !== 'object') return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertSafeJson(value, path = 'value') {
  if (Array.isArray(value)) {
    value.forEach((child, index) => assertSafeJson(child, `${path}[${index}]`));
    return;
  }
  if (isPlainObject(value)) {
    for (const [key, child] of Object.entries(value)) {
      if (['__proto__', 'prototype', 'constructor'].includes(key)) {
        throw new TypeError(`${path} contains a forbidden key`);
      }
      assertSafeJson(child, `${path}.${key}`);
    }
    return;
  }
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number' && Number.isFinite(value)) return;
  throw new TypeError(`${path} must contain safe JSON data`);
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

function cloneFrozenJson(value, label) {
  assertSafeJson(value, label);
  return deepFreeze(JSON.parse(JSON.stringify(value)));
}

function cloneJson(value, label) {
  assertSafeJson(value, label);
  return JSON.parse(JSON.stringify(value));
}

function abortError() {
  return new DOMException('Watch replay aborted', 'AbortError');
}

function validateDemo(demo) {
  if (!isPlainObject(demo) || !Object.isFrozen(demo)) {
    throw new TypeError('demo must be a frozen plain surface');
  }
  if (Object.getOwnPropertySymbols(demo).length !== 0) {
    throw new TypeError('demo surface has unexpected keys');
  }
  const keys = Object.getOwnPropertyNames(demo);
  if (keys.length !== 2 || keys[0] !== 'runTool' || keys[1] !== 'getWatchMetrics') {
    throw new TypeError('demo surface must have exact keys runTool,getWatchMetrics');
  }
  if (typeof demo.runTool !== 'function' || typeof demo.getWatchMetrics !== 'function') {
    throw new TypeError('demo surface values must be functions');
  }
  return demo;
}

function validateMetrics(rawMetrics) {
  if (!isPlainObject(rawMetrics)) throw new TypeError('metrics must be a plain object');
  const keys = Object.keys(rawMetrics);
  if (keys.length !== METRIC_KEYS.length || keys.some((key, index) => key !== METRIC_KEYS[index])) {
    throw new TypeError('metrics must have exact ordered keys');
  }
  for (const key of METRIC_KEYS) {
    if (!Number.isFinite(rawMetrics[key]) || rawMetrics[key] < 0) {
      throw new TypeError('metrics must be finite non-negative numbers');
    }
  }
  return cloneFrozenJson(rawMetrics, 'metrics');
}

export function createCatalogueWatchAdapter(demo) {
  const owner = validateDemo(demo);

  function executeTool(name, input, { signal } = {}) {
    if (signal?.aborted) throw abortError();
    if (!ALLOWED_TOOLS.has(name)) throw new RangeError('unknown_tool');
    if (!isPlainObject(input)) throw new TypeError('tool input must be a plain object');
    const safeInput = cloneJson(input, 'tool input');
    let output;
    try {
      output = owner.runTool({ name, input: safeInput });
    } catch {
      if (signal?.aborted) throw abortError();
      throw new Error('watch_tool_failed');
    }
    if (signal?.aborted) throw abortError();
    return cloneFrozenJson(output, 'tool output');
  }

  function getMetrics() {
    return validateMetrics(owner.getWatchMetrics());
  }

  return Object.freeze({ executeTool, getMetrics });
}

export function mountCatalogueWatchMode({ container, demo } = {}) {
  if (!container || typeof container.querySelector !== 'function') {
    throw new TypeError('watch container must be a DOM element');
  }
  const session = createWatchSession({
    scenario: CATALOGUE_WATCH_SCENARIO,
    adapter: createCatalogueWatchAdapter(demo),
  });
  return mountRecordingOverlay({ container, session });
}
