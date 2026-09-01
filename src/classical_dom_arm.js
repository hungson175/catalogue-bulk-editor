const EXPECTED_INITIAL_ROWS = 30;
const EXPECTED_REACHABLE_ROWS = 14_000;
const EXPECTED_MATCHED = 340;
const EXPECTED_STATUS_EDITS = 170;
const EXPECTED_PRICE_EDITS = 170;
const RECEIPT_KEYS = Object.freeze([
  'mode', 'status', 'initialRows', 'reachableRows', 'turnsToFind', 'matched',
  'statusEdits', 'priceEdits', 'completedEdits', 'undoDepth', 'elapsedMs', 'lostKeystrokes',
]);

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function text(value) {
  return String(value?.textContent ?? '').trim();
}

function parseMoney(value) {
  if (!/^\$\d{1,3}(?:,\d{3})*\.\d{2}$|^\$\d+\.\d{2}$/.test(value)) {
    throw new TypeError('invalid_price');
  }
  const cents = Math.round(Number(value.slice(1).replaceAll(',', '')) * 100);
  if (!Number.isSafeInteger(cents) || cents < 0) throw new TypeError('invalid_price');
  return cents;
}

function validDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  return new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) === value;
}

export function parseCatalogueRows(rowNodes) {
  if (!rowNodes || typeof rowNodes[Symbol.iterator] !== 'function') {
    throw new TypeError('rows must be iterable');
  }
  const seen = new Set();
  const rows = [];
  for (const row of rowNodes) {
    const cells = [...(row?.cells ?? [])];
    if (cells.length !== 7) throw new TypeError('seven_cells_required');
    const [id, sku, name, supplier, lastSoldAt, price, status] = cells.map(text);
    if (row?.dataset?.id !== id || !/^record-\d{5}$/.test(id)) throw new TypeError('invalid_id');
    if (seen.has(id)) throw new TypeError('duplicate_id');
    if (!/^SKU-[A-Za-z0-9-]+$/.test(sku)) throw new TypeError('invalid_sku');
    if (!name || !supplier || !/^[A-Za-z]+$/.test(supplier)) throw new TypeError('invalid_text');
    if (!validDate(lastSoldAt)) throw new TypeError('invalid_date');
    if (!/^[a-z]+$/.test(status)) throw new TypeError('invalid_status');
    seen.add(id);
    rows.push(deepFreeze({
      id, sku, name, supplier, lastSoldAt, priceCents: parseMoney(price), status,
    }));
  }
  return deepFreeze(rows);
}

export function selectPolicyTargets(records, policy) {
  if (!Array.isArray(records) || !policy || typeof policy !== 'object') {
    throw new TypeError('records and policy are required');
  }
  const { supplier, cutoff, discountPct } = policy;
  if (typeof supplier !== 'string' || !validDate(cutoff)
    || !Number.isInteger(discountPct) || discountPct < 1 || discountPct > 99) {
    throw new TypeError('invalid_policy');
  }
  const targets = records
    .filter((record) => record.supplier === supplier)
    .map((record) => deepFreeze({
      id: record.id,
      patch: record.lastSoldAt < cutoff
        ? deepFreeze({ status: 'discontinued' })
        : deepFreeze({ priceCents: Math.round(record.priceCents * (100 - discountPct) / 100) }),
    }))
    .sort((left, right) => left.id.localeCompare(right.id));
  return deepFreeze(targets);
}

function required(documentRef, testId) {
  const node = documentRef.querySelector(`[data-testid="${testId}"]`);
  if (!node) throw new TypeError(`missing_${testId}`);
  return node;
}

function terminalReceipt({
  status, initialRows, reachableRows, turns, targets, statusEdits, priceEdits,
  completedEdits, undoStack, startedAt, endedAt, lostKeystrokes,
}) {
  const receipt = {
    mode: 'TUNED_DOM_ONLY',
    status,
    initialRows,
    reachableRows,
    turnsToFind: turns.length,
    matched: targets.length,
    statusEdits: statusEdits.length,
    priceEdits: priceEdits.length,
    completedEdits,
    undoDepth: undoStack.length,
    elapsedMs: Math.max(0, Number((endedAt - startedAt).toFixed(1))),
    lostKeystrokes,
  };
  if (Object.keys(receipt).some((key, index) => key !== RECEIPT_KEYS[index])) {
    throw new Error('invalid_receipt_shape');
  }
  return deepFreeze(receipt);
}

export function createClassicalDomArm({
  documentRef,
  now = () => performance.now(),
  yieldTurn,
  policy = { supplier: 'Fjord', cutoff: '2026-06-01', discountPct: 15 },
} = {}) {
  if (!documentRef || typeof documentRef.querySelector !== 'function') {
    throw new TypeError('document is required');
  }
  if (typeof now !== 'function') throw new TypeError('now must be a function');
  const catalogueBody = required(documentRef, 'catalogue-body');
  const unrig = required(documentRef, 'unrig-toggle');
  const notes = required(documentRef, 'human-notes');
  const form = required(documentRef, 'legacy-editor');
  const idInput = required(documentRef, 'legacy-id');
  const fieldInput = required(documentRef, 'legacy-field');
  const valueInput = required(documentRef, 'legacy-value');
  const submit = required(documentRef, 'legacy-submit');
  const view = documentRef.defaultView;
  const pause = yieldTurn ?? (() => new Promise((resolve) => {
    (view?.requestAnimationFrame ?? ((callback) => setTimeout(callback, 0)))(() => resolve());
  }));

  let running = false;
  let receipt = null;
  let mirror = new Map();
  const undoStack = [];
  let lostKeystrokes = 0;
  let internalController = null;

  const onKeyDown = (event) => {
    if (running && event?.isTrusted === true && event.target !== notes) lostKeystrokes += 1;
  };

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    if (!running) return;
    const id = idInput.value;
    const field = fieldInput.value;
    const raw = valueInput.value;
    const current = mirror.get(id);
    if (!current || !['status', 'priceCents'].includes(field)) throw new Error('legacy_edit_invalid');
    const nextValue = field === 'priceCents' ? Number(raw) : raw;
    if ((field === 'priceCents' && (!Number.isSafeInteger(nextValue) || nextValue < 0))
      || (field === 'status' && nextValue !== 'discontinued')) {
      throw new Error('legacy_edit_invalid');
    }
    undoStack.push(deepFreeze({ id, before: current[field], field }));
    mirror.set(id, deepFreeze({ ...current, [field]: nextValue }));
  });

  async function run({ signal } = {}) {
    if (running || receipt) throw new Error('run_unavailable');
    running = true;
    internalController = new AbortController();
    if (signal?.aborted) internalController.abort();
    signal?.addEventListener?.('abort', () => internalController.abort(), { once: true });
    lostKeystrokes = 0;
    const startedAt = now();
    const turns = [];
    let initialRows = 0;
    let reachableRows = 0;
    let targets = [];
    let statusEdits = [];
    let priceEdits = [];
    let completedEdits = 0;
    documentRef.addEventListener('keydown', onKeyDown, true);
    try {
      initialRows = catalogueBody.querySelectorAll('tr').length;
      if (initialRows !== EXPECTED_INITIAL_ROWS || unrig.checked) throw new Error('classical_initial_state');
      if (internalController.signal.aborted) throw new DOMException('Classical arm aborted', 'AbortError');
      unrig.click();
      turns.push(deepFreeze({ kind: 'dom_action', action: 'unrig' }));
      await pause();
      reachableRows = catalogueBody.querySelectorAll('tr').length;
      turns.push(deepFreeze({ kind: 'dom_snapshot', rows: reachableRows }));
      if (reachableRows !== EXPECTED_REACHABLE_ROWS) throw new Error('classical_reach_mismatch');
      const records = parseCatalogueRows(catalogueBody.querySelectorAll('tr'));
      mirror = new Map(records.map((record) => [record.id, record]));
      targets = selectPolicyTargets(records, policy);
      statusEdits = targets.filter(({ patch }) => Object.hasOwn(patch, 'status'));
      priceEdits = targets.filter(({ patch }) => Object.hasOwn(patch, 'priceCents'));
      if (targets.length !== EXPECTED_MATCHED
        || statusEdits.length !== EXPECTED_STATUS_EDITS
        || priceEdits.length !== EXPECTED_PRICE_EDITS) {
        throw new Error('classical_target_mismatch');
      }
      for (const target of targets) {
        if (internalController.signal.aborted) throw new DOMException('Classical arm aborted', 'AbortError');
        const [field, value] = Object.entries(target.patch)[0];
        idInput.value = target.id;
        fieldInput.value = field;
        valueInput.value = String(value);
        for (const node of [idInput, fieldInput, valueInput]) {
          node.dispatchEvent(new Event('input', { bubbles: true }));
        }
        valueInput.focus();
        submit.click();
        completedEdits = undoStack.length;
        await pause();
      }
      receipt = terminalReceipt({
        status: 'COMPLETE', initialRows, reachableRows, turns, targets, statusEdits, priceEdits,
        completedEdits, undoStack, startedAt, endedAt: now(), lostKeystrokes,
      });
      return receipt;
    } catch (error) {
      const aborted = error?.name === 'AbortError' || internalController.signal.aborted;
      receipt = terminalReceipt({
        status: aborted ? 'ABORTED' : 'FAILED', initialRows, reachableRows, turns, targets,
        statusEdits, priceEdits, completedEdits, undoStack, startedAt, endedAt: now(), lostKeystrokes,
      });
      if (!aborted) throw error;
      return receipt;
    } finally {
      running = false;
      documentRef.removeEventListener('keydown', onKeyDown, true);
      notes.focus();
    }
  }

  function abort() {
    internalController?.abort();
  }

  return Object.freeze({
    run,
    abort,
    getReceipt: () => receipt,
  });
}
