import { createClassicalDomArm } from './classical_dom_arm.js';

const EXPECTED_TOOLS = Object.freeze([
  'catalogue_summary',
  'discard_staged_changes',
  'inspect_staged_changes',
  'preview_supplier_policy',
]);
const WEB_RECEIPT_KEYS = Object.freeze([
  'mode', 'status', 'pageOwnedRecords', 'turnsToFind', 'matched', 'inspected',
  'stageElapsedMs', 'undoDepth', 'lostKeystrokes', 'nativeAgent',
]);

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function safeClone(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('invalid_tool_result');
  const clone = JSON.parse(JSON.stringify(value));
  return deepFreeze(clone);
}

export function normalizeToolResult(raw) {
  try {
    return safeClone(typeof raw === 'string' ? JSON.parse(raw) : raw);
  } catch {
    throw new TypeError('invalid_tool_result');
  }
}

function required(documentRef, testId) {
  const node = documentRef.querySelector(`[data-testid="${testId}"]`);
  if (!node) throw new TypeError(`missing_${testId}`);
  return node;
}

function numberFrom(node, prefix = '') {
  const value = node.textContent.trim().replace(prefix, '').replaceAll(',', '');
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) throw new TypeError('invalid_live_counter');
  return parsed;
}

function receiptFrom(values) {
  if (Object.keys(values).some((key, index) => key !== WEB_RECEIPT_KEYS[index])) {
    throw new Error('invalid_web_receipt_shape');
  }
  return deepFreeze(values);
}

export function createWebMcpArm({
  documentRef,
  now = () => performance.now(),
  yieldTurn,
  onReceipt = () => {},
} = {}) {
  if (!documentRef || typeof documentRef.querySelector !== 'function') {
    throw new TypeError('document is required');
  }
  const notes = required(documentRef, 'human-notes');
  const apply = required(documentRef, 'apply-changes');
  const staged = required(documentRef, 'staged-count');
  const written = required(documentRef, 'written-count');
  const undo = required(documentRef, 'undo-depth');
  const version = required(documentRef, 'state-version');
  const view = documentRef.defaultView;
  const pause = yieldTurn ?? (() => new Promise((resolve) => {
    (view?.requestAnimationFrame ?? ((callback) => setTimeout(callback, 0)))(() => resolve());
  }));

  let running = false;
  let receipt = null;
  let lostKeystrokes = 0;

  const onKeyDown = (event) => {
    if (running && event?.isTrusted === true && event.target !== notes) lostKeystrokes += 1;
  };

  async function run() {
    if (running || receipt) throw new Error('run_unavailable');
    const modelContext = documentRef.modelContext;
    if (!modelContext || typeof modelContext.getTools !== 'function'
      || typeof modelContext.executeTool !== 'function') {
      throw new Error('model_context_unavailable');
    }
    if (numberFrom(staged) !== 0 || numberFrom(written) !== 0 || numberFrom(undo) !== 0
      || numberFrom(version, 'v') !== 0) {
      throw new Error('webmcp_initial_state');
    }
    running = true;
    lostKeystrokes = 0;
    documentRef.addEventListener('keydown', onKeyDown, true);
    const startedAt = now();
    try {
      await pause();
      const tools = await modelContext.getTools();
      const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]));
      if (Object.keys(byName).sort().join('|') !== EXPECTED_TOOLS.join('|')) {
        throw new Error('webmcp_tool_mismatch');
      }
      const readOnly = Object.fromEntries(tools.map((tool) => [tool.name, tool.annotations?.readOnlyHint]));
      if (readOnly.catalogue_summary !== true || readOnly.inspect_staged_changes !== true
        || readOnly.preview_supplier_policy !== false || readOnly.discard_staged_changes !== false) {
        throw new Error('webmcp_annotation_mismatch');
      }
      const execute = async (name, input) => {
        const raw = await modelContext.executeTool(byName[name], JSON.stringify(input));
        await pause();
        return normalizeToolResult(raw);
      };
      const discoveryTurns = [];
      const summary = await execute('catalogue_summary', {});
      discoveryTurns.push('catalogue_summary');
      const preview = await execute('preview_supplier_policy', {
        supplier: 'Fjord', cutoff: '2026-06-01', discountPct: 15,
      });
      discoveryTurns.push('preview_supplier_policy');
      const inspect = await execute('inspect_staged_changes', { offset: 0, limit: 20 });
      const pageOwnedRecords = summary?.result?.total;
      const matched = preview?.result?.matched;
      const inspected = inspect?.result?.changes?.length;
      if (pageOwnedRecords !== 14_000 || matched !== 340 || preview?.result?.written !== 0
        || inspect?.result?.total !== 340 || inspected !== 20
        || numberFrom(staged) !== matched || numberFrom(written) !== 0) {
        throw new Error('webmcp_result_mismatch');
      }
      receipt = receiptFrom({
        mode: 'WEBMCP_BROWSER_API',
        status: 'READY_FOR_HUMAN_RELEASE',
        pageOwnedRecords,
        turnsToFind: discoveryTurns.length,
        matched,
        inspected,
        stageElapsedMs: Math.max(0, Number((now() - startedAt).toFixed(1))),
        undoDepth: numberFrom(undo),
        lostKeystrokes,
        nativeAgent: 'UNPROVEN',
      });
      onReceipt(receipt);
      return receipt;
    } finally {
      running = false;
      documentRef.removeEventListener('keydown', onKeyDown, true);
    }
  }

  apply.addEventListener('click', () => {
    queueMicrotask(() => {
      if (receipt?.status !== 'READY_FOR_HUMAN_RELEASE') return;
      const undoDepth = numberFrom(undo);
      if (numberFrom(staged) !== 0 || numberFrom(written) !== 340
        || numberFrom(version, 'v') !== 1 || undoDepth !== 1) return;
      receipt = receiptFrom({
        ...receipt,
        status: 'COMPLETE',
        undoDepth,
      });
      onReceipt(receipt);
    });
  });

  return Object.freeze({ run, getReceipt: () => receipt });
}

function setText(documentRef, testId, value) {
  required(documentRef, testId).textContent = String(value);
}

function renderClassical(documentRef, receipt) {
  setText(documentRef, 'classical-status', receipt.status);
  setText(documentRef, 'classical-reach', `${receipt.initialRows} → ${receipt.reachableRows.toLocaleString('en-US')} (Unrig)`);
  setText(documentRef, 'classical-turns', `${receipt.turnsToFind} · Unrig + one snapshot`);
  setText(documentRef, 'classical-time', `${receipt.elapsedMs.toFixed(1)} ms`);
  setText(documentRef, 'classical-undo', receipt.undoDepth);
  setText(documentRef, 'classical-lost', receipt.lostKeystrokes);
}

function renderWeb(documentRef, receipt) {
  setText(documentRef, 'webmcp-arm-status', receipt.status.replaceAll('_', ' '));
  setText(documentRef, 'webmcp-reach', `${receipt.pageOwnedRecords.toLocaleString('en-US')} page-owned records`);
  setText(documentRef, 'webmcp-turns', `${receipt.turnsToFind} · summary + preview`);
  setText(documentRef, 'webmcp-time', `${receipt.stageElapsedMs.toFixed(1)} ms`);
  setText(documentRef, 'webmcp-undo', receipt.status === 'COMPLETE'
    ? `${receipt.undoDepth} (after human Apply)`
    : 'READY FOR HUMAN RELEASE');
  setText(documentRef, 'webmcp-lost', receipt.lostKeystrokes);
}

export function mountHeadToHead({ documentRef } = {}) {
  if (!documentRef || typeof documentRef.querySelector !== 'function') {
    throw new TypeError('document is required');
  }
  const section = required(documentRef, 'head-to-head');
  const classicalButton = required(documentRef, 'run-classical');
  const webButton = required(documentRef, 'run-webmcp');
  const classical = createClassicalDomArm({ documentRef });
  const web = createWebMcpArm({
    documentRef,
    onReceipt: (receipt) => renderWeb(documentRef, receipt),
  });

  classicalButton.addEventListener('click', async () => {
    classicalButton.disabled = true;
    webButton.disabled = true;
    setText(documentRef, 'classical-status', 'RUNNING');
    section.dataset.activeArm = 'classical';
    try {
      renderClassical(documentRef, await classical.run());
    } catch {
      setText(documentRef, 'classical-status', 'FAILED');
    } finally {
      section.dataset.activeArm = '';
      webButton.disabled = false;
    }
  });

  webButton.addEventListener('click', async () => {
    classicalButton.disabled = true;
    webButton.disabled = true;
    setText(documentRef, 'webmcp-arm-status', 'RUNNING · NOT A NATIVE AGENT');
    section.dataset.activeArm = 'webmcp';
    try {
      await web.run();
    } catch {
      setText(documentRef, 'webmcp-arm-status', 'FAILED');
      classicalButton.disabled = false;
      webButton.disabled = false;
    } finally {
      section.dataset.activeArm = '';
    }
  });

  const surface = Object.freeze({
    getClassicalReceipt: classical.getReceipt,
    getWebMcpReceipt: web.getReceipt,
  });
  window.headToHead = surface;
  return surface;
}
