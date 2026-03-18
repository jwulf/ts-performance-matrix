/**
 * Data loader — serves run data from local committed files, /tmp cache, or GCS.
 *
 * Priority: local repo data → /tmp cache → GCS fetch.
 * If gsutil is unavailable, only local + cached data are served.
 */

import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

const BUCKET = 'camunda-perf-matrix';
const CACHE_DIR = '/tmp/analysis-cache';
const LOCAL_DATA_DIR = path.resolve(import.meta.dirname, '../..', 'results', 'runs');

function log(msg: string): void {
  console.log(`[${new Date().toISOString()}] [data-loader] ${msg}`);
}

export interface RunInfo {
  runId: string;
  timestamp: number;
  lanes: number;
  source: 'local' | 'cache' | 'gcs';
}

/** Check once whether gsutil is usable. */
let _gsutilAvailable: boolean | null = null;
function hasGsutil(): boolean {
  if (_gsutilAvailable !== null) return _gsutilAvailable;
  try {
    execSync('gsutil version', { encoding: 'utf-8', timeout: 5_000, stdio: ['pipe', 'pipe', 'pipe'] });
    _gsutilAvailable = true;
    log('gsutil: available');
  } catch {
    _gsutilAvailable = false;
    log('gsutil: NOT available — will serve local/cached data only');
  }
  return _gsutilAvailable;
}

function ensureCacheDir(): void {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
}

function gsutil(args: string[], timeoutMs = 30_000): string {
  const cmd = `gsutil ${args.join(' ')}`;
  const t0 = Date.now();
  try {
    const result = execSync(cmd, {
      encoding: 'utf-8',
      timeout: timeoutMs,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    log(`  gsutil ${args[0]} OK (${Date.now() - t0}ms, ${result.split('\n').length} lines)`);
    return result;
  } catch (e: any) {
    const elapsed = Date.now() - t0;
    const stderr = e.stderr ? String(e.stderr).trim().slice(0, 200) : '';
    log(`  gsutil ${args[0]} FAILED (${elapsed}ms): ${e.message.slice(0, 100)}${stderr ? ' | stderr: ' + stderr : ''}`);
    return '';
  }
}

/**
 * List local committed runs (results/runs/*.json).
 */
function listLocalRuns(): RunInfo[] {
  if (!fs.existsSync(LOCAL_DATA_DIR)) return [];
  const files = fs.readdirSync(LOCAL_DATA_DIR).filter((f) => f.startsWith('run-') && f.endsWith('.json') && !f.endsWith('.meta.json'));
  return files.map((f) => {
    const runId = f.replace('.json', '');
    const ts = parseInt(runId.replace('run-', ''), 10);
    return { runId, timestamp: ts, lanes: 0, source: 'local' as const };
  });
}

/**
 * List cached runs (/tmp/analysis-cache/*.json).
 */
function listCachedRuns(): RunInfo[] {
  if (!fs.existsSync(CACHE_DIR)) return [];
  const files = fs.readdirSync(CACHE_DIR).filter((f) => f.startsWith('run-') && f.endsWith('.json'));
  return files.map((f) => {
    const runId = f.replace('.json', '');
    const ts = parseInt(runId.replace('run-', ''), 10);
    return { runId, timestamp: ts, lanes: 0, source: 'cache' as const };
  });
}

/**
 * List all runs from local files, cache, and (if available) GCS.
 * Deduplicates by runId — local wins over cache wins over GCS.
 */
export function listRuns(): RunInfo[] {
  log('listRuns: scanning sources...');
  const runMap = new Map<string, RunInfo>();

  // 1. Local committed data (highest priority label)
  for (const r of listLocalRuns()) {
    runMap.set(r.runId, r);
  }
  log(`listRuns: ${runMap.size} local runs`);

  // 2. Cached data
  for (const r of listCachedRuns()) {
    if (!runMap.has(r.runId)) runMap.set(r.runId, r);
  }
  log(`listRuns: ${runMap.size} total after cache`);

  // 3. GCS (if available)
  if (hasGsutil()) {
    const output = gsutil(['ls', `gs://${BUCKET}/`], 60_000);
    if (output) {
      const gcsLanes = new Map<string, { timestamp: number; lanes: Set<number> }>();
      for (const line of output.split('\n')) {
        const match = line.match(/run-(\d+)-l(\d+)\/?$/);
        if (!match) continue;
        const timestamp = parseInt(match[1], 10);
        const lane = parseInt(match[2], 10);
        const runId = `run-${match[1]}`;
        if (!gcsLanes.has(runId)) gcsLanes.set(runId, { timestamp, lanes: new Set() });
        gcsLanes.get(runId)!.lanes.add(lane);
      }
      for (const [runId, info] of gcsLanes) {
        if (!runMap.has(runId)) {
          runMap.set(runId, { runId, timestamp: info.timestamp, lanes: info.lanes.size, source: 'gcs' });
        } else {
          // Update lane count even for local/cached entries
          const existing = runMap.get(runId)!;
          if (info.lanes.size > existing.lanes) existing.lanes = info.lanes.size;
        }
      }
      log(`listRuns: ${runMap.size} total after GCS`);
    }
  }

  const runs = Array.from(runMap.values()).sort((a, b) => b.timestamp - a.timestamp);
  log(`listRuns: returning ${runs.length} runs`);
  return runs;
}

export type ProgressCallback = (msg: string) => void;

/**
 * Load metadata for a run (if available).
 * Checks local repo sidecar (run-XXX.meta.json) → /tmp cache sidecar → GCS metadata.json.
 * Returns null if no metadata is found.
 */
export function loadRunMetadata(runId: string): Record<string, any> | null {
  // 1. Local committed metadata sidecar
  const localMeta = path.join(LOCAL_DATA_DIR, `${runId}.meta.json`);
  if (fs.existsSync(localMeta)) {
    try {
      return JSON.parse(fs.readFileSync(localMeta, 'utf-8'));
    } catch { /* ignore corrupt */ }
  }

  // 2. /tmp cache sidecar
  const cacheMeta = path.join(CACHE_DIR, `${runId}.meta.json`);
  if (fs.existsSync(cacheMeta)) {
    try {
      return JSON.parse(fs.readFileSync(cacheMeta, 'utf-8'));
    } catch { /* ignore corrupt */ }
  }

  // 3. GCS: try to fetch metadata.json from any lane directory
  if (hasGsutil()) {
    const timestamp = runId.replace('run-', '');
    // Try lane 0 first (always exists)
    const gcsPath = `gs://${BUCKET}/run-${timestamp}-l0/metadata.json`;
    const tmpFile = path.join(CACHE_DIR, `tmp-meta-${Date.now()}.json`);
    try {
      execSync(`gsutil cp "${gcsPath}" "${tmpFile}"`, {
        encoding: 'utf-8', timeout: 10_000, stdio: ['pipe', 'pipe', 'pipe'],
      });
      const meta = JSON.parse(fs.readFileSync(tmpFile, 'utf-8'));
      // Cache it locally
      ensureCacheDir();
      fs.writeFileSync(cacheMeta, JSON.stringify(meta, null, 2));
      return meta;
    } catch { /* not found */ } finally {
      try { fs.unlinkSync(tmpFile); } catch { /* ignore */ }
    }
  }

  return null;
}

/**
 * Recompute aggregateThroughput using max worker wallClockS instead of runner wallClockS.
 *
 * Old data used `totalCompleted / runnerWallClockS` which included GCS barrier/upload
 * overhead. The correct metric is `totalCompleted / max(processWallClockS)`.
 *
 * We derive per-process wallClockS from `completed / throughput` (both stored in processResults).
 * Mutates the scenario object in place. Returns true if patched.
 */
function patchAggregateThroughput(scenario: any): boolean {
  const processResults = scenario?.processResults;
  if (!Array.isArray(processResults) || processResults.length === 0) return false;

  const processWallClocks: number[] = [];
  for (const p of processResults) {
    if (typeof p.throughput === 'number' && p.throughput > 0 && typeof p.completed === 'number' && p.completed > 0) {
      processWallClocks.push(p.completed / p.throughput);
    }
  }
  if (processWallClocks.length === 0) return false;

  const maxProcessWallClockS = Math.max(...processWallClocks);
  const totalCompleted = typeof scenario.totalCompleted === 'number'
    ? scenario.totalCompleted
    : processResults.reduce((s: number, p: any) => s + (p.completed || 0), 0);

  const corrected = maxProcessWallClockS > 0 ? totalCompleted / maxProcessWallClockS : 0;

  // Only patch if the difference is meaningful (>5% — avoids patching data that's already correct)
  const current = scenario.aggregateThroughput || 0;
  if (current > 0 && Math.abs(corrected - current) / current < 0.05) return false;

  scenario.aggregateThroughput = corrected;
  return true;
}

/**
 * Patch all scenarios in an array. Returns the number patched.
 */
function patchAllScenarios(scenarios: any[]): number {
  let patched = 0;
  for (const s of scenarios) {
    if (patchAggregateThroughput(s)) patched++;
  }
  return patched;
}

/**
 * Load cached scenarios into a Map keyed by scenarioId.
 * Returns an empty map if the cache doesn't exist or is corrupt.
 */
function loadCachedScenarios(cacheFile: string): Map<string, any> {
  const map = new Map<string, any>();
  if (!fs.existsSync(cacheFile)) return map;
  try {
    const arr = JSON.parse(fs.readFileSync(cacheFile, 'utf-8'));
    if (Array.isArray(arr)) {
      for (const item of arr) {
        const id = item?.scenarioId ?? item?.id;
        if (id) map.set(id, item);
      }
    }
  } catch { /* corrupt cache — start fresh */ }
  return map;
}

/**
 * Load all scenario results for a run.
 * Priority: local committed file → /tmp cache → GCS fetch.
 *
 * On refresh: performs an incremental fetch — loads existing cache as a
 * baseline and only downloads scenario summaries not already cached.
 */
export function loadRun(runId: string, forceRefresh = false, onProgress?: ProgressCallback): any[] {
  const t0 = Date.now();
  const progress = (msg: string) => {
    log(msg);
    onProgress?.(msg);
  };
  progress(`Loading ${runId}...`);

  // 1. Local committed data (always preferred unless force-refresh from GCS)
  const localFile = path.join(LOCAL_DATA_DIR, `${runId}.json`);
  if (!forceRefresh && fs.existsSync(localFile)) {
    try {
      const data = JSON.parse(fs.readFileSync(localFile, 'utf-8'));
      const patched = patchAllScenarios(data);
      if (patched > 0) progress(`Patched aggregateThroughput for ${patched} scenarios`);
      progress(`Serving from local repo data: ${data.length} scenarios`);
      return data;
    } catch (e: any) {
      progress(`Local file corrupt: ${e.message}`);
    }
  }

  // 2. /tmp cache
  ensureCacheDir();
  const cacheFile = path.join(CACHE_DIR, `${runId}.json`);
  if (!forceRefresh && fs.existsSync(cacheFile)) {
    try {
      const cached = JSON.parse(fs.readFileSync(cacheFile, 'utf-8'));
      const patched = patchAllScenarios(cached);
      if (patched > 0) progress(`Patched aggregateThroughput for ${patched} scenarios`);
      progress(`Serving from cache: ${cached.length} scenarios`);
      return cached;
    } catch (e: any) {
      progress(`Cache corrupt, re-fetching: ${e.message}`);
    }
  }

  // 3. GCS fetch (incremental — reuse cached scenarios as baseline)
  if (!hasGsutil()) {
    progress(`No GCS access and no local/cached data for ${runId}`);
    return [];
  }

  // Load existing cache as baseline for incremental refresh
  const cachedScenarios = loadCachedScenarios(cacheFile);
  if (cachedScenarios.size > 0) {
    progress(`Incremental refresh: ${cachedScenarios.size} scenarios already cached`);
  }

  // Find all lane directories for this run
  progress(`Listing bucket to find lanes...`);
  const output = gsutil(['ls', `gs://${BUCKET}/`], 60_000);
  if (!output) {
    progress(`No output from gsutil ls — returning empty`);
    return cachedScenarios.size > 0 ? Array.from(cachedScenarios.values()) : [];
  }

  const timestamp = runId.replace('run-', '');
  const laneDirs = output.split('\n')
    .filter((l) => l.includes(`run-${timestamp}-l`))
    .map((l) => l.trim().replace(/\/$/, ''));

  log(`loadRun: found ${laneDirs.length} lanes for ${runId}`);
  progress(`Found ${laneDirs.length} lanes`);

  // Start with cached results; we'll add newly fetched ones
  const resultMap = new Map(cachedScenarios);
  const seen = new Set<string>(cachedScenarios.keys());
  let totalScenarioDirs = 0;
  let skippedNoSummary = 0;
  let fetchedNew = 0;

  for (const laneDir of laneDirs) {
    // List scenarios in this lane
    const laneLabel = laneDir.split('/').pop();
    progress(`Scanning ${laneLabel}...`);
    const scenarioList = gsutil(['ls', `${laneDir}/scenarios/`], 60_000);
    if (!scenarioList) {
      progress(`No scenarios in ${laneLabel}`);
      continue;
    }

    const scenarioDirs = scenarioList.split('\n')
      .filter((l) => l.trim().length > 0)
      .map((l) => l.trim().replace(/\/$/, ''));

    log(`loadRun: ${scenarioDirs.length} scenarios in ${laneLabel}`);
    totalScenarioDirs += scenarioDirs.length;

    for (const scenarioDir of scenarioDirs) {
      const scenarioId = scenarioDir.split('/').pop()!;
      if (seen.has(scenarioId)) continue; // already cached or deduplicated

      // Download scenario-summary.json
      const summaryPath = `${scenarioDir}/results/scenario-summary.json`;
      const tmpFile = path.join(CACHE_DIR, `tmp-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);

      try {
        execSync(`gsutil cp "${summaryPath}" "${tmpFile}"`, {
          encoding: 'utf-8',
          timeout: 15_000,
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        const data = JSON.parse(fs.readFileSync(tmpFile, 'utf-8'));
        resultMap.set(scenarioId, data);
        seen.add(scenarioId);
        fetchedNew++;
        progress(`Fetched ${scenarioId} (${fetchedNew} new, ${resultMap.size} total)`);
      } catch (e: any) {
        // Log the actual failure reason
        const stderr = e.stderr ? String(e.stderr).trim().slice(0, 150) : '';
        const reason = stderr || e.message.slice(0, 100);
        log(`loadRun: SKIP ${scenarioId} — ${reason}`);
        skippedNoSummary++;
        // Don't add to seen — scenario summary might not exist yet (in-progress run),
        // so allow retry on next refresh
      } finally {
        try { fs.unlinkSync(tmpFile); } catch { /* ignore */ }
      }
    }
  }

  // Cache the merged results (with patched throughput)
  const results = Array.from(resultMap.values());
  const patched = patchAllScenarios(results);
  if (patched > 0) progress(`Patched aggregateThroughput for ${patched} scenarios`);
  fs.writeFileSync(cacheFile, JSON.stringify(results, null, 2));
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  progress(`Done: ${results.length} scenarios (${fetchedNew} new, ${patched} patched, ${cachedScenarios.size} cached), ${skippedNoSummary} skipped (no summary), ${elapsed}s`);

  return results;
}
