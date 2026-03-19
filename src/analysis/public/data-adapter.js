/**
 * Data adapter — abstracts data fetching for GitHub Pages vs local server modes.
 *
 * - GitHub Pages mode: fetches committed JSON from raw.githubusercontent.com
 * - Local server mode: fetches from the Node.js analysis server (/api/...)
 *
 * Mode is auto-detected from hostname but can be forced via ?mode=local|github query param.
 */

// ─── Configuration ───────────────────────────────────────

const GITHUB_OWNER = 'jwulf';
const GITHUB_REPO = 'ts-performance-matrix';
const GITHUB_BRANCH = 'main';
const GITHUB_RAW_BASE = `https://raw.githubusercontent.com/${GITHUB_OWNER}/${GITHUB_REPO}/${GITHUB_BRANCH}`;

// ─── Mode Detection ──────────────────────────────────────

function detectMode() {
  const params = new URLSearchParams(window.location.search);
  const forced = params.get('mode');
  if (forced === 'local') return 'local';
  if (forced === 'github') return 'github';

  const host = window.location.hostname;
  if (host.endsWith('.github.io') || host === 'github.io') return 'github';
  return 'local';
}

const DATA_MODE = detectMode();

// ─── Shared Helpers ──────────────────────────────────────

async function fetchJsonWithTimeout(url, timeoutMs = 60_000) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timeoutId);
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
    }
    return res.json();
  } catch (e) {
    clearTimeout(timeoutId);
    throw e;
  }
}

// ─── GitHub Pages Adapter ────────────────────────────────

const github = {
  async listRuns() {
    const index = await fetchJsonWithTimeout(
      `${GITHUB_RAW_BASE}/results/runs/index.json`
    );
    // Map index entries to RunInfo shape expected by the UI
    return index.map((entry) => ({
      runId: entry.runId,
      timestamp: entry.timestamp,
      lanes: 0,
      source: 'local',
      scenarios: entry.scenarios,
      hasMeta: entry.hasMeta,
    }));
  },

  async loadRun(runId, _refresh, onProgress) {
    onProgress?.('Fetching run data from GitHub...');
    const data = await fetchJsonWithTimeout(
      `${GITHUB_RAW_BASE}/results/runs/${runId}.json`,
      300_000 // 5 min — large files
    );
    onProgress?.(`Loaded ${data.length} scenarios`);
    return data;
  },

  async loadRunMetadata(runId) {
    try {
      return await fetchJsonWithTimeout(
        `${GITHUB_RAW_BASE}/results/runs/${runId}.meta.json`
      );
    } catch {
      return null; // metadata is optional
    }
  },
};

// ─── Local Server Adapter ────────────────────────────────

const local = {
  async listRuns() {
    return fetchJsonWithTimeout('/api/runs', 600_000);
  },

  /**
   * Load run data via SSE (streaming progress) or plain JSON.
   * When onProgress is provided, uses SSE for live progress updates.
   */
  loadRun(runId, refresh = false, onProgress) {
    if (!onProgress) {
      // Simple JSON fetch (no streaming)
      const url = `/api/runs/${runId}${refresh ? '?refresh=1' : ''}`;
      return fetchJsonWithTimeout(url, 600_000);
    }

    // SSE streaming for progress updates
    const url = `/api/runs/${runId}?stream=1${refresh ? '&refresh=1' : ''}`;
    return new Promise((resolve, reject) => {
      const es = new EventSource(url);

      es.addEventListener('progress', (e) => {
        onProgress(e.data);
      });

      es.addEventListener('data', (e) => {
        es.close();
        try {
          resolve(JSON.parse(e.data));
        } catch (err) {
          reject(new Error('Failed to parse response data'));
        }
      });

      es.addEventListener('error', (e) => {
        if (e.data) {
          es.close();
          reject(new Error(e.data));
        } else if (es.readyState === EventSource.CLOSED) {
          reject(new Error('Connection closed without result'));
        }
      });
    });
  },

  async loadRunMetadata(runId) {
    return fetchJsonWithTimeout(`/api/runs/${runId}/metadata`);
  },
};

// ─── Public API ──────────────────────────────────────────

const adapter = DATA_MODE === 'github' ? github : local;

/**
 * @returns {'github' | 'local'}
 */
function getDataMode() {
  return DATA_MODE;
}

/**
 * Whether GCS refresh is available (only in local mode).
 */
function canRefresh() {
  return DATA_MODE === 'local';
}

export { adapter, getDataMode, canRefresh };
