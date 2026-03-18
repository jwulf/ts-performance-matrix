/**
 * One-time script to patch aggregateThroughput in local committed run data files.
 *
 * Old data used `totalCompleted / runnerWallClockS` which included GCS overhead.
 * This patches it to `totalCompleted / max(processWallClockS)`.
 *
 * Usage: npx tsx scripts/patch-throughput.ts
 */

import * as fs from 'fs';
import * as path from 'path';

const RUNS_DIR = path.resolve(import.meta.dirname, '..', 'results', 'runs');

function patchScenario(scenario: any): boolean {
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

  const current = scenario.aggregateThroughput || 0;
  if (current > 0 && Math.abs(corrected - current) / current < 0.05) return false;

  const oldVal = scenario.aggregateThroughput;
  scenario.aggregateThroughput = corrected;
  console.log(`  ${scenario.scenarioId}: ${oldVal?.toFixed(1)} → ${corrected.toFixed(1)}`);
  return true;
}

const files = fs.readdirSync(RUNS_DIR).filter((f) => f.startsWith('run-') && f.endsWith('.json') && !f.endsWith('.meta.json'));

let totalPatched = 0;
for (const file of files) {
  const filePath = path.join(RUNS_DIR, file);
  console.log(`Processing ${file}...`);
  const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  if (!Array.isArray(data)) {
    console.log(`  Skipped (not an array)`);
    continue;
  }

  let patched = 0;
  for (const scenario of data) {
    if (patchScenario(scenario)) patched++;
  }

  if (patched > 0) {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n');
    console.log(`  Patched ${patched}/${data.length} scenarios — file updated`);
    totalPatched += patched;
  } else {
    console.log(`  No changes needed (${data.length} scenarios)`);
  }
}

console.log(`\nDone. ${totalPatched} total scenarios patched across ${files.length} files.`);
