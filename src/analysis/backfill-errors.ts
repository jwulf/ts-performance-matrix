/**
 * Backfill error types into cached run data.
 *
 * For each scenario where processResults lack errorTypes,
 * fetches the individual process-N.json files from GCS and
 * patches the cached JSON.
 *
 * Usage: node --import tsx/esm src/analysis/backfill-errors.ts [runId]
 */

import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

const BUCKET = 'camunda-perf-matrix';
const CACHE_DIR = '/tmp/analysis-cache';

function log(msg: string) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
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

  // Find which scenarios need backfill (missing errorTypes on any process)
  const needsBackfill = scenarios.filter((s) =>
    s.processResults?.some((p: any) => !p.errorTypes)
  );
  log(`${needsBackfill.length} scenarios need errorTypes backfill`);

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
          if (parsed.errorTypes && procs[0]) {
            procs[0].errorTypes = parsed.errorTypes;
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
      if (proc.errorTypes) continue;
      const gcsPath = `${scenarioLane}/scenarios/${sid}/results/${proc.processId}.json`;
      fetchCount++;
      const raw = gsutilCat(gcsPath);
      if (raw) {
        try {
          const parsed = JSON.parse(raw);
          if (parsed.errorTypes) {
            proc.errorTypes = parsed.errorTypes;
            scenarioPatched = true;
          }
        } catch { /* skip */ }
      }
    }

    if (scenarioPatched) {
      patched++;
      const withErrors = procs.filter((p: any) => p.errorTypes && Object.keys(p.errorTypes).length > 0).length;
      log(`  ${sid}: patched (${withErrors}/${procs.length} processes have error data)`);
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
