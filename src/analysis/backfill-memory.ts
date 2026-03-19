/**
 * Backfill client memory stats into cached run data.
 *
 * For each scenario where processResults lack memoryUsage,
 * fetches the individual process-N.json files from GCS and
 * patches the cached JSON.
 *
 * Usage: node --import tsx/esm src/analysis/backfill-memory.ts [runId]
 */

import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

const BUCKET = 'camunda-perf-matrix';
const CACHE_DIR = '/tmp/analysis-cache';

function log(msg: string) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

/** Return true if memoryUsage contains real RSS data (not legacy JVM heap). */
function hasRealRssData(mem: any): boolean {
  if (!mem || typeof mem !== 'object') return false;
  // Legacy Java data has peakHeapMb/avgHeapMb — not real RSS, discard it
  if (typeof mem.peakHeapMb === 'number' || typeof mem.avgHeapMb === 'number') return false;
  return typeof mem.peakRssMb === 'number';
}

function gsutilCat(gcsPath: string): string | null {
  try {
    return execSync(`gsutil cat "${gcsPath}"`, {
      encoding: 'utf-8',
      timeout: 15_000,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  } catch {
    return null;
  }
}

async function backfill(runId: string) {
  const cacheFile = path.join(CACHE_DIR, `${runId}.json`);
  if (!fs.existsSync(cacheFile)) {
    log(`Cache file not found: ${cacheFile}`);
    process.exit(1);
  }

  const scenarios: any[] = JSON.parse(fs.readFileSync(cacheFile, 'utf-8'));
  log(`Loaded ${scenarios.length} scenarios from cache`);

  // Find which scenarios need backfill
  const needsBackfill = scenarios.filter((s) =>
    s.processResults?.some((p: any) => !p.memoryUsage)
  );
  log(`${needsBackfill.length} scenarios need memory backfill`);

  if (needsBackfill.length === 0) {
    log('Nothing to do');
    return;
  }

  // Find all lane dirs for this run
  const timestamp = runId.replace('run-', '');
  const listing = execSync(`gsutil ls gs://${BUCKET}/`, {
    encoding: 'utf-8',
    timeout: 30_000,
  }).trim();
  const laneDirs = listing.split('\n')
    .filter((l) => l.includes(`run-${timestamp}-l`))
    .map((l) => l.trim().replace(/\/$/, ''));
  log(`Found ${laneDirs.length} lanes`);

  let patched = 0;
  let fetchCount = 0;

  for (const scenario of needsBackfill) {
    const sid = scenario.scenarioId;
    const procs = scenario.processResults || [];
    let scenarioPatched = false;

    // Find which lane has this scenario (check process-0 across lanes)
    let scenarioLane: string | null = null;
    for (const laneDir of laneDirs) {
      const testPath = `${laneDir}/scenarios/${sid}/results/process-0.json`;
      fetchCount++;
      const raw = gsutilCat(testPath);
      if (raw) {
        scenarioLane = laneDir;
        // While we're at it, parse process-0
        try {
          const parsed = JSON.parse(raw);
          if (hasRealRssData(parsed.memoryUsage) && procs[0]) {
            procs[0].memoryUsage = parsed.memoryUsage;
            scenarioPatched = true;
          }
        } catch { /* skip */ }
        break;
      }
    }

    if (!scenarioLane) {
      log(`  ${sid}: not found in any lane, skipping`);
      continue;
    }

    // Fetch remaining processes from the same lane
    for (const proc of procs) {
      if (proc.memoryUsage) continue;
      const gcsPath = `${scenarioLane}/scenarios/${sid}/results/${proc.processId}.json`;
      fetchCount++;
      const raw = gsutilCat(gcsPath);
      if (raw) {
        try {
          const parsed = JSON.parse(raw);
          if (hasRealRssData(parsed.memoryUsage)) {
            proc.memoryUsage = parsed.memoryUsage;
            scenarioPatched = true;
          }
        } catch { /* skip */ }
      }
    }

    if (scenarioPatched) {
      patched++;
      log(`  ${sid}: patched (${procs.filter((p: any) => p.memoryUsage).length}/${procs.length} processes have memory data)`);
    }
  }

  console.log('');
  log(`Patched ${patched} scenarios with ${fetchCount} GCS fetches`);

  // Write back
  fs.writeFileSync(cacheFile, JSON.stringify(scenarios, null, 2));
  log(`Updated cache: ${cacheFile}`);
}

const runId = process.argv[2] || 'run-1773706367477';
backfill(runId);
