import { createCatalogueState } from './catalogue_state.js';
import { generateCatalogue } from './sample_catalogue.js';
import { registerCatalogueWebMCP } from './webmcp_adapter.js';
import { mountCatalogueWatchMode } from './watch_mode.js';
import { mountHeadToHead } from './head_to_head.js';

const POLICY = Object.freeze({ supplier: 'Fjord', cutoff: '2026-06-01', discountPct: 15 });
const DIFF_OFFSETS = Object.freeze([0, 100, 200, 300]);
const BASE_TIME = Date.UTC(2026, 8, 1, 2, 0, 0);
let clockTick = 0;

function clock() {
  const timestamp = new Date(BASE_TIME + clockTick * 1_000).toISOString();
  clockTick += 1;
  return timestamp;
}

const state = createCatalogueState({ records: generateCatalogue(), clock });
const registry = state.getCommandRegistry();
const byName = Object.fromEntries(registry.map((descriptor) => [descriptor.name, descriptor]));

const counts = new Intl.NumberFormat('en-US');
let offset = 0;
let unrigged = false;
let visibleDiffs = [];
let lastWritten = 0;
let activeCommand = 0;
let paletteTrigger = null;
let dom = null;
const webmcpRegistrationController = new AbortController();

function money(cents) {
  return `$${(cents / 100).toFixed(2)}`;
}

function valueLabel(key, value) {
  return key === 'priceCents' ? money(value) : String(value);
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function rowHtml(record) {
  const status = escapeHtml(record.status);
  return `<tr data-id="${escapeHtml(record.id)}">`
    + `<td>${escapeHtml(record.id)}</td>`
    + `<td>${escapeHtml(record.sku)}</td>`
    + `<td>${escapeHtml(record.name)}</td>`
    + `<td>${escapeHtml(record.supplier)}</td>`
    + `<td>${escapeHtml(record.lastSoldAt)}</td>`
    + `<td class="money">${escapeHtml(money(record.priceCents))}</td>`
    + `<td><span class="status-pill ${status}">${status}</span></td>`
    + '</tr>';
}

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function renderGrid() {
  const viewport = unrigged
    ? state.getViewport({ unrigged: true })
    : state.getViewport({ offset, limit: 30, unrigged: false });
  dom.catalogueBody.classList.toggle('unrig-viewport', unrigged);
  dom.catalogueBody.innerHTML = viewport.rows.map(rowHtml).join('');
  dom.domRows.textContent = counts.format(viewport.returnedCount);
  const start = viewport.returnedCount === 0 ? 0 : viewport.offset + 1;
  const end = unrigged ? viewport.total : Math.min(viewport.offset + viewport.returnedCount, viewport.total);
  dom.pageRange.textContent = unrigged
    ? `All ${counts.format(viewport.total)} rows`
    : `${counts.format(start)}–${counts.format(end)} of ${counts.format(viewport.total)}`;
  dom.previous.disabled = unrigged || offset === 0;
  dom.next.disabled = unrigged || offset + 30 >= viewport.total;
  return viewport;
}

function renderDiffs() {
  if (visibleDiffs.length === 0) {
    dom.diffList.replaceChildren(element('p', 'empty-state', 'Preview the Fjord policy to inspect all 340 changes.'));
    dom.diffSummary.textContent = '0 staged · 0 written';
    return;
  }
  const fragment = document.createDocumentFragment();
  for (const change of visibleDiffs) {
    const row = element('div', 'diff-row');
    row.dataset.testid = 'diff-row';
    row.dataset.id = change.id;
    row.append(element('span', 'diff-id', change.id));
    const details = element('span', 'diff-change');
    const key = Object.keys(change.patch)[0];
    details.append(
      document.createTextNode(`${key}: `),
      element('span', 'diff-before', valueLabel(key, change.before[key])),
      document.createTextNode(' → '),
      element('span', 'diff-after', valueLabel(key, change.patch[key])),
    );
    row.append(details);
    fragment.append(row);
  }
  dom.diffList.replaceChildren(fragment);
  dom.diffSummary.textContent = `${counts.format(visibleDiffs.length)} staged · 0 written`;
}

function renderLedger() {
  const ledger = state.getLedger();
  if (ledger.length === 0) {
    dom.ledger.replaceChildren(element('li', 'empty-state', 'No actions yet.'));
    return;
  }
  const fragment = document.createDocumentFragment();
  for (const entry of ledger) {
    const row = element('li', 'ledger-row');
    row.dataset.testid = 'ledger-row';
    row.append(
      element('span', '', `#${entry.seq}`),
      element('strong', '', `${entry.op} · ${entry.outcome}`),
      element('span', '', `written:${entry.written}`),
    );
    fragment.append(row);
  }
  dom.ledger.replaceChildren(fragment);
}

function renderCounters(viewport) {
  const snapshot = state.getSnapshot();
  dom.totalRecords.textContent = counts.format(snapshot.total);
  dom.domRows.textContent = counts.format(viewport.returnedCount);
  dom.stagedCount.textContent = counts.format(snapshot.stagedCount);
  dom.writtenCount.textContent = counts.format(lastWritten);
  dom.stateVersion.textContent = `v${snapshot.stateVersion}`;
  dom.refusalCount.textContent = counts.format(snapshot.refusalCount);
  dom.undoDepth.textContent = counts.format(snapshot.undoDepth);
  dom.preview.disabled = snapshot.stagedCount > 0;
  dom.safety.disabled = snapshot.stagedCount === 0;
  dom.apply.disabled = snapshot.stagedCount === 0;
  dom.decline.disabled = snapshot.stagedCount === 0;
  dom.undo.disabled = snapshot.undoDepth === 0;
  dom.apply.textContent = snapshot.stagedCount > 0 ? `Apply ${counts.format(snapshot.stagedCount)}` : 'Apply 340';
  return snapshot;
}

function renderAll() {
  const viewport = renderGrid();
  renderDiffs();
  renderLedger();
  renderCounters(viewport);
}

function announce(message) {
  dom.status.textContent = message;
}

function collectDiffs() {
  visibleDiffs = DIFF_OFFSETS.flatMap((pageOffset) => (
    byName.inspect_staged_changes.handler({ offset: pageOffset, limit: 100 }).changes
  ));
}

function inputFor(name) {
  if (name === 'preview_supplier_policy') return POLICY;
  if (name === 'inspect_staged_changes') return Object.freeze({ offset: 0, limit: 30 });
  return Object.freeze({});
}

function toolMessage(name, result) {
  if (name === 'catalogue_summary') {
    return `Summary ready — ${counts.format(result.total)} records, 30 rows in the virtualized DOM. 0 written.`;
  }
  if (name === 'preview_supplier_policy' && result.ok) {
    return 'Preview staged 340 changes — 340 staged · 0 written. 170 discontinue, 170 discount. No records written.';
  }
  if (name === 'inspect_staged_changes') {
    return `Inspected ${counts.format(result.total)} staged changes — 0 written.`;
  }
  if (name === 'discard_staged_changes') {
    return `Tool discarded staged preview — ${result.written} written.`;
  }
  return `${name}: ${result.outcome ?? result.reason ?? 'invalid_input'} — ${result.written ?? 0} written.`;
}

function runTool({ name, input } = {}) {
  if (!Object.hasOwn(byName, name)) throw new Error('unknown_tool');
  const result = byName[name].handler(input ?? inputFor(name));
  if (name === 'preview_supplier_policy' && result.ok && result.staged > 0) collectDiffs();
  if (name === 'discard_staged_changes' && result.ok) visibleDiffs = [];
  lastWritten = result.written ?? 0;
  renderAll();
  announce(toolMessage(name, result));
  const snapshot = state.getSnapshot();
  const ledgerTail = state.getLedger().at(-1) ?? Object.freeze({});
  return Object.freeze({ result, snapshot, ledgerTail });
}

function getWatchMetrics() {
  const snapshot = state.getSnapshot();
  return Object.freeze({
    dom: dom.catalogueBody.querySelectorAll('tr').length,
    staged: snapshot.stagedCount,
    written: lastWritten,
    refusal: snapshot.refusalCount,
    undo: snapshot.undoDepth,
  });
}

function renderWebMCPStatus(receipt) {
  const copy = {
    registered: 'WebMCP: 4 catalogue tools ready',
    unsupported: 'WebMCP unavailable here · keyless demo still works',
    failed: 'WebMCP registration failed · no tools active',
  };
  dom.webmcpStatus.dataset.state = receipt.state;
  dom.webmcpStatus.textContent = copy[receipt.state] ?? copy.failed;
}

function closePalette() {
  dom.palette.hidden = true;
  if (paletteTrigger) paletteTrigger.focus();
}

function selectCommand(index) {
  const items = [...dom.commandList.querySelectorAll('[data-testid="command-item"]')];
  if (items.length === 0) return;
  activeCommand = (index + items.length) % items.length;
  items.forEach((item, itemIndex) => item.setAttribute('aria-selected', String(itemIndex === activeCommand)));
  items[activeCommand].focus();
}

function executePaletteCommand() {
  const descriptor = registry[activeCommand];
  runTool({ name: descriptor.name, input: inputFor(descriptor.name) });
  closePalette();
}

function openPalette(trigger) {
  paletteTrigger = trigger ?? dom.commandTrigger;
  dom.palette.hidden = false;
  selectCommand(0);
}

function buildPalette() {
  const fragment = document.createDocumentFragment();
  registry.forEach((descriptor, index) => {
    const button = element('button', 'command-item');
    button.type = 'button';
    button.dataset.testid = 'command-item';
    button.dataset.command = descriptor.name;
    button.setAttribute('aria-selected', String(index === 0));
    button.append(element('strong', '', descriptor.name), element('span', '', descriptor.description));
    button.addEventListener('click', () => {
      activeCommand = index;
      executePaletteCommand();
    });
    fragment.append(button);
  });
  dom.commandList.replaceChildren(fragment);
}

function bindEvents(documentRef) {
  dom.preview.addEventListener('click', () => runTool({ name: 'preview_supplier_policy', input: POLICY }));
  dom.safety.addEventListener('click', () => {
    const result = state.human.apply(null);
    lastWritten = result.written;
    renderAll();
    announce('Refused: gesture_required — 0 written, 340 staged retained. Human gesture required.');
  });
  dom.apply.addEventListener('click', (event) => {
    const result = state.human.apply(event);
    lastWritten = result.written;
    if (result.ok) visibleDiffs = [];
    renderAll();
    announce(result.ok
      ? 'Applied 340 records in 1 transaction (tx stage-0001) — 0 staged · 340 written. State v1, undo available.'
      : `Refused: ${result.reason} — 0 written.`);
  });
  dom.decline.addEventListener('click', (event) => {
    const result = state.human.decline(event);
    lastWritten = result.written;
    if (result.ok) visibleDiffs = [];
    renderAll();
    announce(result.ok ? 'Declined — 0 written, 340 discarded. 0 staged.' : `Refused: ${result.reason} — 0 written.`);
  });
  dom.undo.addEventListener('click', (event) => {
    const result = state.human.undo(event);
    lastWritten = result.written;
    renderAll();
    announce(result.ok
      ? 'Undone 340 records — state v2, 0 staged · 340 written, prices and status restored.'
      : `Refused: ${result.reason} — 0 written.`);
  });
  dom.unrig.addEventListener('change', () => {
    unrigged = dom.unrig.checked;
    offset = 0;
    const viewport = renderGrid();
    renderCounters(viewport);
  });
  dom.previous.addEventListener('click', () => {
    offset = Math.max(0, offset - 30);
    const viewport = renderGrid();
    renderCounters(viewport);
  });
  dom.next.addEventListener('click', () => {
    offset += 30;
    const viewport = renderGrid();
    renderCounters(viewport);
  });
  dom.commandTrigger.addEventListener('click', (event) => openPalette(event.currentTarget));
  dom.palette.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      closePalette();
    } else if (event.key === 'ArrowDown') {
      event.preventDefault();
      selectCommand(activeCommand + 1);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      selectCommand(activeCommand - 1);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      executePaletteCommand();
    }
  });
  documentRef.addEventListener('keydown', (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
      event.preventDefault();
      openPalette(dom.commandTrigger);
    }
  });
}

export async function bootstrap(documentRef) {
  dom = {
    totalRecords: documentRef.querySelector('[data-testid="total-records"]'),
    domRows: documentRef.querySelector('[data-testid="dom-rows"]'),
    stagedCount: documentRef.querySelector('[data-testid="staged-count"]'),
    writtenCount: documentRef.querySelector('[data-testid="written-count"]'),
    stateVersion: documentRef.querySelector('[data-testid="state-version"]'),
    refusalCount: documentRef.querySelector('[data-testid="refusal-count"]'),
    undoDepth: documentRef.querySelector('[data-testid="undo-depth"]'),
    preview: documentRef.querySelector('[data-testid="preview-changes"]'),
    safety: documentRef.querySelector('[data-testid="prove-agent-cannot-apply"]'),
    apply: documentRef.querySelector('[data-testid="apply-changes"]'),
    decline: documentRef.querySelector('[data-testid="decline-changes"]'),
    undo: documentRef.querySelector('[data-testid="undo-transaction"]'),
    unrig: documentRef.querySelector('[data-testid="unrig-toggle"]'),
    catalogueBody: documentRef.querySelector('[data-testid="catalogue-body"]'),
    pageRange: documentRef.querySelector('[data-testid="page-range"]'),
    previous: documentRef.querySelector('[data-testid="previous-page"]'),
    next: documentRef.querySelector('[data-testid="next-page"]'),
    diffList: documentRef.querySelector('[data-testid="staged-diff"]'),
    diffSummary: documentRef.querySelector('[data-testid="diff-summary"]'),
    ledger: documentRef.querySelector('[data-testid="ledger"]'),
    status: documentRef.querySelector('[data-testid="status"]'),
    commandTrigger: documentRef.querySelector('[data-testid="command-trigger"]'),
    palette: documentRef.querySelector('[data-testid="command-palette"]'),
    commandList: documentRef.querySelector('[data-testid="command-list"]'),
    webmcpStatus: documentRef.querySelector('[data-testid="webmcp-status"]'),
    watchMode: documentRef.querySelector('[data-testid="watch-mode"]'),
  };
  buildPalette();
  bindEvents(documentRef);
  renderAll();
  Object.freeze(runTool);
  Object.freeze(getWatchMetrics);
  window.catalogueDemo = Object.freeze({ runTool, getWatchMetrics });
  mountCatalogueWatchMode({ container: dom.watchMode, demo: window.catalogueDemo });
  const receipt = await registerCatalogueWebMCP({
    documentRef,
    registry,
    executeTool: runTool,
    registrationController: webmcpRegistrationController,
  });
  renderWebMCPStatus(receipt);
  mountHeadToHead({ documentRef });
  return receipt;
}
