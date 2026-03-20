/**
 * Matrix Analysis — client-side application.
 *
 * All filtering, sorting, grouping, and rendering happens in the browser.
 * Data is fetched via the adapter (GitHub Pages or local server).
 */

import { adapter, getDataMode, canRefresh } from './data-adapter.js';

// ─── Constants ───────────────────────────────────────────

const DIMENSIONS = [
  { key: 'cluster', label: 'Cluster' },
  { key: 'sdkLanguage', label: 'Language' },
  { key: 'sdkMode', label: 'Mode' },
  { key: 'handlerType', label: 'Handler' },
  { key: 'totalWorkers', label: 'Total Workers' },
  { key: 'workersPerProcess', label: 'Workers/Process' },
  { key: 'processes', label: 'Processes' },
];

const BASE_METRICS = [
  { key: 'aggregateThroughput', label: 'Throughput', format: (v) => v != null ? v.toFixed(1) : '—', unit: 'ops/s' },
  { key: 'totalCompleted', label: 'Completed', format: (v) => v != null ? v.toLocaleString() : '—' },
  { key: 'totalErrors', label: 'Errors', format: (v) => v != null ? v.toLocaleString() : '—' },
  { key: 'errorRate', label: 'Error Rate', format: (v) => v != null ? v.toFixed(2) + '%' : '—', computed: true },
  { key: 'wallClockS', label: 'Wall Clock', format: (v) => v != null ? v.toFixed(1) + 's' : '—' },
  { key: 'jainFairness', label: 'Fairness', format: (v) => v != null ? v.toFixed(4) : '—' },
  { key: 'status', label: 'Status', format: (v) => v || '—' },
  { key: 'serverCpuAvg', label: 'Srv CPU Avg', format: (v) => v != null ? (v * 100).toFixed(1) + '%' : '—', nested: true },
  { key: 'serverCpuPeak', label: 'Srv CPU Peak', format: (v) => v != null ? (v * 100).toFixed(1) + '%' : '—', nested: true },
  { key: 'serverMemAvgMb', label: 'Srv Mem Avg', format: (v) => v != null ? v.toFixed(0) + ' MB' : '—', nested: true },
  { key: 'serverMemPeakMb', label: 'Srv Mem Peak', format: (v) => v != null ? v.toFixed(0) + ' MB' : '—', nested: true },
  { key: 'serverThreadsAvg', label: 'Srv Threads', format: (v) => v != null ? Math.round(v).toString() : '—', nested: true },
  { key: 'serverDiskUsedAvgGb', label: 'Srv Disk Avg', format: (v) => v != null ? v.toFixed(2) + ' GB' : '—', nested: true },
  { key: 'serverDiskUsedPeakGb', label: 'Srv Disk Peak', format: (v) => v != null ? v.toFixed(2) + ' GB' : '—', nested: true },
  { key: 'serverDiskPctPeak', label: 'Srv Disk %', format: (v) => v != null ? v.toFixed(1) + '%' : '—', nested: true },
  { key: 'clientMemAvgMb', label: 'Client Mem Avg', format: (v) => v != null ? v.toFixed(1) + ' MB' : '—', computed: true },
  { key: 'clientMemPeakMb', label: 'Client Mem Peak', format: (v) => v != null ? v.toFixed(1) + ' MB' : '—', computed: true },
];

// Dynamic error category metrics — rebuilt when data loads
let errorCategoryMetrics = [];

/** All metrics = base + dynamic error categories. */
function getMetrics() {
  return [...BASE_METRICS, ...errorCategoryMetrics];
}

const DEFAULT_VISIBLE_METRICS = new Set([
  'aggregateThroughput', 'totalCompleted', 'totalErrors', 'wallClockS', 'jainFairness', 'status',
]);

// ─── State ───────────────────────────────────────────────

let allData = [];          // Raw ScenarioResult[] for current run (A side)
let enrichedData = [];     // With computed fields
let filteredData = [];     // After dimension filters
let allDataB = [];         // Raw ScenarioResult[] for B side
let enrichedDataB = [];
let filteredDataB = [];
let currentTab = 'explorer';
let currentOutputFormat = 'html';
let sortColumn = 'aggregateThroughput';
let sortAsc = false;
let abSyncRows = false;

// Filter state: dimension key -> Set of selected values
const filters = {};
// Metric visibility: metric key -> boolean
const visibleMetrics = new Set(DEFAULT_VISIBLE_METRICS);

// ─── localStorage Keys ───────────────────────────────────

const LS_VIEW_STATE = 'matrix-analysis-view-state';
const LS_SAVED_VIEWS = 'matrix-analysis-saved-views';

// ─── URL Hash State ──────────────────────────────────────

/** Short keys for dimension filters in URL hash. */
const DIM_URL_KEY = {
  cluster: 'cluster', sdkLanguage: 'lang', sdkMode: 'mode', handlerType: 'handler',
  totalWorkers: 'workers', workersPerProcess: 'wpp', processes: 'procs',
};
const URL_KEY_DIM = Object.fromEntries(Object.entries(DIM_URL_KEY).map(([k, v]) => [v, k]));

/** Serialize current view state to a URL hash string. */
function stateToHash(state) {
  const p = new URLSearchParams();
  if (state.runId) p.set('a', state.runId);
  if (state.runIdB) p.set('b', state.runIdB);
  if (state.currentTab && state.currentTab !== 'explorer') p.set('tab', state.currentTab);
  if (state.sortColumn && state.sortColumn !== 'aggregateThroughput') p.set('sort', state.sortColumn);
  if (state.sortAsc) p.set('order', 'asc');
  if (state.groupBy) p.set('group', state.groupBy);
  if (state.abSyncRows) p.set('sync', '1');
  // Filters: only encode dimensions where not all values are selected
  if (state.filters) {
    for (const dim of DIMENSIONS) {
      const vals = state.filters[dim.key];
      if (!vals || vals.length === 0) continue;
      // If this dimension has fewer selected than available, encode it
      const allVals = enrichedData.length > 0
        ? [...new Set(enrichedData.map(d => d[dim.key]))]
        : [];
      if (allVals.length > 0 && vals.length < allVals.length) {
        p.set(DIM_URL_KEY[dim.key], vals.map(String).join(','));
      }
    }
  }
  // Visible metrics: only encode if different from defaults
  if (state.visibleMetrics) {
    const current = new Set(state.visibleMetrics);
    const isDefault = current.size === DEFAULT_VISIBLE_METRICS.size &&
      [...DEFAULT_VISIBLE_METRICS].every(k => current.has(k));
    if (!isDefault) {
      p.set('cols', state.visibleMetrics.join(','));
    }
  }
  return p.toString();
}

/** Parse a URL hash string into a partial state object. */
function hashToState(hash) {
  const h = hash.startsWith('#') ? hash.slice(1) : hash;
  if (!h) return null;
  const p = new URLSearchParams(h);
  const state = {};
  if (p.has('a')) state.runId = p.get('a');
  if (p.has('b')) state.runIdB = p.get('b');
  if (p.has('tab')) state.currentTab = p.get('tab');
  if (p.has('sort')) state.sortColumn = p.get('sort');
  if (p.has('order')) state.sortAsc = p.get('order') === 'asc';
  if (p.has('group')) state.groupBy = p.get('group');
  if (p.has('sync')) state.abSyncRows = p.get('sync') === '1';
  // Filters
  const filters = {};
  for (const [urlKey, dimKey] of Object.entries(URL_KEY_DIM)) {
    if (p.has(urlKey)) {
      const raw = p.get(urlKey).split(',').filter(Boolean);
      // Attempt numeric conversion for numeric dimensions
      filters[dimKey] = raw.map(v => isNaN(v) ? v : Number(v));
    }
  }
  if (Object.keys(filters).length > 0) state.filters = filters;
  // Visible metrics
  if (p.has('cols')) {
    state.visibleMetrics = p.get('cols').split(',').filter(Boolean);
  }
  return state;
}

/** Update the URL hash without triggering navigation. */
function syncUrlHash() {
  const hash = stateToHash(captureViewState());
  const newUrl = hash ? `#${hash}` : window.location.pathname + window.location.search;
  history.replaceState(null, '', newUrl);
}

// ─── DOM Refs ────────────────────────────────────────────

const runSelect = document.getElementById('run-select');
const refreshBtn = document.getElementById('refresh-btn');
const statusEl = document.getElementById('status');
const filterGroupsEl = document.getElementById('filter-groups');
const metricTogglesEl = document.getElementById('metric-toggles');
const comparisonControls = document.getElementById('comparison-controls');
const tableContainer = document.getElementById('table-container');
const loadingMsg = document.getElementById('loading-msg');
const dataTable = document.getElementById('data-table');
const tableHead = document.getElementById('table-head');
const tableBody = document.getElementById('table-body');
const outputSection = document.getElementById('output-section');
const outputContent = document.getElementById('output-content');
const groupBySelect = document.getElementById('group-by');
const sortBySelect = document.getElementById('sort-by');
const sortOrderSelect = document.getElementById('sort-order');
const savedViewsList = document.getElementById('saved-views-list');
const saveViewBtn = document.getElementById('save-view-btn');

// A/B compare DOM refs
const abControls = document.getElementById('ab-controls');
const runSelectB = document.getElementById('run-select-b');
const abContainer = document.getElementById('ab-container');
const shareBtn = document.getElementById('share-btn');

// ─── View State Persistence ──────────────────────────────

/** Capture the current view state as a serializable object. */
function captureViewState() {
  const filterState = {};
  for (const dim of DIMENSIONS) {
    if (filters[dim.key]) {
      filterState[dim.key] = [...filters[dim.key]];
    }
  }
  return {
    runId: runSelect.value || null,
    runIdB: runSelectB.value || null,
    currentTab,
    currentOutputFormat,
    sortColumn,
    sortAsc,
    abSyncRows,
    visibleMetrics: [...visibleMetrics],
    filters: filterState,
    groupBy: groupBySelect.value || '',
  };
}

/** Apply a saved view state object to the UI. */
function applyViewState(state) {
  if (!state) return;
  if (state.currentTab) {
    currentTab = state.currentTab;
    document.querySelectorAll('#view-tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === currentTab));
    document.getElementById('sidebar').classList.toggle('hidden', currentTab === 'comparison' || currentTab === 'insights');
    comparisonControls.classList.toggle('hidden', currentTab === 'explorer' || currentTab === 'ab' || currentTab === 'insights');
    abControls.classList.toggle('hidden', currentTab !== 'ab');
    abContainer.classList.toggle('hidden', currentTab !== 'ab');
    tableContainer.classList.toggle('hidden', currentTab === 'ab' || currentTab === 'insights');
    document.getElementById('insights-container').classList.toggle('hidden', currentTab !== 'insights');
    document.getElementById('metric-toggles').classList.toggle('hidden', currentTab === 'insights');
  }
  if (state.currentOutputFormat) currentOutputFormat = state.currentOutputFormat;
  if (state.sortColumn) sortColumn = state.sortColumn;
  if (state.sortAsc !== undefined) sortAsc = state.sortAsc;
  if (state.visibleMetrics) {
    visibleMetrics.clear();
    for (const k of state.visibleMetrics) visibleMetrics.add(k);
  }
  if (state.abSyncRows !== undefined) {
    abSyncRows = state.abSyncRows;
    document.getElementById('ab-sync-toggle').checked = abSyncRows;
  }
  // Filters will be restored after data loads (they depend on data values)
}

/** Restore filter selections from a state snapshot (call after buildFilters). */
function restoreFiltersFromState(state) {
  if (!state || !state.filters) return;
  for (const dim of DIMENSIONS) {
    if (state.filters[dim.key]) {
      const allowed = new Set(state.filters[dim.key].map((v) => typeof v === 'string' ? v : v));
      // Intersect with available values so stale entries don't break anything
      const available = new Set(enrichedData.map((d) => d[dim.key]));
      filters[dim.key] = new Set([...allowed].filter((v) => available.has(v)));
    }
  }
  // Sync checkboxes
  for (const cb of filterGroupsEl.querySelectorAll('input[type="checkbox"]')) {
    const dimKey = cb.dataset.dim;
    const val = isNaN(cb.dataset.val) ? cb.dataset.val : Number(cb.dataset.val);
    cb.checked = filters[dimKey] && filters[dimKey].has(val);
  }
  if (state.groupBy !== undefined) groupBySelect.value = state.groupBy;
}

/** Persist current view state to localStorage (debounced). */
let _saveTimer = null;
function persistViewState() {
  clearTimeout(_saveTimer);
  _saveTimer = setTimeout(() => {
    try { localStorage.setItem(LS_VIEW_STATE, JSON.stringify(captureViewState())); } catch {}
    syncUrlHash();
  }, 300);
}

function loadPersistedViewState() {
  try {
    const raw = localStorage.getItem(LS_VIEW_STATE);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

// ─── Saved (Named) Views ─────────────────────────────────

function getSavedViews() {
  try {
    const raw = localStorage.getItem(LS_SAVED_VIEWS);
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
}

function setSavedViews(views) {
  try { localStorage.setItem(LS_SAVED_VIEWS, JSON.stringify(views)); } catch {}
}

function renderSavedViews() {
  const views = getSavedViews();
  savedViewsList.innerHTML = '';
  for (const v of views) {
    const chip = document.createElement('span');
    chip.className = 'view-chip';
    chip.title = `Load view "${v.name}"`;

    const nameSpan = document.createElement('span');
    nameSpan.textContent = v.name;
    nameSpan.addEventListener('click', () => loadSavedView(v));
    chip.appendChild(nameSpan);

    const del = document.createElement('button');
    del.className = 'delete-view';
    del.textContent = '\u00d7';
    del.title = `Delete "${v.name}"`;
    del.addEventListener('click', (e) => {
      e.stopPropagation();
      deleteSavedView(v.name);
    });
    chip.appendChild(del);

    savedViewsList.appendChild(chip);
  }
}

function saveCurrentView() {
  const name = prompt('View name:');
  if (!name || !name.trim()) return;
  const views = getSavedViews();
  // Overwrite if same name exists
  const existing = views.findIndex((v) => v.name === name.trim());
  const entry = { name: name.trim(), state: captureViewState() };
  if (existing >= 0) views[existing] = entry;
  else views.push(entry);
  setSavedViews(views);
  renderSavedViews();
}

function loadSavedView(view) {
  applyViewState(view.state);
  // If run changed, load it
  if (view.state.runId && view.state.runId !== runSelect.value) {
    runSelect.value = view.state.runId;
    loadSelectedRun(false, view.state);
  } else {
    // Same run — just restore filters and re-render
    buildMetricToggles();
    restoreFiltersFromState(view.state);
    applyFilters();
    persistViewState();
  }
}

function deleteSavedView(name) {
  const views = getSavedViews().filter((v) => v.name !== name);
  setSavedViews(views);
  renderSavedViews();
}

// ─── Init ────────────────────────────────────────────────

async function init() {
  // Restore state: URL hash takes priority, then localStorage
  const urlState = hashToState(window.location.hash);
  const savedState = urlState || loadPersistedViewState();
  if (savedState) applyViewState(savedState);

  // Hide refresh button when GCS is not available (GitHub Pages mode)
  if (!canRefresh()) {
    refreshBtn.style.display = 'none';
  }

  // Load run list
  setStatus(`Loading runs (${getDataMode()} mode)...`);
  try {
    const runs = await adapter.listRuns();
    populateRunSelect(runs);
    populateRunSelectB(runs);
    setStatus(`${runs.length} runs found`);

    // Restore previously selected run A
    if (savedState && savedState.runId) {
      const opt = [...runSelect.options].find((o) => o.value === savedState.runId);
      if (opt) {
        runSelect.value = savedState.runId;
        await loadSelectedRun(false, savedState);
      }
    }
    // Restore run B if in AB mode
    if (savedState && savedState.runIdB && savedState.currentTab === 'ab') {
      const optB = [...runSelectB.options].find((o) => o.value === savedState.runIdB);
      if (optB) {
        runSelectB.value = savedState.runIdB;
        await loadRunB(savedState.runIdB, savedState);
      }
    }
  } catch (e) {
    setStatus('Error loading runs: ' + e.message);
  }

  // Event listeners
  runSelect.addEventListener('change', () => loadSelectedRun(false));
  refreshBtn.addEventListener('click', () => loadSelectedRun(true));
  runSelectB.addEventListener('change', () => {
    const runIdB = runSelectB.value;
    if (runIdB) loadRunB(runIdB);
    else { allDataB = []; enrichedDataB = []; filteredDataB = []; renderTable(); persistViewState(); }
  });

  // Share button
  shareBtn.addEventListener('click', () => {
    syncUrlHash();
    navigator.clipboard.writeText(window.location.href).then(() => {
      shareBtn.classList.add('copied');
      shareBtn.textContent = 'Copied!';
      setTimeout(() => { shareBtn.classList.remove('copied'); shareBtn.textContent = 'Share \u{1F517}'; }, 2000);
    });
  });

  // View tabs
  document.getElementById('view-tabs').addEventListener('click', (e) => {
    if (e.target.tagName !== 'BUTTON') return;
    currentTab = e.target.dataset.tab;
    document.querySelectorAll('#view-tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === currentTab));
    document.getElementById('sidebar').classList.toggle('hidden', currentTab === 'comparison' || currentTab === 'insights');
    comparisonControls.classList.toggle('hidden', currentTab === 'explorer' || currentTab === 'ab' || currentTab === 'insights');
    abControls.classList.toggle('hidden', currentTab !== 'ab');
    abContainer.classList.toggle('hidden', currentTab !== 'ab');
    tableContainer.classList.toggle('hidden', currentTab === 'ab' || currentTab === 'insights');
    document.getElementById('insights-container').classList.toggle('hidden', currentTab !== 'insights');
    document.getElementById('metric-toggles').classList.toggle('hidden', currentTab === 'insights');
    outputSection.classList.toggle('hidden', currentTab === 'insights');
    if (currentTab === 'insights') renderInsights();
    else renderTable();
    persistViewState();
  });

  // Output format tabs
  document.getElementById('output-tabs').addEventListener('click', (e) => {
    if (e.target.tagName !== 'BUTTON') return;
    currentOutputFormat = e.target.dataset.format;
    document.querySelectorAll('#output-tabs button').forEach((b) => b.classList.toggle('active', b.dataset.format === currentOutputFormat));
    renderOutput();
    persistViewState();
  });

  // A/B output format tabs
  for (const side of ['a', 'b']) {
    document.getElementById(`ab-output-tabs-${side}`).addEventListener('click', (e) => {
      if (e.target.tagName !== 'BUTTON') return;
      document.querySelectorAll(`#ab-output-tabs-${side} button`).forEach((b) => b.classList.toggle('active', b.dataset.format === e.target.dataset.format));
      renderABOutput();
    });
  }

  // A/B sync rows toggle
  document.getElementById('ab-sync-toggle').addEventListener('change', (e) => {
    abSyncRows = e.target.checked;
    if (currentTab === 'ab') renderABPanels();
    persistViewState();
  });

  // Comparison controls
  groupBySelect.addEventListener('change', () => { renderTable(); persistViewState(); });
  sortBySelect.addEventListener('change', () => { sortColumn = sortBySelect.value; renderTable(); persistViewState(); });
  sortOrderSelect.addEventListener('change', () => { sortAsc = sortOrderSelect.value === 'asc'; renderTable(); persistViewState(); });

  // Heatmap controls
  document.getElementById('heatmap-handler').addEventListener('change', () => { if (currentTab === 'insights') renderHeatmaps(); });
  document.getElementById('heatmap-cluster').addEventListener('change', () => { if (currentTab === 'insights') renderHeatmaps(); });

  buildMetricToggles();

  // Saved views
  renderSavedViews();
  saveViewBtn.addEventListener('click', saveCurrentView);
}

// ─── Data Loading ────────────────────────────────────────

function populateRunSelect(runs) {
  runSelect.innerHTML = '<option value="">Select a run...</option>';
  for (const run of runs) {
    const date = new Date(run.timestamp).toLocaleString();
    const opt = document.createElement('option');
    opt.value = run.runId;
    const sourceTag = run.source === 'local' ? ' [local]' : run.source === 'cache' ? ' [cached]' : '';
    const laneInfo = run.lanes > 0 ? `, ${run.lanes} lanes` : '';
    opt.textContent = `${run.runId} (${date}${laneInfo})${sourceTag}`;
    runSelect.appendChild(opt);
  }
}

function populateRunSelectB(runs) {
  runSelectB.innerHTML = '<option value="">Select Run B...</option>';
  for (const run of runs) {
    const date = new Date(run.timestamp).toLocaleString();
    const opt = document.createElement('option');
    opt.value = run.runId;
    const sourceTag = run.source === 'local' ? ' [local]' : run.source === 'cache' ? ' [cached]' : '';
    const laneInfo = run.lanes > 0 ? `, ${run.lanes} lanes` : '';
    opt.textContent = `${run.runId} (${date}${laneInfo})${sourceTag}`;
    runSelectB.appendChild(opt);
  }
}

async function loadSelectedRun(refresh, stateToRestore) {
  const runId = runSelect.value;
  if (!runId) return;

  // Show loading overlay
  const overlay = document.getElementById('loading-overlay');
  const loadingTitle = document.getElementById('loading-title');
  const loadingLog = document.getElementById('loading-log');
  const loadingStats = document.getElementById('loading-stats');
  const progressFill = document.getElementById('loading-progress-fill');
  overlay.classList.remove('hidden');
  loadingTitle.textContent = `Loading ${runId}...`;
  loadingLog.innerHTML = '';
  loadingStats.textContent = '';
  progressFill.style.width = '0%';

  setStatus('Loading...');
  loadingMsg.textContent = '';
  loadingMsg.classList.remove('hidden');
  dataTable.classList.add('hidden');
  outputSection.classList.add('hidden');

  let fetchedCount = 0;
  let totalLanes = 0;
  let phase = 'init'; // init | scanning | fetching | done
  let cachedCount = 0;

  function addLogLine(msg) {
    const line = document.createElement('div');
    line.className = 'log-line';
    line.textContent = msg;
    loadingLog.appendChild(line);
    loadingLog.scrollTop = loadingLog.scrollHeight;

    // Parse progress messages to update stats/progress bar
    const incrementalMatch = msg.match(/Incremental refresh: (\d+) scenarios already cached/);
    if (incrementalMatch) {
      cachedCount = parseInt(incrementalMatch[1]);
      loadingStats.textContent = `${cachedCount} cached, checking for new...`;
    }

    const lanesMatch = msg.match(/Found (\d+) lanes/);
    if (lanesMatch) {
      totalLanes = parseInt(lanesMatch[1]);
      phase = 'scanning';
    }

    const fetchedMatch = msg.match(/Fetched .+\((\d+) new, (\d+) total\)/);
    if (fetchedMatch) {
      fetchedCount = parseInt(fetchedMatch[1]);
      const totalCount = parseInt(fetchedMatch[2]);
      phase = 'fetching';
      loadingStats.textContent = cachedCount > 0
        ? `${fetchedCount} new + ${cachedCount} cached = ${totalCount} scenarios`
        : `${totalCount} scenarios fetched`;
    }

    // Legacy format: "Fetched X (N total)"
    const fetchedLegacy = msg.match(/Fetched .+\((\d+) total\)/);
    if (!fetchedMatch && fetchedLegacy) {
      fetchedCount = parseInt(fetchedLegacy[1]);
      phase = 'fetching';
      loadingStats.textContent = `${fetchedCount} scenarios fetched`;
    }

    const scanMatch = msg.match(/Scanning (run-[^\s]+)/);
    if (scanMatch && phase !== 'fetching') {
      loadingStats.textContent = `Scanning ${scanMatch[1]}...`;
    }

    const patchMatch = msg.match(/Patched aggregateThroughput for (\d+) scenarios/);
    if (patchMatch) {
      loadingStats.textContent = `Patched throughput for ${patchMatch[1]} scenarios`;
    }

    const servingMatch = msg.match(/Serving from (?:cache|local)/);
    if (servingMatch) {
      progressFill.style.width = '100%';
      loadingStats.textContent = msg;
    }

    const doneMatch = msg.match(/Done: (\d+) scenarios/);
    if (doneMatch) {
      phase = 'done';
      progressFill.style.width = '100%';
      loadingStats.textContent = msg;
    }

    // Animate progress bar during fetch phase (estimate)
    if (phase === 'fetching' && fetchedCount > 0) {
      // We don't know total, but animate based on count
      const pct = Math.min(95, fetchedCount * 1.2);
      progressFill.style.width = `${pct}%`;
    }
  }

  try {
    const data = await adapter.loadRun(runId, refresh, addLogLine);

    allData = data;
    enrichedData = allData.map(enrichScenario);
    buildErrorCategoryMetrics();
    buildFilters();
    buildMetricToggles();
    if (stateToRestore) restoreFiltersFromState(stateToRestore);
    applyFilters();
    setStatus(`${enrichedData.length} scenarios loaded`);
    overlay.classList.add('hidden');
    persistViewState();

    // Load and render run summary (async, non-blocking)
    renderRunSummary(runId, enrichedData);
  } catch (e) {
    setStatus('Error: ' + e.message);
    addLogLine('ERROR: ' + e.message);
    loadingTitle.textContent = 'Error loading data';
    // Keep overlay visible for 3s so user can read the error
    setTimeout(() => overlay.classList.add('hidden'), 5000);
    loadingMsg.textContent = 'Error loading data: ' + e.message;
  }
}

function setStatus(text) {
  statusEl.textContent = text;
}

// ─── Load Run B (A/B Compare) ────────────────────────────

async function loadRunB(runIdB, stateToRestore) {
  if (!runIdB) return;
  setStatus(`Loading Run B: ${runIdB}...`);
  try {
    const data = await adapter.loadRun(runIdB, false, () => {});
    allDataB = data;
    enrichedDataB = allDataB.map(enrichScenario);
    // Rebuild filters to include values from both datasets
    if (enrichedData.length > 0) {
      buildFilters();
      if (stateToRestore) restoreFiltersFromState(stateToRestore);
    }
    applyFilters();
    setStatus(`A: ${enrichedData.length} scenarios, B: ${enrichedDataB.length} scenarios`);
    persistViewState();
  } catch (e) {
    setStatus('Error loading Run B: ' + e.message);
  }
}

// ─── Run Summary ─────────────────────────────────────────

async function renderRunSummary(runId, scenarios) {
  const summaryEl = document.getElementById('run-summary');
  const itemsEl = document.getElementById('run-summary-items');
  if (!summaryEl || !itemsEl) return;

  // Compute summary from scenario data
  const timestamp = parseInt(runId.replace('run-', ''), 10);
  const runDate = isNaN(timestamp) ? '—' : new Date(timestamp).toLocaleString();
  const scenarioCount = scenarios.length;
  const okCount = scenarios.filter((s) => s.status === 'ok').length;
  const errorCount = scenarios.filter((s) => s.status === 'error').length;
  const timeoutCount = scenarios.filter((s) => s.status === 'timeout').length;
  const languages = [...new Set(scenarios.map((s) => s.sdkLanguage))].sort();
  const clusters = [...new Set(scenarios.map((s) => s.cluster))].sort();
  // Elapsed time from run start to now.
  // We do NOT sum per-scenario wallClockS because lanes run in parallel —
  // that would double/triple-count time for multi-lane runs.
  let elapsedS = !isNaN(timestamp) ? (Date.now() - timestamp) / 1000 : 0;
  const formattedDuration = elapsedS >= 3600
    ? `${Math.floor(elapsedS / 3600)}h ${Math.floor((elapsedS % 3600) / 60)}m`
    : elapsedS >= 60
      ? `${Math.floor(elapsedS / 60)}m ${Math.round(elapsedS % 60)}s`
      : `${Math.round(elapsedS)}s`;

  let html = '';
  const item = (label, value, cls) =>
    `<span class="run-summary-item"><span class="label">${label}</span><span class="value${cls ? ' ' + cls : ''}">${value}</span></span>`;

  html += item('Run', runId, 'accent');
  html += item('Date', runDate, '');
  html += item('Scenarios', `${scenarioCount} (${okCount} ok, ${errorCount} err, ${timeoutCount} timeout)`, '');
  html += item('Languages', languages.join(', '), '');
  html += item('Clusters', clusters.join(', '), '');
  html += item('Elapsed', formattedDuration, '');

  // Fetch metadata for SDK versions (best effort)
  try {
    const meta = await adapter.loadRunMetadata(runId);
    if (meta && meta.sdkVersions) {
      let badges = '';
      for (const [lang, ver] of Object.entries(meta.sdkVersions)) {
        badges += `<span class="sdk-badge"><span class="lang">${lang}</span>${ver}</span>`;
      }
      if (badges) {
        html += `<span class="run-summary-versions">${badges}</span>`;
      }
    }
    if (meta && meta.commit) {
      html += item('Commit', meta.commit, '');
    }
    if (meta && meta.mode) {
      html += item('Mode', meta.mode, '');
    }
    if (meta && meta.handlerLatencyMs != null) {
      html += item('Workload Latency', `${meta.handlerLatencyMs}ms`, '');
    }
  } catch { /* metadata not available — that's fine */ }

  itemsEl.innerHTML = html;
  summaryEl.classList.remove('hidden');
}

// ─── Data Enrichment ─────────────────────────────────────

function enrichScenario(s) {
  const enriched = { ...s };

  // Error rate
  const total = (s.totalCompleted || 0) + (s.totalErrors || 0);
  enriched.errorRate = total > 0 ? (s.totalErrors / total) * 100 : 0;

  // Server metrics flattened
  if (s.serverResourceUsage) {
    enriched.serverCpuAvg = s.serverResourceUsage.cpuAvg;
    enriched.serverCpuPeak = s.serverResourceUsage.cpuPeak;
    enriched.serverMemAvgMb = s.serverResourceUsage.memoryUsedAvgMb;
    enriched.serverMemPeakMb = s.serverResourceUsage.memoryUsedPeakMb;
    enriched.serverThreadsAvg = s.serverResourceUsage.liveThreadsAvg;
    enriched.serverDiskUsedAvgGb = s.serverResourceUsage.diskUsedAvgGb;
    enriched.serverDiskUsedPeakGb = s.serverResourceUsage.diskUsedPeakGb;
    enriched.serverDiskPctPeak = s.serverResourceUsage.diskUsedPctPeak;
  } else {
    enriched.serverCpuAvg = null;
    enriched.serverCpuPeak = null;
    enriched.serverMemAvgMb = null;
    enriched.serverMemPeakMb = null;
    enriched.serverThreadsAvg = null;
    enriched.serverDiskUsedAvgGb = null;
    enriched.serverDiskUsedPeakGb = null;
    enriched.serverDiskPctPeak = null;
  }

  // Client memory — aggregate from processResults if they have memoryUsage
  // Available in runs collected after the memoryUsage fix (older runs lack this field)
  let memSamples = 0, memSum = 0, memPeak = 0;
  if (s.processResults) {
    for (const p of s.processResults) {
      if (p.memoryUsage) {
        memSamples++;
        memSum += p.memoryUsage.avgRssMb || 0;
        memPeak = Math.max(memPeak, p.memoryUsage.peakRssMb || 0);
      }
    }
  }
  enriched.clientMemAvgMb = memSamples > 0 ? memSum / memSamples : null;
  enriched.clientMemPeakMb = memSamples > 0 ? memPeak : null;

  // Error types — aggregate from processResults
  const mergedErrorTypes = {};
  if (s.processResults) {
    for (const p of s.processResults) {
      if (p.errorTypes) {
        for (const [errKey, count] of Object.entries(p.errorTypes)) {
          mergedErrorTypes[errKey] = (mergedErrorTypes[errKey] || 0) + count;
        }
      }
    }
  }
  enriched._errorTypes = mergedErrorTypes;

  return enriched;
}

/**
 * Discover all error categories across the dataset and rebuild
 * the dynamic errorCategoryMetrics array.
 */
function buildErrorCategoryMetrics() {
  const categories = new Map(); // short key -> total count across all scenarios
  for (const s of enrichedData) {
    if (s._errorTypes) {
      for (const [errKey, count] of Object.entries(s._errorTypes)) {
        // Shorten the key for display: take just the class name (before ': ')
        const shortKey = errKey.includes(': ') ? errKey.split(': ')[0] : errKey;
        categories.set(shortKey, (categories.get(shortKey) || 0) + count);
      }
    }
  }

  // Sort by total count descending
  const sorted = [...categories.entries()].sort((a, b) => b[1] - a[1]);

  errorCategoryMetrics = sorted.map(([shortKey]) => ({
    key: `err_${shortKey}`,
    label: shortKey,
    format: (v) => v != null && v > 0 ? v.toLocaleString() : '—',
    errorCategory: true,
  }));

  // Flatten per-scenario: for each enriched scenario, add err_XYZ fields
  for (const s of enrichedData) {
    for (const m of errorCategoryMetrics) {
      s[m.key] = 0;
    }
    if (s._errorTypes) {
      for (const [errKey, count] of Object.entries(s._errorTypes)) {
        const shortKey = errKey.includes(': ') ? errKey.split(': ')[0] : errKey;
        const metricKey = `err_${shortKey}`;
        s[metricKey] = (s[metricKey] || 0) + count;
      }
    }
  }
}

// ─── Filters ─────────────────────────────────────────────

function buildFilters() {
  filterGroupsEl.innerHTML = '';

  // In AB mode, merge dimension values from both datasets
  const combinedData = currentTab === 'ab' && enrichedDataB.length > 0
    ? [...enrichedData, ...enrichedDataB]
    : enrichedData;

  for (const dim of DIMENSIONS) {
    const values = [...new Set(combinedData.map((d) => d[dim.key]))].sort((a, b) => {
      if (typeof a === 'number') return a - b;
      return String(a).localeCompare(String(b));
    });

    filters[dim.key] = new Set(values);

    const group = document.createElement('div');
    group.className = 'filter-group';
    group.innerHTML = `
      <h3>
        ${dim.label}
        <span class="toggle-btns">
          <button data-dim="${dim.key}" data-action="all">All</button>
          <button data-dim="${dim.key}" data-action="none">None</button>
        </span>
      </h3>
    `;

    for (const val of values) {
      const label = document.createElement('label');
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = true;
      cb.dataset.dim = dim.key;
      cb.dataset.val = String(val);
      cb.addEventListener('change', () => {
        if (cb.checked) filters[dim.key].add(val);
        else filters[dim.key].delete(val);
        applyFilters();
        persistViewState();
      });
      label.appendChild(cb);
      label.appendChild(document.createTextNode(String(val)));
      group.appendChild(label);
    }

    // Toggle buttons
    group.addEventListener('click', (e) => {
      if (e.target.tagName !== 'BUTTON') return;
      const action = e.target.dataset.action;
      const dimKey = e.target.dataset.dim;
      const cbs = group.querySelectorAll('input[type="checkbox"]');
      cbs.forEach((cb) => {
        cb.checked = action === 'all';
        if (cb.checked) filters[dimKey].add(isNaN(cb.dataset.val) ? cb.dataset.val : Number(cb.dataset.val));
        else filters[dimKey].delete(isNaN(cb.dataset.val) ? cb.dataset.val : Number(cb.dataset.val));
      });
      // Re-sync the filter set properly
      const vals = [...new Set(enrichedData.map((d) => d[dimKey]))];
      if (action === 'all') filters[dimKey] = new Set(vals);
      else filters[dimKey] = new Set();
      applyFilters();
      persistViewState();
    });

    filterGroupsEl.appendChild(group);
  }

  // Populate comparison dropdowns
  populateComparisonControls();
}

function applyFilters() {
  const filterFn = (d) => {
    for (const dim of DIMENSIONS) {
      if (!filters[dim.key] || filters[dim.key].size === 0) return false;
      if (!filters[dim.key].has(d[dim.key])) return false;
    }
    return true;
  };
  filteredData = enrichedData.filter(filterFn);
  filteredDataB = enrichedDataB.filter(filterFn);
  renderTable();
}

// ─── Metric Toggles ──────────────────────────────────────

function buildMetricToggles() {
  metricTogglesEl.innerHTML = '';
  const allMetrics = getMetrics();
  const baseKeys = new Set(BASE_METRICS.map(m => m.key));
  let addedErrorHeader = false;
  for (const m of allMetrics) {
    // Add a section header before the first error category metric
    if (!baseKeys.has(m.key) && !addedErrorHeader) {
      addedErrorHeader = true;
      const header = document.createElement('div');
      header.className = 'metric-toggle-header';
      header.textContent = 'Error Categories';
      metricTogglesEl.appendChild(header);
    }
    const label = document.createElement('label');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = visibleMetrics.has(m.key);
    cb.addEventListener('change', () => {
      if (cb.checked) visibleMetrics.add(m.key);
      else visibleMetrics.delete(m.key);
      renderTable();
      persistViewState();
    });
    label.appendChild(cb);
    label.appendChild(document.createTextNode(m.label));
    metricTogglesEl.appendChild(label);
  }
}

// ─── Comparison Controls ─────────────────────────────────

function populateComparisonControls() {
  // Group-by options
  groupBySelect.innerHTML = '<option value="">None</option>';
  for (const dim of DIMENSIONS) {
    const opt = document.createElement('option');
    opt.value = dim.key;
    opt.textContent = dim.label;
    groupBySelect.appendChild(opt);
  }

  // Sort-by options
  sortBySelect.innerHTML = '';
  for (const m of getMetrics()) {
    const opt = document.createElement('option');
    opt.value = m.key;
    opt.textContent = m.label;
    if (m.key === 'aggregateThroughput') opt.selected = true;
    sortBySelect.appendChild(opt);
  }
}

// ─── Table Rendering ─────────────────────────────────────

function renderTable() {
  // A/B mode: render split panels instead of the single table
  if (currentTab === 'ab') {
    renderABPanels();
    return;
  }

  // Insights mode: render insights panels
  if (currentTab === 'insights') {
    renderInsights();
    return;
  }

  if (filteredData.length === 0) {
    loadingMsg.textContent = enrichedData.length > 0 ? 'No scenarios match current filters' : 'No data loaded';
    loadingMsg.classList.remove('hidden');
    dataTable.classList.add('hidden');
    outputSection.classList.add('hidden');
    return;
  }

  loadingMsg.classList.add('hidden');
  dataTable.classList.remove('hidden');
  outputSection.classList.remove('hidden');

  // Sort data
  const sorted = [...filteredData].sort((a, b) => {
    const va = getMetricValue(a, sortColumn);
    const vb = getMetricValue(b, sortColumn);
    if (va == null && vb == null) return 0;
    if (va == null) return 1;
    if (vb == null) return -1;
    const cmp = typeof va === 'string' ? va.localeCompare(vb) : va - vb;
    return sortAsc ? cmp : -cmp;
  });

  // Group if comparison tab
  const groupKey = currentTab === 'comparison' ? groupBySelect.value : '';

  // Build visible columns
  const dimCols = DIMENSIONS;
  const metricCols = getMetrics().filter((m) => visibleMetrics.has(m.key));

  // Header
  tableHead.innerHTML = '';
  // Rank column header
  const thRank = document.createElement('th');
  thRank.textContent = '#';
  thRank.style.cssText = 'width: 36px; text-align: center; color: var(--text-muted);';
  tableHead.appendChild(thRank);

  // Copy column header (empty, narrow)
  const thCopy = document.createElement('th');
  thCopy.style.cssText = 'width: 28px; padding: 8px 2px;';
  tableHead.appendChild(thCopy);

  for (const dim of dimCols) {
    const th = document.createElement('th');
    th.textContent = dim.label;
    th.dataset.col = dim.key;
    th.addEventListener('click', () => toggleSort(dim.key));
    if (sortColumn === dim.key) th.className = sortAsc ? 'sorted-asc' : 'sorted-desc';
    tableHead.appendChild(th);
  }
  for (const m of metricCols) {
    const th = document.createElement('th');
    th.textContent = m.label;
    th.className = 'num';
    th.dataset.col = m.key;
    th.addEventListener('click', () => toggleSort(m.key));
    if (sortColumn === m.key) th.className = 'num ' + (sortAsc ? 'sorted-asc' : 'sorted-desc');
    tableHead.appendChild(th);
  }

  // Body
  tableBody.innerHTML = '';
  let lastGroup = null;
  let rank = 0;

  for (const row of sorted) {
    // Group separator
    if (groupKey && row[groupKey] !== lastGroup) {
      lastGroup = row[groupKey];
      const tr = document.createElement('tr');
      const td = document.createElement('td');
      td.colSpan = dimCols.length + metricCols.length + 2; // +1 for copy column, +1 for rank
      td.style.cssText = 'background: var(--surface2); font-weight: 600; padding: 8px 10px; color: var(--accent);';
      td.textContent = `${DIMENSIONS.find((d) => d.key === groupKey)?.label || groupKey}: ${lastGroup}`;
      tr.appendChild(td);
      tableBody.appendChild(tr);
    }

    rank++;
    const tr = document.createElement('tr');
    tr.style.cursor = 'pointer';

    // Rank cell
    const tdRank = document.createElement('td');
    tdRank.textContent = String(rank);
    tdRank.style.cssText = 'text-align: center; color: var(--text-muted); font-size: 12px; font-variant-numeric: tabular-nums;';
    tr.appendChild(tdRank);

    // Copy ID button cell
    const tdCopy = document.createElement('td');
    tdCopy.style.cssText = 'padding: 6px 2px; text-align: center;';
    const copyBtn = document.createElement('button');
    copyBtn.className = 'copy-id-btn';
    copyBtn.innerHTML = '\u{1F4CB}';
    const copyText = `${runSelect.value}/${row.scenarioId}`;
    copyBtn.title = `Copy: ${copyText}`;
    copyBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      navigator.clipboard.writeText(copyText).then(() => {
        copyBtn.classList.add('copied');
        copyBtn.innerHTML = '\u2713';
        setTimeout(() => { copyBtn.classList.remove('copied'); copyBtn.innerHTML = '\u{1F4CB}'; }, 1500);
      });
    });
    tdCopy.appendChild(copyBtn);
    tr.appendChild(tdCopy);

    // Click row → open detail popover
    tr.addEventListener('click', () => openScenarioPopover(row));

    for (const dim of dimCols) {
      const td = document.createElement('td');
      td.textContent = String(row[dim.key]);
      tr.appendChild(td);
    }

    for (const m of metricCols) {
      const td = document.createElement('td');
      td.className = 'num';
      const val = getMetricValue(row, m.key);
      td.textContent = m.format(val);

      // Color status
      if (m.key === 'status') {
        td.className = `status-${val}`;
      }
      tr.appendChild(td);
    }

    tableBody.appendChild(tr);
  }

  renderOutput();
}

// ─── A/B Compare Rendering ───────────────────────────────

function renderABPanels() {
  const headerA = document.getElementById('ab-header-a');
  const headerB = document.getElementById('ab-header-b');
  const headA = document.getElementById('ab-head-a');
  const bodyA = document.getElementById('ab-body-a');
  const headB = document.getElementById('ab-head-b');
  const bodyB = document.getElementById('ab-body-b');

  headerA.textContent = runSelect.value || 'Run A (not selected)';
  headerB.textContent = runSelectB.value || 'Run B (not selected)';

  const dimCols = DIMENSIONS;
  const metricCols = getMetrics().filter((m) => visibleMetrics.has(m.key));

  if (abSyncRows) {
    renderABSynced(headA, bodyA, headB, bodyB, dimCols, metricCols);
  } else {
    teardownSyncedScroll();
    renderABPanel(headA, bodyA, filteredData, dimCols, metricCols, runSelect.value);
    renderABPanel(headB, bodyB, filteredDataB, dimCols, metricCols, runSelectB.value);
  }

  // Hide the main output section in AB mode
  outputSection.classList.add('hidden');

  renderABOutput();
}

function renderABPanel(headEl, bodyEl, data, dimCols, metricCols, runId) {
  headEl.innerHTML = '';
  bodyEl.innerHTML = '';

  if (data.length === 0) {
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = dimCols.length + metricCols.length + 1; // +1 for rank column
    td.style.cssText = 'padding: 40px; text-align: center; color: var(--text-muted);';
    td.textContent = runId ? 'No scenarios match current filters' : 'Select a run';
    tr.appendChild(td);
    bodyEl.appendChild(tr);
    return;
  }

  // Sort
  const sorted = [...data].sort((a, b) => {
    const va = getMetricValue(a, sortColumn);
    const vb = getMetricValue(b, sortColumn);
    if (va == null && vb == null) return 0;
    if (va == null) return 1;
    if (vb == null) return -1;
    const cmp = typeof va === 'string' ? va.localeCompare(vb) : va - vb;
    return sortAsc ? cmp : -cmp;
  });

  // Header
  const thRank = document.createElement('th');
  thRank.textContent = '#';
  thRank.style.cssText = 'width: 36px; text-align: center; color: var(--text-muted);';
  headEl.appendChild(thRank);

  for (const dim of dimCols) {
    const th = document.createElement('th');
    th.textContent = dim.label;
    th.dataset.col = dim.key;
    th.addEventListener('click', () => toggleSort(dim.key));
    if (sortColumn === dim.key) th.className = sortAsc ? 'sorted-asc' : 'sorted-desc';
    headEl.appendChild(th);
  }
  for (const m of metricCols) {
    const th = document.createElement('th');
    th.textContent = m.label;
    th.className = 'num';
    th.dataset.col = m.key;
    th.addEventListener('click', () => toggleSort(m.key));
    if (sortColumn === m.key) th.className = 'num ' + (sortAsc ? 'sorted-asc' : 'sorted-desc');
    headEl.appendChild(th);
  }

  // Rows
  let abRank = 0;
  for (const row of sorted) {
    abRank++;
    const tr = document.createElement('tr');
    tr.style.cursor = 'pointer';
    tr.addEventListener('click', () => openScenarioPopover(row));

    const tdRank = document.createElement('td');
    tdRank.textContent = String(abRank);
    tdRank.style.cssText = 'text-align: center; color: var(--text-muted); font-size: 12px; font-variant-numeric: tabular-nums;';
    tr.appendChild(tdRank);

    for (const dim of dimCols) {
      const td = document.createElement('td');
      td.textContent = String(row[dim.key]);
      tr.appendChild(td);
    }
    for (const m of metricCols) {
      const td = document.createElement('td');
      td.className = 'num';
      const val = getMetricValue(row, m.key);
      td.textContent = m.format(val);
      if (m.key === 'status') td.className = `status-${val}`;
      tr.appendChild(td);
    }

    bodyEl.appendChild(tr);
  }
}

/**
 * Synced A/B rendering: align matching scenarios by scenarioId.
 * Both panels get the same row order. Missing scenarios show as blank rows.
 */
function renderABSynced(headA, bodyA, headB, bodyB, dimCols, metricCols) {
  // Build lookups by scenarioId
  const mapA = new Map();
  for (const s of filteredData) mapA.set(s.scenarioId, s);
  const mapB = new Map();
  for (const s of filteredDataB) mapB.set(s.scenarioId, s);

  // Union of all scenario IDs
  const allIds = [...new Set([...mapA.keys(), ...mapB.keys()])];

  // Sort by the sort column using A-side values (fall back to B-side)
  allIds.sort((idA, idB) => {
    const rowA = mapA.get(idA) || mapB.get(idA);
    const rowB = mapA.get(idB) || mapB.get(idB);
    const va = rowA ? getMetricValue(rowA, sortColumn) : null;
    const vb = rowB ? getMetricValue(rowB, sortColumn) : null;
    if (va == null && vb == null) return 0;
    if (va == null) return 1;
    if (vb == null) return -1;
    const cmp = typeof va === 'string' ? va.localeCompare(vb) : va - vb;
    return sortAsc ? cmp : -cmp;
  });

  // Render headers for both panels
  for (const headEl of [headA, headB]) {
    headEl.innerHTML = '';
    const thRank = document.createElement('th');
    thRank.textContent = '#';
    thRank.style.cssText = 'width: 36px; text-align: center; color: var(--text-muted);';
    headEl.appendChild(thRank);

    for (const dim of dimCols) {
      const th = document.createElement('th');
      th.textContent = dim.label;
      th.dataset.col = dim.key;
      th.addEventListener('click', () => toggleSort(dim.key));
      if (sortColumn === dim.key) th.className = sortAsc ? 'sorted-asc' : 'sorted-desc';
      headEl.appendChild(th);
    }
    for (const m of metricCols) {
      const th = document.createElement('th');
      th.textContent = m.label;
      th.className = 'num';
      th.dataset.col = m.key;
      th.addEventListener('click', () => toggleSort(m.key));
      if (sortColumn === m.key) th.className = 'num ' + (sortAsc ? 'sorted-asc' : 'sorted-desc');
      headEl.appendChild(th);
    }
  }

  // Render synced rows
  bodyA.innerHTML = '';
  bodyB.innerHTML = '';
  const totalCols = dimCols.length + metricCols.length + 1; // +1 for rank

  for (let i = 0; i < allIds.length; i++) {
    const scenarioId = allIds[i];
    const rowA = mapA.get(scenarioId);
    const rowB = mapB.get(scenarioId);
    const unmatched = !rowA || !rowB; // one side is missing

    bodyA.appendChild(buildSyncedRow(rowA, i + 1, dimCols, metricCols, totalCols, unmatched));
    bodyB.appendChild(buildSyncedRow(rowB, i + 1, dimCols, metricCols, totalCols, unmatched));
  }

  if (allIds.length === 0) {
    for (const bodyEl of [bodyA, bodyB]) {
      const tr = document.createElement('tr');
      const td = document.createElement('td');
      td.colSpan = totalCols;
      td.style.cssText = 'padding: 40px; text-align: center; color: var(--text-muted);';
      td.textContent = 'No scenarios match current filters';
      tr.appendChild(td);
      bodyEl.appendChild(tr);
    }
  }

  // Sync scrolling between the two panels
  setupSyncedScroll();
}

/** Active scroll listeners for synced A/B scrolling. */
let _syncScrollCleanup = null;

function setupSyncedScroll() {
  teardownSyncedScroll();

  const wrapA = document.querySelector('#ab-panel-a .ab-table-wrap');
  const wrapB = document.querySelector('#ab-panel-b .ab-table-wrap');
  if (!wrapA || !wrapB) return;

  let isSyncing = false;

  const syncA = () => {
    if (isSyncing) return;
    isSyncing = true;
    wrapB.scrollTop = wrapA.scrollTop;
    wrapB.scrollLeft = wrapA.scrollLeft;
    isSyncing = false;
  };

  const syncB = () => {
    if (isSyncing) return;
    isSyncing = true;
    wrapA.scrollTop = wrapB.scrollTop;
    wrapA.scrollLeft = wrapB.scrollLeft;
    isSyncing = false;
  };

  wrapA.addEventListener('scroll', syncA);
  wrapB.addEventListener('scroll', syncB);

  _syncScrollCleanup = () => {
    wrapA.removeEventListener('scroll', syncA);
    wrapB.removeEventListener('scroll', syncB);
  };
}

function teardownSyncedScroll() {
  if (_syncScrollCleanup) {
    _syncScrollCleanup();
    _syncScrollCleanup = null;
  }
}

function buildSyncedRow(row, rank, dimCols, metricCols, totalCols, unmatched) {
  const tr = document.createElement('tr');

  if (!row) {
    // Blank placeholder row — scenario missing from this run
    tr.className = 'synced-missing';
    const tdRank = document.createElement('td');
    tdRank.textContent = String(rank);
    tdRank.style.cssText = 'text-align: center; color: var(--text-muted); font-size: 12px; opacity: 0.4;';
    tr.appendChild(tdRank);
    for (let i = 0; i < dimCols.length + metricCols.length; i++) {
      const td = document.createElement('td');
      td.textContent = '—';
      td.style.opacity = '0.3';
      tr.appendChild(td);
    }
    return tr;
  }

  // Present but the other side is missing — dim this row
  if (unmatched) tr.className = 'synced-unmatched';

  tr.style.cursor = 'pointer';
  tr.addEventListener('click', () => openScenarioPopover(row));

  const tdRank = document.createElement('td');
  tdRank.textContent = String(rank);
  tdRank.style.cssText = 'text-align: center; color: var(--text-muted); font-size: 12px; font-variant-numeric: tabular-nums;';
  tr.appendChild(tdRank);

  for (const dim of dimCols) {
    const td = document.createElement('td');
    td.textContent = String(row[dim.key]);
    tr.appendChild(td);
  }
  for (const m of metricCols) {
    const td = document.createElement('td');
    td.className = 'num';
    const val = getMetricValue(row, m.key);
    td.textContent = m.format(val);
    if (m.key === 'status') td.className = `status-${val}`;
    tr.appendChild(td);
  }

  return tr;
}

// ─── A/B Output Rendering ────────────────────────────────

function runIdToDate(runId) {
  if (!runId) return '—';
  const ts = parseInt(runId.replace('run-', ''), 10);
  return isNaN(ts) ? '—' : new Date(ts).toLocaleString();
}

function renderABOutput() {
  const outputA = document.getElementById('ab-output-a');
  const outputB = document.getElementById('ab-output-b');
  const contentA = document.getElementById('ab-output-content-a');
  const contentB = document.getElementById('ab-output-content-b');

  const hasA = filteredData.length > 0;
  const hasB = filteredDataB.length > 0;

  outputA.classList.toggle('hidden', !hasA);
  outputB.classList.toggle('hidden', !hasB);

  if (hasA) renderABOutputPanel(contentA, filteredData, runSelect.value, 'a');
  if (hasB) renderABOutputPanel(contentB, filteredDataB, runSelectB.value, 'b');
}

function renderABOutputPanel(contentEl, data, runId, side) {
  const dimCols = DIMENSIONS;
  const metricCols = getMetrics().filter((m) => visibleMetrics.has(m.key));

  const sorted = [...data].sort((a, b) => {
    const va = getMetricValue(a, sortColumn);
    const vb = getMetricValue(b, sortColumn);
    if (va == null && vb == null) return 0;
    if (va == null) return 1;
    if (vb == null) return -1;
    const cmp = typeof va === 'string' ? va.localeCompare(vb) : va - vb;
    return sortAsc ? cmp : -cmp;
  });

  const headers = ['#', ...dimCols.map((d) => d.label), ...metricCols.map((m) => m.label)];
  const rows = sorted.map((row, i) => [
    String(i + 1),
    ...dimCols.map((d) => String(row[d.key])),
    ...metricCols.map((m) => m.format(getMetricValue(row, m.key))),
  ]);

  const runHeader = `Run: ${runId}  |  ${runIdToDate(runId)}`;

  // Read the active format from this panel's tabs
  const activeBtn = document.querySelector(`#ab-output-tabs-${side} button.active`);
  const format = activeBtn ? activeBtn.dataset.format : 'html';

  if (format === 'html') {
    contentEl.innerHTML = '<div style="padding: 12px; color: var(--text-muted); font-size: 12px;">The HTML table is rendered above. Use Markdown or Slack tabs to copy.</div>';
  } else if (format === 'markdown') {
    const md = `**${runHeader}**\n\n` + toMarkdown(headers, rows);
    contentEl.innerHTML = `<textarea readonly>${escapeHtml(md)}</textarea>`;
  } else if (format === 'slack') {
    const slack = `*${runHeader}*\n\n` + toSlack(headers, rows);
    contentEl.innerHTML = `<textarea readonly>${escapeHtml(slack)}</textarea>`;
  }
}

function getMetricValue(row, key) {
  if (key === 'errorRate') return row.errorRate;
  if (key === 'clientMemAvgMb') return row.clientMemAvgMb;
  if (key === 'clientMemPeakMb') return row.clientMemPeakMb;
  if (key === 'serverCpuAvg') return row.serverCpuAvg;
  if (key === 'serverCpuPeak') return row.serverCpuPeak;
  if (key === 'serverMemAvgMb') return row.serverMemAvgMb;
  if (key === 'serverMemPeakMb') return row.serverMemPeakMb;
  if (key === 'serverThreadsAvg') return row.serverThreadsAvg;
  if (key === 'serverDiskUsedAvgGb') return row.serverDiskUsedAvgGb;
  if (key === 'serverDiskUsedPeakGb') return row.serverDiskUsedPeakGb;
  if (key === 'serverDiskPctPeak') return row.serverDiskPctPeak;
  return row[key];
}

function toggleSort(col) {
  if (sortColumn === col) sortAsc = !sortAsc;
  else { sortColumn = col; sortAsc = false; }
  renderTable();
  persistViewState();
}

// ─── Output Rendering ────────────────────────────────────

function renderOutput() {
  if (filteredData.length === 0) return;

  const dimCols = DIMENSIONS;
  const metricCols = getMetrics().filter((m) => visibleMetrics.has(m.key));

  const sorted = [...filteredData].sort((a, b) => {
    const va = getMetricValue(a, sortColumn);
    const vb = getMetricValue(b, sortColumn);
    if (va == null && vb == null) return 0;
    if (va == null) return 1;
    if (vb == null) return -1;
    const cmp = typeof va === 'string' ? va.localeCompare(vb) : va - vb;
    return sortAsc ? cmp : -cmp;
  });

  const headers = ['#', ...dimCols.map((d) => d.label), ...metricCols.map((m) => m.label)];
  const rows = sorted.map((row, i) => [
    String(i + 1),
    ...dimCols.map((d) => String(row[d.key])),
    ...metricCols.map((m) => m.format(getMetricValue(row, m.key))),
  ]);

  if (currentOutputFormat === 'html') {
    // Show the rendered table itself — already visible above
    outputContent.innerHTML = '<div style="padding: 12px; color: var(--text-muted); font-size: 12px;">The HTML table is rendered above. Use Markdown or Slack tabs to copy.</div>';
  } else if (currentOutputFormat === 'markdown') {
    const md = toMarkdown(headers, rows);
    outputContent.innerHTML = `<textarea readonly>${escapeHtml(md)}</textarea>`;
  } else if (currentOutputFormat === 'slack') {
    const slack = toSlack(headers, rows);
    outputContent.innerHTML = `<textarea readonly>${escapeHtml(slack)}</textarea>`;
  }
}

function toMarkdown(headers, rows) {
  const sep = headers.map(() => '---');
  const lines = [
    '| ' + headers.join(' | ') + ' |',
    '| ' + sep.join(' | ') + ' |',
    ...rows.map((r) => '| ' + r.join(' | ') + ' |'),
  ];
  return lines.join('\n');
}

function toSlack(headers, rows) {
  // Fixed-width table for Slack
  const allRows = [headers, ...rows];
  const widths = headers.map((_, i) => Math.max(...allRows.map((r) => (r[i] || '').length)));

  const formatRow = (r) => r.map((cell, i) => (cell || '').padEnd(widths[i])).join('  ');

  const lines = [
    '```',
    formatRow(headers),
    widths.map((w) => '─'.repeat(w)).join('  '),
    ...rows.map(formatRow),
    '```',
  ];
  return lines.join('\n');
}

function escapeHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ─── Scenario Detail Popover ─────────────────────────────

function openScenarioPopover(row) {
  const popover = document.getElementById('scenario-popover');
  const title = document.getElementById('popover-title');
  const body = document.getElementById('popover-body');
  const backdrop = document.getElementById('popover-backdrop');
  const closeBtn = document.getElementById('popover-close');

  title.textContent = row.scenarioId;

  // Build detail content
  body.innerHTML = '';

  // ── Configuration section
  const configSection = buildSection('Configuration', [
    ['Cluster', row.cluster],
    ['Language', row.sdkLanguage],
    ['Mode', row.sdkMode],
    ['Handler', row.handlerType],
    ['Total Workers', row.totalWorkers],
    ['Workers/Process', row.workersPerProcess],
    ['Processes', row.processes],
  ]);
  body.appendChild(configSection);

  // ── Aggregate Results section
  const total = (row.totalCompleted || 0) + (row.totalErrors || 0);
  const errRate = total > 0 ? ((row.totalErrors / total) * 100).toFixed(2) + '%' : '0%';
  const resultsSection = buildSection('Aggregate Results', [
    ['Status', row.status, `status-${row.status}`],
    ['Throughput', row.aggregateThroughput?.toFixed(1) + ' ops/s'],
    ['Completed', row.totalCompleted?.toLocaleString()],
    ['Errors', row.totalErrors?.toLocaleString()],
    ['Error Rate', errRate],
    ['Wall Clock', row.wallClockS?.toFixed(1) + 's'],
    ['Fairness (Jain)', row.jainFairness?.toFixed(4)],
  ]);
  body.appendChild(resultsSection);

  // ── Server Resource Usage
  if (row.serverCpuAvg != null || row.serverMemAvgMb != null) {
    const serverSection = buildSection('Server Resources', [
      ['CPU Avg', row.serverCpuAvg != null ? (row.serverCpuAvg * 100).toFixed(1) + '%' : '—'],
      ['CPU Peak', row.serverCpuPeak != null ? (row.serverCpuPeak * 100).toFixed(1) + '%' : '—'],
      ['Memory Avg', row.serverMemAvgMb != null ? row.serverMemAvgMb.toFixed(0) + ' MB' : '—'],
      ['Memory Peak', row.serverMemPeakMb != null ? row.serverMemPeakMb.toFixed(0) + ' MB' : '—'],
      ['Threads Avg', row.serverThreadsAvg != null ? Math.round(row.serverThreadsAvg).toString() : '—'],
      ['Disk Used Avg', row.serverDiskUsedAvgGb != null ? row.serverDiskUsedAvgGb.toFixed(2) + ' GB' : '—'],
      ['Disk Used Peak', row.serverDiskUsedPeakGb != null ? row.serverDiskUsedPeakGb.toFixed(2) + ' GB' : '—'],
      ['Disk Used %', row.serverDiskPctPeak != null ? row.serverDiskPctPeak.toFixed(1) + '%' : '—'],
    ]);
    body.appendChild(serverSection);
  }

  // ── Client Memory
  if (row.clientMemAvgMb != null) {
    const clientSection = buildSection('Client Memory', [
      ['Avg RSS', row.clientMemAvgMb?.toFixed(1) + ' MB'],
      ['Peak RSS', row.clientMemPeakMb?.toFixed(1) + ' MB'],
    ]);
    body.appendChild(clientSection);
  }

  // ── Error Distribution
  if (row._errorTypes && Object.keys(row._errorTypes).length > 0) {
    const errEntries = Object.entries(row._errorTypes).sort((a, b) => b[1] - a[1]);
    const errSection = buildSection('Error Distribution', errEntries.map(([k, v]) => [k, v.toLocaleString()]));
    body.appendChild(errSection);
  }

  // ── Pre-creation Stats
  if (row.preCreate) {
    const preSection = buildSection('Pre-creation', [
      ['Created', row.preCreate.created?.toLocaleString()],
      ['Errors', row.preCreate.errors?.toLocaleString()],
      ['Duration', row.preCreate.durationS?.toFixed(1) + 's'],
    ]);
    body.appendChild(preSection);
  }

  // ── Continuous Producer
  if (row.continuousProducer) {
    const cpSection = buildSection('Continuous Producer', [
      ['Created', row.continuousProducer.created?.toLocaleString()],
      ['Errors', row.continuousProducer.errors?.toLocaleString()],
      ['Duration', row.continuousProducer.durationS?.toFixed(1) + 's'],
      ['Rate', row.continuousProducer.rate?.toFixed(1) + ' ops/s'],
    ]);
    body.appendChild(cpSection);
  }

  // ── Per-Process Breakdown
  if (row.processResults && row.processResults.length > 0) {
    const procDiv = document.createElement('div');
    procDiv.className = 'popover-section';

    const procHeading = document.createElement('h3');
    procHeading.textContent = `Per-Process Breakdown (${row.processResults.length})`;
    procDiv.appendChild(procHeading);

    const procTable = document.createElement('table');
    procTable.className = 'popover-proc-table';
    const procHead = document.createElement('thead');
    procHead.innerHTML = '<tr><th>Process</th><th>Workers</th><th>Completed</th><th>Errors</th><th>Throughput</th><th>Mem Peak</th><th>Mem Avg</th></tr>';
    procTable.appendChild(procHead);

    const procBody = document.createElement('tbody');
    const procs = [...row.processResults].sort((a, b) => (b.throughput || 0) - (a.throughput || 0));
    for (const p of procs) {
      const ptr = document.createElement('tr');
      ptr.innerHTML = `
        <td>${p.vmName || p.processId}</td>
        <td class="num">${p.workersInProcess}</td>
        <td class="num">${p.completed?.toLocaleString()}</td>
        <td class="num">${p.errors?.toLocaleString()}</td>
        <td class="num">${p.throughput?.toFixed(1)}</td>
        <td class="num">${p.memoryUsage ? p.memoryUsage.peakRssMb.toFixed(1) + ' MB' : '—'}</td>
        <td class="num">${p.memoryUsage ? p.memoryUsage.avgRssMb.toFixed(1) + ' MB' : '—'}</td>
      `;
      procBody.appendChild(ptr);
    }
    procTable.appendChild(procBody);
    procDiv.appendChild(procTable);
    body.appendChild(procDiv);
  }

  // ── Server Metrics (raw)
  if (row.serverMetrics) {
    const sm = row.serverMetrics;
    const smEntries = [
      ['Received Requests', sm.receivedRequests?.toLocaleString()],
      ['Dropped Requests', sm.droppedRequests?.toLocaleString()],
      ['Deferred Appends', sm.deferredAppends?.toLocaleString()],
      ['Jobs Pushed', sm.jobsPushed?.toLocaleString()],
      ['Jobs Push Failed', sm.jobsPushFailed?.toLocaleString()],
      ['Records Processed', sm.recordsProcessed?.toLocaleString()],
      ['Backpressure Limit', sm.backpressureLimit?.toLocaleString()],
      ['Backpressure Inflight', sm.backpressureInflight?.toLocaleString()],
      ['Job Activation Avg', sm.jobActivationAvgMs != null ? sm.jobActivationAvgMs.toFixed(1) + ' ms' : '—'],
      ['Job Lifetime Avg', sm.jobLifetimeAvgMs != null ? sm.jobLifetimeAvgMs.toFixed(1) + ' ms' : '—'],
      ['PI Execution Avg', sm.piExecutionAvgMs != null ? sm.piExecutionAvgMs.toFixed(1) + ' ms' : '—'],
    ];
    const smSection = buildSection('Server Metrics', smEntries);
    body.appendChild(smSection);
  }

  // Show
  popover.classList.remove('hidden');
  document.body.style.overflow = 'hidden';

  // Close handlers
  const close = () => {
    popover.classList.add('hidden');
    document.body.style.overflow = '';
  };
  backdrop.onclick = close;
  closeBtn.onclick = close;
  const keyHandler = (e) => {
    if (e.key === 'Escape') { close(); document.removeEventListener('keydown', keyHandler); }
  };
  document.addEventListener('keydown', keyHandler);
}

function buildSection(title, rows) {
  const div = document.createElement('div');
  div.className = 'popover-section';

  const h3 = document.createElement('h3');
  h3.textContent = title;
  div.appendChild(h3);

  const dl = document.createElement('dl');
  dl.className = 'detail-grid';
  for (const [label, value, className] of rows) {
    const dt = document.createElement('dt');
    dt.textContent = label;
    dl.appendChild(dt);
    const dd = document.createElement('dd');
    dd.textContent = value ?? '—';
    if (className) dd.className = className;
    dl.appendChild(dd);
  }
  div.appendChild(dl);
  return div;
}

// ─── Insights Tab ────────────────────────────────────────

function renderInsights() {
  if (enrichedData.length === 0) return;

  renderLeaderboard();
  renderWinnersTable();
  renderHeatmaps();
}

/**
 * For each unique dimension combo (cluster, handler, totalWorkers, workersPerProcess),
 * find the language+mode with the highest throughput.
 * Returns { winners: [{dims, winner, throughput, ...}], leaderboard: [{langMode, wins}] }
 */
function computeWinners() {
  // Group scenarios by their "race" — same cluster + handler + totalWorkers + WPP
  const races = new Map();
  for (const s of enrichedData) {
    const key = `${s.cluster}|${s.handlerType}|${s.totalWorkers}|${s.workersPerProcess}`;
    if (!races.has(key)) races.set(key, []);
    races.get(key).push(s);
  }

  const winners = [];
  for (const [key, contestants] of races) {
    // Find the one with best throughput
    let best = null;
    for (const c of contestants) {
      if (c.aggregateThroughput == null) continue;
      if (!best || c.aggregateThroughput > best.aggregateThroughput) best = c;
    }
    if (!best) continue;
    const [cluster, handler, tw, wpp] = key.split('|');
    winners.push({
      cluster,
      handler,
      totalWorkers: Number(tw),
      workersPerProcess: Number(wpp),
      processes: Number(tw) / Number(wpp),
      winner: `${best.sdkLanguage} / ${best.sdkMode}`,
      throughput: best.aggregateThroughput,
      runnerUp: (() => {
        const others = contestants.filter((c) => c !== best && c.aggregateThroughput != null);
        others.sort((a, b) => b.aggregateThroughput - a.aggregateThroughput);
        return others[0] ? { name: `${others[0].sdkLanguage} / ${others[0].sdkMode}`, throughput: others[0].aggregateThroughput } : null;
      })(),
    });
  }

  // Sort winners by throughput descending
  winners.sort((a, b) => b.throughput - a.throughput);

  // Leaderboard: count wins per language+mode
  const winCounts = new Map();
  for (const w of winners) {
    winCounts.set(w.winner, (winCounts.get(w.winner) || 0) + 1);
  }
  const leaderboard = [...winCounts.entries()]
    .map(([langMode, wins]) => ({ langMode, wins }))
    .sort((a, b) => b.wins - a.wins);

  return { winners, leaderboard };
}

function renderLeaderboard() {
  const { leaderboard, winners } = computeWinners();
  const totalRaces = winners.length;

  const head = document.getElementById('leaderboard-head');
  const body = document.getElementById('leaderboard-body');
  head.innerHTML = '';
  body.innerHTML = '';

  const cols = ['#', 'Language + Mode', 'Wins', 'Win %', 'Trend'];
  for (const c of cols) {
    const th = document.createElement('th');
    th.textContent = c;
    if (c === '#') th.style.cssText = 'width: 36px; text-align: center;';
    if (['Wins', 'Win %'].includes(c)) th.className = 'num';
    head.appendChild(th);
  }

  for (let i = 0; i < leaderboard.length; i++) {
    const { langMode, wins } = leaderboard[i];
    const pct = totalRaces > 0 ? ((wins / totalRaces) * 100).toFixed(1) : '0';
    const tr = document.createElement('tr');

    const tdRank = document.createElement('td');
    tdRank.className = 'rank';
    tdRank.textContent = String(i + 1);
    tr.appendChild(tdRank);

    const tdName = document.createElement('td');
    tdName.className = 'winner';
    tdName.textContent = langMode;
    tr.appendChild(tdName);

    const tdWins = document.createElement('td');
    tdWins.className = 'num';
    tdWins.textContent = String(wins);
    tr.appendChild(tdWins);

    const tdPct = document.createElement('td');
    tdPct.className = 'num';
    tdPct.textContent = pct + '%';
    tr.appendChild(tdPct);

    // Mini bar
    const tdBar = document.createElement('td');
    const maxWins = leaderboard[0].wins;
    const barWidth = maxWins > 0 ? (wins / maxWins) * 100 : 0;
    tdBar.innerHTML = `<div style="background: var(--green); height: 8px; border-radius: 4px; width: ${barWidth}%; opacity: 0.7;"></div>`;
    tr.appendChild(tdBar);

    body.appendChild(tr);
  }
}

function renderWinnersTable() {
  const { winners } = computeWinners();

  const head = document.getElementById('winners-head');
  const body = document.getElementById('winners-body');
  head.innerHTML = '';
  body.innerHTML = '';

  const cols = [
    { label: '#', cls: '' },
    { label: 'Cluster', cls: '' },
    { label: 'Handler', cls: '' },
    { label: 'Workers', cls: 'num' },
    { label: 'WPP', cls: 'num' },
    { label: 'Processes', cls: 'num' },
    { label: 'Winner', cls: '' },
    { label: 'Throughput', cls: 'num' },
    { label: 'Runner-up', cls: '' },
    { label: 'Gap', cls: 'num' },
  ];

  for (const c of cols) {
    const th = document.createElement('th');
    th.textContent = c.label;
    if (c.cls) th.className = c.cls;
    if (c.label === '#') th.style.cssText = 'width: 36px; text-align: center;';
    head.appendChild(th);
  }

  for (let i = 0; i < winners.length; i++) {
    const w = winners[i];
    const tr = document.createElement('tr');

    const cells = [
      { text: String(i + 1), cls: 'rank' },
      { text: w.cluster, cls: '' },
      { text: w.handler, cls: '' },
      { text: String(w.totalWorkers), cls: 'num' },
      { text: String(w.workersPerProcess), cls: 'num' },
      { text: String(w.processes), cls: 'num' },
      { text: w.winner, cls: 'winner' },
      { text: w.throughput.toFixed(1), cls: 'num' },
      { text: w.runnerUp ? w.runnerUp.name : '—', cls: '' },
      { text: w.runnerUp ? ((1 - w.runnerUp.throughput / w.throughput) * 100).toFixed(1) + '%' : '—', cls: 'num' },
    ];

    for (const c of cells) {
      const td = document.createElement('td');
      td.textContent = c.text;
      if (c.cls) td.className = c.cls;
      tr.appendChild(td);
    }
    body.appendChild(tr);
  }
}

function renderHeatmaps() {
  const grid = document.getElementById('heatmap-grid');
  const handlerSelect = document.getElementById('heatmap-handler');
  const clusterSelect = document.getElementById('heatmap-cluster');
  grid.innerHTML = '';

  const handler = handlerSelect.value;

  // Populate cluster dropdown from data
  const clusters = [...new Set(enrichedData.map((s) => s.cluster))].sort();
  if (clusterSelect.options.length === 0 || clusterSelect.dataset.built !== clusters.join(',')) {
    clusterSelect.innerHTML = '';
    for (const c of clusters) {
      const opt = document.createElement('option');
      opt.value = c;
      opt.textContent = c;
      clusterSelect.appendChild(opt);
    }
    clusterSelect.dataset.built = clusters.join(',');
  }
  const cluster = clusterSelect.value;

  // Filter to selected handler + cluster
  const subset = enrichedData.filter((s) => s.handlerType === handler && s.cluster === cluster);

  // Group by language+mode
  const langModes = new Map();
  for (const s of subset) {
    const key = `${s.sdkLanguage} / ${s.sdkMode}`;
    if (!langModes.has(key)) langModes.set(key, []);
    langModes.get(key).push(s);
  }

  // Determine axis values across ALL language+modes for consistent axes
  const allWorkers = [...new Set(subset.map((s) => s.totalWorkers))].sort((a, b) => a - b);
  const allWPP = [...new Set(subset.map((s) => s.workersPerProcess))].sort((a, b) => a - b);

  // Find global max throughput for consistent color scale
  let globalMax = 0;
  for (const s of subset) {
    if (s.aggregateThroughput > globalMax) globalMax = s.aggregateThroughput;
  }

  for (const [langMode, scenarios] of langModes) {
    const card = document.createElement('div');
    card.className = 'heatmap-card';

    const h3 = document.createElement('h3');
    h3.textContent = langMode;
    card.appendChild(h3);

    // Build lookup: (totalWorkers, wpp) -> throughput
    const lookup = new Map();
    let localMax = 0;
    for (const s of scenarios) {
      const k = `${s.totalWorkers}|${s.workersPerProcess}`;
      if (s.aggregateThroughput != null) {
        lookup.set(k, s.aggregateThroughput);
        if (s.aggregateThroughput > localMax) localMax = s.aggregateThroughput;
      }
    }

    const table = document.createElement('table');

    // Header row: WPP values
    const thead = document.createElement('thead');
    const headerRow = document.createElement('tr');
    const cornerTh = document.createElement('th');
    cornerTh.className = 'row-label';
    cornerTh.textContent = 'W \\ WPP';
    headerRow.appendChild(cornerTh);
    for (const wpp of allWPP) {
      const th = document.createElement('th');
      th.textContent = String(wpp);
      headerRow.appendChild(th);
    }
    thead.appendChild(headerRow);
    table.appendChild(thead);

    // Body: rows = totalWorkers, cols = WPP
    const tbody = document.createElement('tbody');
    for (const w of allWorkers) {
      const tr = document.createElement('tr');
      const labelTd = document.createElement('th');
      labelTd.className = 'row-label';
      labelTd.textContent = String(w);
      tr.appendChild(labelTd);

      for (const wpp of allWPP) {
        const td = document.createElement('td');
        // Only valid if totalWorkers divisible by wpp
        if (w % wpp !== 0) {
          td.className = 'empty';
          td.textContent = '—';
        } else {
          const val = lookup.get(`${w}|${wpp}`);
          if (val != null) {
            td.textContent = val.toFixed(0);
            // Color: interpolate from dark blue (cold) to red/orange (hot)
            const intensity = globalMax > 0 ? val / globalMax : 0;
            td.style.background = heatColor(intensity);
            td.style.color = intensity > 0.35 ? '#000' : 'var(--text)';
            td.title = `${val.toFixed(1)} ops/s | W=${w}, WPP=${wpp}, P=${w/wpp}`;
          } else {
            td.className = 'empty';
            td.textContent = '—';
          }
        }
        tr.appendChild(td);
      }
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    card.appendChild(table);

    // Axis labels
    const xLabel = document.createElement('div');
    xLabel.className = 'axis-label';
    xLabel.textContent = 'Workers Per Process →';
    card.appendChild(xLabel);

    grid.appendChild(card);
  }
}

/**
 * Map a 0..1 intensity to a heatmap color.
 * 0 = cool (dark blue), 0.5 = warm (yellow), 1 = hot (bright red/orange).
 */
function heatColor(t) {
  // 5-stop gradient: #1a1a2e → #16537e → #f6d365 → #fda085 → #f85149
  const stops = [
    [26, 26, 46],     // 0.0 — dark blue
    [22, 83, 126],    // 0.25 — blue
    [246, 211, 101],  // 0.5 — yellow
    [253, 160, 133],  // 0.75 — peach
    [248, 81, 73],    // 1.0 — red
  ];
  const idx = Math.min(t * (stops.length - 1), stops.length - 1.001);
  const lo = Math.floor(idx);
  const hi = lo + 1;
  const frac = idx - lo;
  const r = Math.round(stops[lo][0] + (stops[hi][0] - stops[lo][0]) * frac);
  const g = Math.round(stops[lo][1] + (stops[hi][1] - stops[lo][1]) * frac);
  const b = Math.round(stops[lo][2] + (stops[hi][2] - stops[lo][2]) * frac);
  return `rgb(${r}, ${g}, ${b})`;
}

// ─── Boot ────────────────────────────────────────────────

init();
