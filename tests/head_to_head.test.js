import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  createWebMcpArm,
  mountHeadToHead,
  normalizeToolResult,
} from '../src/head_to_head.js';

test('normalizes the real browser string result and already-object fake result', () => {
  const value = { result: { ok: true, total: 14000 } };
  assert.deepEqual(normalizeToolResult(JSON.stringify(value)), value);
  assert.deepEqual(normalizeToolResult(value), value);
  assert.throws(() => normalizeToolResult('{bad json'), /invalid_tool_result/);
  assert.throws(() => normalizeToolResult(null), /invalid_tool_result/);
});

test('WebMCP arm declaration requires a document and exact browser-owned surface', () => {
  assert.equal(typeof createWebMcpArm, 'function');
  assert.throws(() => createWebMcpArm({}), /document/i);
});

test('head-to-head mount rejects missing live DOM and never silently falls back', () => {
  assert.equal(typeof mountHeadToHead, 'function');
  assert.throws(() => mountHeadToHead({}), /document/i);
});

test('orchestrator bans private state imports and keyless callback while requiring modelContext', () => {
  const source = readFileSync(new URL('../src/head_to_head.js', import.meta.url), 'utf8');
  for (const forbidden of [
    'catalogue_state', 'sample_catalogue', 'tool_registry', 'webmcp_adapter', 'window.catalogueDemo',
  ]) {
    assert.equal(source.includes(forbidden), false, forbidden);
  }
  assert.match(source, /modelContext/);
  assert.match(source, /getTools/);
  assert.match(source, /executeTool/);
  assert.doesNotMatch(source, /pageOwnedRecords\s*:\s*14_?000/);
  assert.doesNotMatch(source, /undoDepth\s*:\s*1/);
});

test('WebMCP source observes fresh counters, real tool outputs, human Apply, timing, and UNPROVEN boundary', () => {
  const source = readFileSync(new URL('../src/head_to_head.js', import.meta.url), 'utf8');
  assert.match(source, /catalogue_summary/);
  assert.match(source, /preview_supplier_policy/);
  assert.match(source, /inspect_staged_changes/);
  assert.match(source, /performance\.now|now\s*[:=]/);
  assert.match(source, /staged-count/);
  assert.match(source, /undo-depth/);
  assert.match(source, /READY_FOR_HUMAN_RELEASE/);
  assert.match(source, /UNPROVEN/);
  assert.match(source, /addEventListener\(['"]click['"]/);
  assert.doesNotMatch(source, /apply-changes[^\n]+\.click\(/);
  assert.doesNotMatch(source, /catch\s*\([^)]*\)\s*\{[^}]*executeTool/s);
});

test('measured pitch leads with atomicity and co-presence, not speed or DOM reach', () => {
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
  const source = readFileSync(new URL('../src/head_to_head.js', import.meta.url), 'utf8');
  const undoAt = html.indexOf('Undo depth');
  const focusAt = html.indexOf('Human keystrokes lost');
  const attributionAt = html.indexOf('Execution attribution');
  const refusalAt = html.indexOf('Write refusal');
  const reachAt = html.indexOf('Reach (context only)');
  const elapsedAt = html.indexOf('Elapsed (context only)');

  assert.match(html, /340 undo entries[—-]or one/);
  assert.match(html, /strongest possible classical baseline/i);
  assert.match(html, /exact policy/i);
  assert.match(html, /no model latency/i);
  assert.match(html, /not a speed claim/i);
  assert.match(html, /data-testid=["']classical-baseline["']/);
  assert.ok(undoAt > -1 && undoAt < focusAt);
  assert.ok(focusAt < attributionAt && attributionAt < refusalAt);
  assert.ok(refusalAt < reachAt && reachAt < elapsedAt);
  assert.doesNotMatch(`${html}\n${readme}\n${source}`, /~470|88\s*minutes|DOM cannot reach/i);
  assert.match(readme, /atomicity/i);
  assert.match(readme, /co-presence/i);
  assert.match(readme, /340[^\n]*undo[^\n]*one/i);
});
