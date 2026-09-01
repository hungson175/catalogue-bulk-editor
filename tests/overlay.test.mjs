import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

const MODULE_URL = new URL('../src/watch/recording_overlay.mjs', import.meta.url);
const CSS_URL = new URL('../src/watch/recording_overlay.css', import.meta.url);

async function loadModule() {
  try {
    return await import(MODULE_URL.href);
  } catch (error) {
    assert.fail(`required overlay module is missing or invalid: ${error.message}`);
  }
}

test('elapsed time is monotonic mm:ss.S and never uses wall-clock Date', async () => {
  const { formatElapsed } = await loadModule();
  assert.equal(formatElapsed(0), '00:00.0');
  assert.equal(formatElapsed(61_234), '01:01.2');
  assert.equal(formatElapsed(-5), '00:00.0');
  const source = await readFile(MODULE_URL, 'utf8');
  assert.doesNotMatch(source, /Date\.now/);
  assert.match(source, /performance\.now/);
});

test('overlay markup is accessible, honest, escaped, and scenario-counted', async () => {
  const { renderOverlayMarkup } = await loadModule();
  const html = renderOverlayMarkup({
    title: '<unsafe>',
    metricLabels: { selected: 'Selected', changed: 'Changed' },
    stepCount: 3,
  });
  assert.match(html, /KEYLESS REPLAY · NOT A NATIVE AGENT/);
  assert.match(html, /aria-live="polite"/);
  assert.match(html, /type="button"/);
  assert.match(html, /0\/3/);
  assert.match(html, /&lt;unsafe&gt;/);
  assert.doesNotMatch(html, /<unsafe>/);
});

test('recording CSS keeps clock and step count large, high contrast, and viewport-safe', async () => {
  const css = await readFile(CSS_URL, 'utf8');
  assert.match(css, /font-size:\s*(?:3rem|48px)/);
  assert.match(css, /min\(100%/);
  assert.match(css, /@media\s*\(max-width:\s*720px\)/);
  assert.match(css, /prefers-reduced-motion/);
});

