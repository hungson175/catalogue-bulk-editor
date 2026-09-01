import { createToolRegistry } from './tool_registry.js';

const LEDGER_KEYS = Object.freeze([
  'seq',
  'ts',
  'kind',
  'op',
  'request',
  'matched',
  'staged',
  'written',
  'outcome',
  'stageId',
  'actor',
]);
const EDITABLE_FIELDS = Object.freeze(new Set(['name', 'supplier', 'lastSoldAt', 'priceCents', 'status']));

function clone(value) {
  if (value === undefined) return undefined;
  if (Array.isArray(value)) return value.map(clone);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, clone(child)]));
  }
  return value;
}

function deepFreeze(value) {
  if (typeof value === 'function') {
    return Object.freeze(value);
  }
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const key of Reflect.ownKeys(value)) {
      deepFreeze(value[key]);
    }
    Object.freeze(value);
  }
  return value;
}

function frozenCopy(value) {
  return deepFreeze(clone(value));
}

function isIsoDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
}

function validateRecord(record) {
  if (!record || typeof record !== 'object') throw new TypeError('every record must be an object');
  if (typeof record.id !== 'string' || record.id.length === 0) throw new TypeError('record id is required');
  if (typeof record.sku !== 'string' || record.sku.length === 0) throw new TypeError('record sku is required');
  if (typeof record.name !== 'string' || typeof record.supplier !== 'string') {
    throw new TypeError('record name and supplier must be strings');
  }
  if (!isIsoDate(record.lastSoldAt)) throw new TypeError('record lastSoldAt must be an ISO date');
  if (!Number.isInteger(record.priceCents) || record.priceCents < 0) {
    throw new TypeError('record priceCents must be a non-negative integer');
  }
  if (typeof record.status !== 'string' || !Number.isInteger(record._version) || record._version < 0) {
    throw new TypeError('record status and non-negative integer _version are required');
  }
}

function validPolicy(input) {
  return Boolean(
    input
      && typeof input === 'object'
      && !Array.isArray(input)
      && Object.keys(input).length === 3
      && typeof input.supplier === 'string'
      && input.supplier.length > 0
      && input.supplier.trim() === input.supplier
      && isIsoDate(input.cutoff)
      && Number.isInteger(input.discountPct)
      && input.discountPct >= 1
      && input.discountPct <= 99,
  );
}

function validClockValue(value) {
  return typeof value === 'string'
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
    && !Number.isNaN(new Date(value).valueOf());
}

export function createCatalogueState({ records, clock, isTrustedGesture } = {}) {
  if (!Array.isArray(records)) throw new TypeError('records must be an array');
  if (typeof clock !== 'function') throw new TypeError('clock must be a function');
  if (isTrustedGesture !== undefined && typeof isTrustedGesture !== 'function') {
    throw new TypeError('isTrustedGesture must be a function');
  }

  const rows = records.map((record) => {
    validateRecord(record);
    return clone(record);
  });
  const ids = rows.map((record) => record.id);
  const skus = rows.map((record) => record.sku);
  if (new Set(ids).size !== ids.length) throw new TypeError('record ids must be unique');
  if (new Set(skus).size !== skus.length) throw new TypeError('record skus must be unique');

  const recordsById = new Map(rows.map((record) => [record.id, record]));
  const ledger = [];
  const transactions = [];
  let stateVersion = Math.max(0, ...rows.map((record) => record._version));
  let stage = null;
  let stageCounter = 0;
  let editCounter = 0;
  // The injected predicate exercises state transitions only; it is not user-activation evidence.
  const gesturePredicate = isTrustedGesture ?? ((event) => (
    typeof Event !== 'undefined'
      && event instanceof Event
      && event.isTrusted === true
  ));

  function now() {
    const value = clock();
    if (!validClockValue(value)) throw new TypeError('clock must return an ISO UTC timestamp');
    return value;
  }

  function appendEntry({ kind, op, request = {}, matched = 0, staged = 0, written = 0, outcome, stageId = null, actor }) {
    const entry = {
      seq: ledger.length + 1,
      ts: now(),
      kind,
      op,
      request: clone(request),
      matched,
      staged,
      written,
      outcome,
      stageId,
      actor,
    };
    if (!LEDGER_KEYS.every((key) => Object.hasOwn(entry, key))) {
      throw new Error('ledger entry is incomplete');
    }
    ledger.push(deepFreeze(entry));
  }

  function refusal(op, request, reason, outcome, actor, stageId = stage?.stageId ?? null, extra = {}) {
    appendEntry({
      kind: 'refusal',
      op,
      request,
      written: 0,
      outcome,
      stageId,
      actor,
    });
    return frozenCopy({ ok: false, reason, written: 0, ...extra });
  }

  function trusted(event, op, request) {
    if (gesturePredicate(event) === true) return null;
    return refusal(op, request, 'gesture_required', 'refused_gesture', 'human');
  }

  function summaryAction(input = {}) {
    const supplierCounts = {};
    for (const id of ids) {
      const supplier = recordsById.get(id).supplier;
      supplierCounts[supplier] = (supplierCounts[supplier] ?? 0) + 1;
    }
    appendEntry({
      kind: 'tool',
      op: 'catalogue_summary',
      request: input,
      matched: ids.length,
      written: 0,
      outcome: 'summarized',
      actor: 'tool',
    });
    return frozenCopy({
      ok: true,
      total: ids.length,
      supplierCounts,
      viewportLimit: 30,
      unrigAvailable: true,
    });
  }

  function previewAction(input = {}) {
    if (!validPolicy(input)) {
      appendEntry({
        kind: 'tool',
        op: 'preview_supplier_policy',
        request: input,
        written: 0,
        outcome: 'invalid_input',
        actor: 'tool',
      });
      return frozenCopy({
        ok: false,
        matched: 0,
        staged: 0,
        written: 0,
        outcome: 'invalid_input',
        stageId: null,
      });
    }
    if (stage) {
      appendEntry({
        kind: 'tool',
        op: 'preview_supplier_policy',
        request: input,
        written: 0,
        outcome: 'refused_stage_active',
        stageId: stage.stageId,
        actor: 'tool',
      });
      return frozenCopy({
        ok: false,
        matched: 0,
        staged: 0,
        written: 0,
        outcome: 'refused_stage_active',
        stageId: stage.stageId,
      });
    }

    const matched = [];
    const changes = [];
    for (const id of ids) {
      const record = recordsById.get(id);
      if (record.supplier !== input.supplier) continue;
      matched.push(record);
      const patch = record.lastSoldAt < input.cutoff
        ? { status: 'discontinued' }
        : { priceCents: Math.round(record.priceCents * (100 - input.discountPct) / 100) };
      if (Object.entries(patch).every(([key, value]) => record[key] === value)) continue;
      changes.push({
        id,
        baseVersion: record._version,
        before: Object.fromEntries(Object.keys(patch).map((key) => [key, record[key]])),
        patch,
      });
    }
    changes.sort((left, right) => left.id.localeCompare(right.id));
    stageCounter += 1;
    const stageId = `stage-${String(stageCounter).padStart(4, '0')}`;
    stage = deepFreeze({
      stageId,
      request: clone(input),
      changes,
    });
    appendEntry({
      kind: 'tool',
      op: 'preview_supplier_policy',
      request: input,
      matched: matched.length,
      staged: changes.length,
      written: 0,
      outcome: 'staged',
      stageId,
      actor: 'tool',
    });
    return frozenCopy({
      ok: true,
      matched: matched.length,
      staged: changes.length,
      written: 0,
      outcome: 'staged',
      stageId,
    });
  }

  function inspectAction(input = {}) {
    const offset = Number.isInteger(input.offset) && input.offset >= 0 ? input.offset : 0;
    const requestedLimit = Number.isInteger(input.limit) && input.limit > 0 ? input.limit : 30;
    const limit = Math.min(requestedLimit, 100);
    const changes = stage ? stage.changes.slice(offset, offset + limit) : [];
    const total = stage?.changes.length ?? 0;
    appendEntry({
      kind: 'tool',
      op: 'inspect_staged_changes',
      request: input,
      matched: total,
      staged: total,
      written: 0,
      outcome: stage ? 'inspected' : 'no_stage',
      stageId: stage?.stageId ?? null,
      actor: 'tool',
    });
    return frozenCopy({
      ok: true,
      stageId: stage?.stageId ?? null,
      total,
      offset,
      limit,
      changes,
    });
  }

  function discardAction(input = {}) {
    const discarded = stage?.changes.length ?? 0;
    const stageId = stage?.stageId ?? null;
    stage = null;
    appendEntry({
      kind: 'tool',
      op: 'discard_staged_changes',
      request: input,
      matched: discarded,
      staged: discarded,
      written: 0,
      outcome: stageId ? 'discarded' : 'no_stage',
      stageId,
      actor: 'tool',
    });
    return frozenCopy({ ok: true, written: 0, outcome: stageId ? 'discarded' : 'no_stage' });
  }

  const registry = createToolRegistry({
    summary: summaryAction,
    preview: previewAction,
    inspect: inspectAction,
    discard: discardAction,
  });

  function apply(event) {
    const denied = trusted(event, 'apply', { stageId: stage?.stageId ?? null });
    if (denied) return denied;
    if (!stage) return refusal('apply', {}, 'no_stage', 'refused_no_stage', 'human', null);

    const conflicts = stage.changes
      .filter((change) => recordsById.get(change.id)?._version !== change.baseVersion)
      .map((change) => change.id);
    if (conflicts.length > 0) {
      return refusal(
        'apply',
        { stageId: stage.stageId },
        'conflict',
        'refused_conflict',
        'human',
        stage.stageId,
        { conflicts },
      );
    }

    const activeStage = stage;
    const before = activeStage.changes.map((change) => clone(recordsById.get(change.id)));
    const nextVersion = stateVersion + 1;
    for (const change of activeStage.changes) {
      const record = recordsById.get(change.id);
      Object.assign(record, clone(change.patch), { _version: nextVersion });
    }
    stateVersion = nextVersion;
    transactions.push(deepFreeze({ txId: activeStage.stageId, before }));
    stage = null;
    appendEntry({
      kind: 'human',
      op: 'apply',
      request: { stageId: activeStage.stageId },
      matched: activeStage.changes.length,
      staged: activeStage.changes.length,
      written: activeStage.changes.length,
      outcome: 'committed',
      stageId: activeStage.stageId,
      actor: 'human',
    });
    return frozenCopy({
      ok: true,
      written: activeStage.changes.length,
      txId: activeStage.stageId,
      stateVersion,
    });
  }

  function decline(event) {
    const denied = trusted(event, 'decline', { stageId: stage?.stageId ?? null });
    if (denied) return denied;
    if (!stage) return refusal('decline', {}, 'no_stage', 'refused_no_stage', 'human', null);
    const activeStage = stage;
    stage = null;
    appendEntry({
      kind: 'human',
      op: 'decline',
      request: { stageId: activeStage.stageId },
      matched: activeStage.changes.length,
      staged: activeStage.changes.length,
      written: 0,
      outcome: 'declined',
      stageId: activeStage.stageId,
      actor: 'human',
    });
    return frozenCopy({ ok: true, written: 0, outcome: 'declined' });
  }

  function undo(event) {
    const denied = trusted(event, 'undo', {});
    if (denied) return denied;
    if (transactions.length === 0) {
      return refusal('undo', {}, 'no_transaction', 'refused_no_transaction', 'human', null);
    }
    const transaction = transactions.pop();
    const nextVersion = stateVersion + 1;
    for (const previous of transaction.before) {
      recordsById.set(previous.id, { ...clone(previous), _version: nextVersion });
    }
    stateVersion = nextVersion;
    appendEntry({
      kind: 'human',
      op: 'undo',
      request: { txId: transaction.txId },
      matched: transaction.before.length,
      written: transaction.before.length,
      outcome: 'undone',
      stageId: transaction.txId,
      actor: 'human',
    });
    return frozenCopy({ ok: true, written: transaction.before.length, stateVersion });
  }

  function editRecord(event, input = {}) {
    const denied = trusted(event, 'edit_record', { id: input?.id ?? null });
    if (denied) return denied;
    const record = recordsById.get(input?.id);
    const patch = input?.patch;
    const patchKeys = patch && typeof patch === 'object' && !Array.isArray(patch) ? Object.keys(patch) : [];
    const patchAllowed = patchKeys.length > 0 && patchKeys.every((key) => EDITABLE_FIELDS.has(key));
    if (!record || !patchAllowed) {
      return refusal('edit_record', { id: input?.id ?? null }, 'invalid_input', 'refused_invalid_input', 'human');
    }
    const candidate = { ...record, ...clone(patch) };
    try {
      validateRecord(candidate);
    } catch {
      return refusal('edit_record', { id: input.id }, 'invalid_input', 'refused_invalid_input', 'human');
    }
    const before = clone(record);
    const nextVersion = stateVersion + 1;
    Object.assign(record, clone(patch), { _version: nextVersion });
    stateVersion = nextVersion;
    editCounter += 1;
    const txId = `edit-${String(editCounter).padStart(4, '0')}`;
    transactions.push(deepFreeze({ txId, before: [before] }));
    appendEntry({
      kind: 'human',
      op: 'edit_record',
      request: { id: input.id, patch },
      matched: 1,
      written: 1,
      outcome: 'edited',
      stageId: stage?.stageId ?? null,
      actor: 'human',
    });
    return frozenCopy({ ok: true, written: 1, stateVersion });
  }

  function getSnapshot() {
    return frozenCopy({
      total: ids.length,
      stagedCount: stage?.changes.length ?? 0,
      stateVersion,
      undoDepth: transactions.length,
      refusalCount: ledger.filter((entry) => entry.outcome.startsWith('refused_')).length,
      stageId: stage?.stageId ?? null,
    });
  }

  function getLedger() {
    return frozenCopy(ledger);
  }

  function getViewport({ offset = 0, limit = 30, unrigged = false } = {}) {
    const all = ids.map((id) => recordsById.get(id));
    if (unrigged === true) {
      return frozenCopy({
        rows: all,
        total: all.length,
        offset: 0,
        limit: all.length,
        unrigged: true,
        returnedCount: all.length,
      });
    }
    const safeOffset = Number.isInteger(offset) && offset >= 0 ? offset : 0;
    const safeLimit = Number.isInteger(limit) && limit >= 0 ? Math.min(limit, 30) : 30;
    const visible = all.slice(safeOffset, safeOffset + safeLimit);
    return frozenCopy({
      rows: visible,
      total: all.length,
      offset: safeOffset,
      limit: safeLimit,
      unrigged: false,
      returnedCount: visible.length,
    });
  }

  return deepFreeze({
    getSnapshot,
    getLedger,
    getViewport,
    getToolRegistry: () => registry,
    getCommandRegistry: () => registry,
    human: {
      apply,
      decline,
      undo,
      editRecord,
    },
  });
}
