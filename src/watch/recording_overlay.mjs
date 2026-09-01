function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

export function formatElapsed(milliseconds) {
  const bounded = Math.max(0, Number(milliseconds) || 0);
  const tenths = Math.floor(bounded / 100);
  const minutes = Math.floor(tenths / 600);
  const seconds = Math.floor((tenths % 600) / 10);
  const fraction = tenths % 10;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${fraction}`;
}

export function renderOverlayMarkup({ title, metricLabels, stepCount }) {
  const cards = Object.entries(metricLabels).map(([key, label]) => `
    <div class="wmcp-card" data-metric-card="${escapeHtml(key)}">
      <span class="wmcp-card-label">${escapeHtml(label)}</span>
      <strong class="wmcp-card-value" data-metric-value="${escapeHtml(key)}">—</strong>
    </div>`).join('');
  return `
    <section class="wmcp-watch" aria-labelledby="wmcp-watch-title">
      <header class="wmcp-watch-header">
        <div>
          <p class="wmcp-boundary">KEYLESS REPLAY · NOT A NATIVE AGENT</p>
          <h2 id="wmcp-watch-title">${escapeHtml(title)}</h2>
        </div>
        <div class="wmcp-hero-metrics" aria-label="Replay timing and progress">
          <strong class="wmcp-clock" data-watch-clock>00:00.0</strong>
          <strong class="wmcp-step" data-watch-step>0/${Number(stepCount)}</strong>
        </div>
      </header>
      <div class="wmcp-cards" aria-label="Live entry metrics">${cards}</div>
      <div class="wmcp-controls">
        <button type="button" data-watch-start>Watch real run</button>
        <button type="button" data-watch-stop disabled>Stop</button>
        <strong data-watch-state aria-live="polite">Ready</strong>
      </div>
      <pre class="wmcp-actual" data-watch-actual aria-label="Actual live tool output">No tool called yet.</pre>
    </section>`;
}

export function mountRecordingOverlay({
  container,
  session,
  now = () => performance.now(),
  schedule = (callback) => requestAnimationFrame(callback),
  cancel = (handle) => cancelAnimationFrame(handle),
}) {
  if (!container || typeof container.querySelector !== 'function') {
    throw new TypeError('container must be a DOM element');
  }
  if (!session || typeof session.run !== 'function' || typeof session.subscribe !== 'function') {
    throw new TypeError('session must be a watch session');
  }
  container.innerHTML = renderOverlayMarkup({
    title: session.scenario.title,
    metricLabels: session.scenario.metricLabels,
    stepCount: session.scenario.steps.length,
  });
  const clockNode = container.querySelector('[data-watch-clock]');
  const stepNode = container.querySelector('[data-watch-step]');
  const stateNode = container.querySelector('[data-watch-state]');
  const actualNode = container.querySelector('[data-watch-actual]');
  const startButton = container.querySelector('[data-watch-start]');
  const stopButton = container.querySelector('[data-watch-stop]');
  let startedAt = null;
  let timerHandle = null;

  function updateClock() {
    if (startedAt === null) return;
    clockNode.textContent = formatElapsed(now() - startedAt);
    timerHandle = schedule(updateClock);
  }

  function stopClock() {
    if (timerHandle !== null) cancel(timerHandle);
    timerHandle = null;
    if (startedAt !== null) clockNode.textContent = formatElapsed(now() - startedAt);
  }

  function renderMetrics(metrics) {
    for (const key of Object.keys(session.scenario.metricLabels)) {
      const node = container.querySelector(`[data-metric-value="${key}"]`);
      node.textContent = Object.hasOwn(metrics, key) ? String(metrics[key]) : '—';
    }
  }

  const unsubscribe = session.subscribe((event) => {
    if (event.type === 'state' && event.state === 'RUNNING') {
      startedAt = now();
      stateNode.textContent = 'Running';
      startButton.disabled = true;
      stopButton.disabled = false;
      updateClock();
    }
    if (event.type === 'step-start') {
      stepNode.textContent = `${event.stepNumber - 1}/${event.stepCount}`;
      renderMetrics(event.metricsBefore);
    }
    if (event.type === 'step-pass' || event.type === 'step-fail') {
      stepNode.textContent = `${event.stepNumber}/${event.stepCount}`;
      actualNode.textContent = JSON.stringify(event.result, null, 2);
      renderMetrics(event.metricsAfter);
    }
    if (event.type === 'state' && ['PASS', 'FAIL', 'STOPPED'].includes(event.state)) {
      stopClock();
      stateNode.textContent = event.state;
      startButton.disabled = false;
      stopButton.disabled = true;
    }
  });

  async function start() {
    try {
      return await session.run();
    } catch (error) {
      if (error?.name !== 'WatchSessionError') throw error;
      return error.receipt;
    }
  }

  startButton.addEventListener('click', start);
  stopButton.addEventListener('click', () => session.stop());

  return Object.freeze({
    start,
    stop: () => session.stop(),
    destroy() {
      stopClock();
      unsubscribe();
      container.replaceChildren();
    },
  });
}
