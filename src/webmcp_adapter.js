const EXPECTED_TOOL_COUNT = 4;
const SAFE_NAME = /^[A-Za-z0-9_.-]{1,128}$/;
const FORBIDDEN_NAME = /apply|commit|approve|release|undo|human|edit/i;
const FORBIDDEN_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const DECLARATION_KEYS = new Set([
  'name', 'description', 'inputSchema', 'annotations', 'handler',
]);
const ANNOTATION_KEYS = new Set(['readOnlyHint']);
const registrationCache = new WeakMap();

function isPlainObject(value) {
  if (value === null || typeof value !== 'object') return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function containsForbiddenKey(value, seen = new Set()) {
  if (Array.isArray(value)) {
    if (seen.has(value)) return false;
    seen.add(value);
    return value.some((child) => containsForbiddenKey(child, seen));
  }
  if (!isPlainObject(value)) return false;
  if (seen.has(value)) return false;
  seen.add(value);
  return Object.entries(value).some(
    ([key, child]) => FORBIDDEN_KEYS.has(key) || containsForbiddenKey(child, seen),
  );
}

function deepFreeze(value) {
  if ((value && typeof value === 'object') || typeof value === 'function') {
    if (!Object.isFrozen(value)) {
      for (const child of Reflect.ownKeys(value)) deepFreeze(value[child]);
      Object.freeze(value);
    }
  }
  return value;
}

function cloneJson(value, label) {
  if (containsForbiddenKey(value)) throw new TypeError(`${label} is unsafe`);
  let encoded;
  try {
    encoded = JSON.stringify(value);
  } catch {
    throw new TypeError(`${label} is not JSON data`);
  }
  if (encoded === undefined) throw new TypeError(`${label} is not JSON data`);
  return JSON.parse(encoded);
}

function validSchema(schema) {
  if (!isPlainObject(schema) || containsForbiddenKey(schema) || schema.type !== 'object') return false;
  if ('properties' in schema && !isPlainObject(schema.properties)) return false;
  if ('required' in schema) {
    if (!Array.isArray(schema.required) || !schema.required.every((name) => typeof name === 'string')) {
      return false;
    }
  }
  try {
    return JSON.stringify(schema) !== undefined;
  } catch {
    return false;
  }
}

function validateRegistry(registry) {
  if (!Array.isArray(registry) || registry.length !== EXPECTED_TOOL_COUNT || !Object.isFrozen(registry)) {
    return false;
  }
  const names = new Set();
  for (const declaration of registry) {
    if (!isPlainObject(declaration) || !Object.isFrozen(declaration)) return false;
    const keys = Object.keys(declaration);
    if (keys.length !== DECLARATION_KEYS.size || keys.some((key) => !DECLARATION_KEYS.has(key))) {
      return false;
    }
    if (
      typeof declaration.name !== 'string'
      || !SAFE_NAME.test(declaration.name)
      || FORBIDDEN_KEYS.has(declaration.name)
      || FORBIDDEN_NAME.test(declaration.name)
      || names.has(declaration.name)
    ) return false;
    names.add(declaration.name);
    if (typeof declaration.description !== 'string' || declaration.description.trim() === '') return false;
    if (!validSchema(declaration.inputSchema) || !Object.isFrozen(declaration.inputSchema)) return false;
    if (!isPlainObject(declaration.annotations) || !Object.isFrozen(declaration.annotations)) return false;
    const annotationKeys = Object.keys(declaration.annotations);
    if (
      annotationKeys.length !== 1
      || annotationKeys.some((key) => !ANNOTATION_KEYS.has(key))
      || typeof declaration.annotations.readOnlyHint !== 'boolean'
    ) return false;
    if (typeof declaration.handler !== 'function') return false;
  }
  return true;
}

function makeReceipt(state, registered = [], errors = []) {
  return deepFreeze({ state, registered: [...registered], errors: [...errors] });
}

function abortError() {
  return new DOMException('Tool execution aborted', 'AbortError');
}

function makeDescriptor(declaration, executeTool) {
  const inputSchema = deepFreeze(cloneJson(declaration.inputSchema, 'inputSchema'));
  const annotations = deepFreeze(cloneJson(declaration.annotations, 'annotations'));
  const execute = async (input = {}, { signal } = {}) => {
    if (signal?.aborted) throw abortError();
    let result;
    try {
      result = await executeTool({
        name: declaration.name,
        input: cloneJson(input, 'tool input'),
      });
    } catch (error) {
      if (signal?.aborted || error?.name === 'AbortError') throw abortError();
      throw new Error('tool_execution_failed');
    }
    if (signal?.aborted) throw abortError();
    try {
      return deepFreeze(cloneJson(result, 'tool result'));
    } catch {
      throw new Error('tool_execution_failed');
    }
  };
  return deepFreeze({
    name: declaration.name,
    description: declaration.description,
    inputSchema,
    annotations,
    execute,
  });
}

async function registerOnce({ documentRef, registry, executeTool, registrationController }) {
  let modelContext;
  try {
    modelContext = documentRef?.modelContext;
  } catch {
    return makeReceipt('unsupported');
  }
  if (!modelContext || typeof modelContext.registerTool !== 'function') {
    return makeReceipt('unsupported');
  }
  if (
    !validateRegistry(registry)
    || typeof executeTool !== 'function'
    || !registrationController
    || typeof registrationController.abort !== 'function'
    || !registrationController.signal
  ) {
    return makeReceipt('failed', [], ['invalid_registry']);
  }

  const registered = [];
  try {
    for (const declaration of registry) {
      const descriptor = makeDescriptor(declaration, executeTool);
      await modelContext.registerTool(descriptor, {
        signal: registrationController.signal,
      });
      registered.push(declaration.name);
    }
  } catch {
    registrationController.abort();
    return makeReceipt('failed', [], ['registration_failed']);
  }
  return makeReceipt('registered', registered);
}

export async function registerCatalogueWebMCP(options = {}) {
  const { documentRef } = options;
  if (!documentRef || (typeof documentRef !== 'object' && typeof documentRef !== 'function')) {
    return makeReceipt('unsupported');
  }
  const existing = registrationCache.get(documentRef);
  if (existing) return existing;
  const pending = registerOnce(options);
  registrationCache.set(documentRef, pending);
  return pending;
}
