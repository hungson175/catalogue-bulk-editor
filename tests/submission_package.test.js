import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const ROOT = new URL('../', import.meta.url);
const SHARED_HASHES = Object.freeze({
  'src/watch/watch_session.mjs': '068dac7be249eed04dc314d429ca1f4b371c62a47b16b1e485f98c413b6dca75',
  'src/watch/recording_overlay.mjs': 'ac9de7f1f48b9b8f1ada290c871e66dd4a5ebe67f13c8ec561780d77fe6ea1ee',
  'src/watch/recording_overlay.css': '2f3747b6457904c3395e5caa0b1205e229d6d4502adb0e070ed8af614f1c7179',
});

async function text(path) {
  return readFile(new URL(path, ROOT), 'utf8');
}

test('approved shared runtime copies retain their independently green bytes', async () => {
  for (const [path, expected] of Object.entries(SHARED_HASHES)) {
    const bytes = await readFile(new URL(path, ROOT));
    assert.equal(createHash('sha256').update(bytes).digest('hex'), expected, path);
  }
});

test('page mounts one visible watch mode after the frozen owner demo exists', async () => {
  const [html, app] = await Promise.all([text('index.html'), text('src/app.js')]);
  assert.equal((html.match(/data-testid="watch-mode"/g) ?? []).length, 1);
  assert.match(html, /src\/watch\/recording_overlay\.css/);
  assert.match(app, /mountCatalogueWatchMode/);
  const demoAt = app.indexOf('window.catalogueDemo = Object.freeze');
  const mountAt = app.indexOf('mountCatalogueWatchMode');
  const callAt = app.lastIndexOf('mountCatalogueWatchMode');
  assert.ok(demoAt > -1 && callAt > demoAt && callAt > mountAt);
  assert.equal((app.match(/window\.catalogueDemo\s*=/g) ?? []).length, 1);
});

test('anonymous public package has MIT provenance, exact local run, and honest claim boundary', async () => {
  const [readme, license, notice, ignore] = await Promise.all([
    text('README.md'), text('LICENSE'), text('NOTICE.md'), text('.gitignore'),
  ]);
  assert.match(license, /MIT License/);
  assert.doesNotMatch(`${readme}\n${license}\n${notice}`, /TODO|TBD|PLACEHOLDER/i);
  assert.match(readme, /python3 -m http\.server 4173 --bind 127\.0\.0\.1/);
  assert.match(readme, /KEYLESS REPLAY · NOT A NATIVE AGENT/);
  assert.match(readme, /5 adapter calls/);
  assert.match(readme, /9 zero-written ledger rows/);
  assert.match(readme, /https:\/\/hungson175\.github\.io\/catalogue-bulk-editor\//);
  assert.match(readme, /public origin[\s\S]*pending/i);
  assert.match(readme, /native agent[\s\S]*UNPROVEN/i);
  assert.match(readme, /public repository[\s\S]*pending/i);
  assert.match(readme, /video[\s\S]*pending/i);
  assert.match(notice, /webmcp-submission-kit/);
  assert.match(notice, /MIT/);
  for (const pattern of ['.env', 'profile', 'receipt', '*.mp4', '__pycache__']) {
    assert.ok(ignore.includes(pattern), `missing ignore ${pattern}`);
  }
  assert.doesNotMatch(ignore, /(^|\n)(src|tests|README\.md|LICENSE|NOTICE\.md)(\/|$)/);
});

test('public sources contain no credential, private path, model, backend, or remote runtime seam', async () => {
  const paths = [
    'index.html', 'styles.css', 'src/app.js', 'src/watch_mode.js',
    'src/watch/recording_overlay.mjs',
  ];
  const source = (await Promise.all(paths.map(text))).join('\n');
  assert.doesNotMatch(source, /\/home\/|\/tmp\/|process\.env|api[_-]?key|authorization|cookie|localStorage|sessionStorage|indexedDB/i);
  assert.doesNotMatch(source, /\bfetch\b|XMLHttpRequest|WebSocket|EventSource|serviceWorker|deepseek|openai|anthropic/i);
  assert.doesNotMatch(source, /<script[^>]+src=["']https?:|import\s+[^;]+from\s+["']https?:/i);
});
