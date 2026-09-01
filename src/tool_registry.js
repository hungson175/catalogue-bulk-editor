function deepFreeze(value) {
  if (typeof value === 'function') {
    return Object.freeze(value);
  }
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Reflect.ownKeys(value)) {
      deepFreeze(value[child]);
    }
    Object.freeze(value);
  }
  return value;
}

export function createToolRegistry(actions) {
  if (!actions || ['summary', 'preview', 'inspect', 'discard'].some((name) => typeof actions[name] !== 'function')) {
    throw new TypeError('four tool actions are required');
  }

  function summaryHandler(input = {}) {
    return actions.summary(input);
  }

  function previewHandler(input = {}) {
    return actions.preview(input);
  }

  function inspectHandler(input = {}) {
    return actions.inspect(input);
  }

  function discardHandler(input = {}) {
    return actions.discard(input);
  }

  return deepFreeze([
    {
      name: 'catalogue_summary',
      description: 'Summarize catalogue size, suppliers, and the virtualized viewport boundary.',
      inputSchema: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true },
      handler: summaryHandler,
    },
    {
      name: 'preview_supplier_policy',
      description: 'Stage a supplier policy preview without changing catalogue records.',
      inputSchema: {
        type: 'object',
        properties: {
          supplier: { type: 'string', minLength: 1 },
          cutoff: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
          discountPct: { type: 'integer', minimum: 1, maximum: 99 },
        },
        required: ['supplier', 'cutoff', 'discountPct'],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false },
      handler: previewHandler,
    },
    {
      name: 'inspect_staged_changes',
      description: 'Inspect a bounded page from the current immutable staged changeset.',
      inputSchema: {
        type: 'object',
        properties: {
          offset: { type: 'integer', minimum: 0 },
          limit: { type: 'integer', minimum: 1, maximum: 100 },
        },
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true },
      handler: inspectHandler,
    },
    {
      name: 'discard_staged_changes',
      description: 'Discard the complete staged preview without changing catalogue records.',
      inputSchema: {
        type: 'object',
        properties: {
          reason: { type: 'string', maxLength: 200 },
        },
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false },
      handler: discardHandler,
    },
  ]);
}
