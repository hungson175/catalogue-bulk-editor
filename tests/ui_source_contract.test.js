import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const ROOT = new URL('../', import.meta.url);

async function sources() {
  const [html, css, app, webmcp] = await Promise.all([
    readFile(new URL('index.html', ROOT), 'utf8'),
    readFile(new URL('styles.css', ROOT), 'utf8'),
    readFile(new URL('src/app.js', ROOT), 'utf8'),
    readFile(new URL('src/webmcp_adapter.js', ROOT), 'utf8'),
  ]);
  return { html, css, app, webmcp };
}

test('origin-trial meta is exact and precedes every script', async () => {
  const { html } = await sources();
  const token = 'An2udOLsUVYin2YuygomRe8nO8qa5GA6th8xcWUQwoZ9A4D5wLJUbu1wgHaZbBM6YbHKnaxMD+yCEYiAzS3wrQIAAABUeyJvcmlnaW4iOiJodHRwczovL2h1bmdzb24xNzUuZ2l0aHViLmlvOjQ0MyIsImZlYXR1cmUiOiJXZWJNQ1AiLCJleHBpcnkiOjE3OTQ4NzM2MDB9';
  const metaAt = html.indexOf(`<meta http-equiv="origin-trial" content="${token}">`);
  const scriptAt = html.indexOf('<script');
  assert.ok(metaAt > -1);
  assert.ok(scriptAt > metaAt);
  assert.match(html, /<script type="module">[\s\S]*\.\/src\/app\.js/);
});

test('semantic shell exposes the complete first-click workflow', async () => {
  const { html, app } = await sources();
  const combined = `${html}\n${app}`;
  for (const testId of [
    'task-input', 'preview-changes', 'unrig-toggle', 'catalogue-body', 'next-page', 'previous-page',
    'staged-diff', 'diff-row', 'apply-changes', 'decline-changes', 'undo-transaction',
    'prove-agent-cannot-apply', 'command-trigger', 'command-palette', 'command-item', 'status',
    'ledger', 'ledger-row', 'total-records', 'dom-rows', 'staged-count', 'written-count',
    'state-version', 'refusal-count', 'undo-depth',
    'webmcp-status',
  ]) {
    assert.match(
      combined,
      new RegExp(`data-testid=["']${testId}["']|dataset\\.testid\\s*=\\s*["']${testId}["']`),
      `missing ${testId}`,
    );
  }
  assert.match(combined, /<table|createElement\(['"]table['"]\)/);
  assert.match(combined, /aria-live=["']polite["']|setAttribute\(['"]aria-live['"],\s*['"]polite['"]\)/);
  assert.match(combined, /role=["']dialog["']|setAttribute\(['"]role['"],\s*['"]dialog['"]\)/);
});

test('one state and one fixture drive 30-row and all-row projections', async () => {
  const { app } = await sources();
  assert.equal((app.match(/createCatalogueState\s*\(/g) ?? []).length, 1);
  assert.equal((app.match(/generateCatalogue\s*\(/g) ?? []).length, 1);
  assert.match(app, /getViewport\s*\(\s*\{[^}]*limit\s*:\s*30[^}]*unrigged\s*:\s*false[^}]*\}\s*\)/s);
  assert.match(app, /getViewport\s*\(\s*\{\s*unrigged\s*:\s*true\s*\}\s*\)/s);
  assert.doesNotMatch(app, /\ballRows\b|secondState|shadowCatalogue/);
  assert.match(app, /returnedCount/);
});

test('fast row markup escapes every fixture field without weakening the public timeout', async () => {
  const { app } = await sources();
  const browser = await readFile(new URL('tests/ui_browser.py', ROOT), 'utf8');
  assert.match(app, /function\s+escapeHtml\s*\(/);
  for (const entity of ['&amp;', '&lt;', '&gt;', '&quot;', '&#39;']) {
    assert.ok(app.includes(entity), `escapeHtml is missing ${entity}`);
  }
  for (const expression of [
    'record.id', 'record.sku', 'record.name', 'record.supplier', 'record.lastSoldAt',
    'money(record.priceCents)', 'record.status',
  ]) {
    assert.ok(app.includes(`escapeHtml(${expression})`), `raw row field: ${expression}`);
  }
  assert.doesNotMatch(app, /\$\{record\./);
  assert.match(app, /catalogueBody\.innerHTML\s*=\s*viewport\.rows\.map\s*\(\s*rowHtml\s*\)\.join\s*\(\s*['"]{2}\s*\)/);
  assert.match(browser, /set_default_timeout\(1_500\)/);
  assert.match(browser, /length\s*===\s*14000/);
});

test('only Unrig bounds the real 14,000-row layout without weakening DOM truth', async () => {
  const { css, app } = await sources();
  assert.match(app, /catalogueBody\.classList\.toggle\s*\(\s*['"]unrig-viewport['"]\s*,\s*unrigged\s*\)/);
  assert.match(css, /tbody\.unrig-viewport\s*\{[^}]*display\s*:\s*block/s);
  assert.match(css, /tbody\.unrig-viewport\s*\{[^}]*max-height\s*:\s*520px/s);
  assert.match(css, /tbody\.unrig-viewport\s*\{[^}]*overflow-y\s*:\s*auto/s);
  assert.match(css, /tbody\.unrig-viewport\s+tr\s*\{[^}]*display\s*:\s*grid/s);
  assert.match(css, /grid-template-columns\s*:\s*repeat\(7\s*,\s*minmax\(0\s*,\s*1fr\)\)/);
  assert.match(css, /content-visibility\s*:\s*auto/);
  assert.match(css, /contain-intrinsic-size\s*:\s*0\s+36px/);
  assert.doesNotMatch(css, /(^|\n)\s*tbody\s*\{[^}]*display\s*:\s*block/s);
});

test('Cmd-K and the keyless callback share the frozen four-tool registry', async () => {
  const { app } = await sources();
  assert.match(app, /getCommandRegistry\s*\(\s*\)/);
  assert.match(app, /Object\.fromEntries\s*\(\s*registry\.map/);
  assert.match(app, /Object\.hasOwn\s*\(\s*byName\s*,\s*name\s*\)/);
  assert.match(app, /window\.catalogueDemo\s*=\s*Object\.freeze\s*\(\s*\{\s*runTool\s*,\s*getWatchMetrics\s*\}\s*\)/);
  assert.match(app, /function\s+getWatchMetrics\s*\(/);
  assert.match(app, /Object\.freeze\s*\(\s*\{\s*result\s*,\s*snapshot\s*,\s*ledgerTail\s*\}\s*\)/);
  assert.match(app, /unknown_tool/);
  assert.doesNotMatch(app, /const\s+commands\s*=\s*\[/);
});

test('human writes preserve native-event and literal-null boundaries', async () => {
  const { app } = await sources();
  assert.match(app, /state\.human\.apply\s*\(\s*null\s*\)/);
  assert.match(app, /state\.human\.apply\s*\(\s*event\s*\)/);
  assert.match(app, /state\.human\.decline\s*\(\s*event\s*\)/);
  assert.match(app, /state\.human\.undo\s*\(\s*event\s*\)/);
  assert.doesNotMatch(app, /new\s+Event\s*\(|new\s+MouseEvent\s*\(|isTrusted\s*:/);
});

test('bounded diff composition and exact judge proof copy are present', async () => {
  const { app } = await sources();
  assert.match(app, /\[\s*0\s*,\s*100\s*,\s*200\s*,\s*300\s*\]/);
  assert.match(app, /limit\s*:\s*100/);
  assert.match(app, /change\.before/);
  assert.match(app, /change\.patch/);
  for (const copy of [
    '340 staged · 0 written',
    'Refused: gesture_required — 0 written, 340 staged retained. Human gesture required.',
    'Applied 340 records in 1 transaction (tx stage-0001) — 0 staged · 340 written. State v1, undo available.',
    'Undone 340 records — state v2, 0 staged · 340 written, prices and status restored.',
    'Declined — 0 written, 340 discarded. 0 staged.',
  ]) {
    assert.ok(app.includes(copy), `missing proof copy: ${copy}`);
  }
});

test('WebMCP stays in one page-local adapter with no remote, persistence, credential, or model seam', async () => {
  const { html, css, app, webmcp } = await sources();
  assert.doesNotMatch(`${html}\n${css}`, /https?:\/\/|@import\s+url/i);
  assert.doesNotMatch(`${app}\n${webmcp}`, /\bfetch\b|XMLHttpRequest|WebSocket|localStorage|sessionStorage|indexedDB|serviceWorker|process\.env|api[_-]?key|authorization/i);
  assert.match(app, /registerCatalogueWebMCP/);
  assert.match(webmcp, /documentRef\?\.modelContext/);
  assert.match(webmcp, /registerTool/);
  assert.doesNotMatch(`${app}\n${webmcp}`, /navigator\.modelContext|enable-features|enable-blink-features|polyfill/i);
  assert.match(css, /@media/);
  assert.match(css, /overflow-x\s*:\s*auto/);
});
