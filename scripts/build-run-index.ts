/**
 * Generate results/runs/index.json from committed run data files.
 *
 * Scans results/runs/run-*.json (excluding .meta.json) and produces a
 * manifest array sorted by timestamp descending. This file is consumed
 * by the GitHub Pages front-end to list available runs without needing
 * a server or directory listing.
 *
 * Usage: node --import tsx/esm scripts/build-run-index.ts
 */

import * as fs from 'fs';
import * as path from 'path';

const RUNS_DIR = path.resolve(import.meta.dirname, '..', 'results', 'runs');
const INDEX_FILE = path.join(RUNS_DIR, 'index.json');

interface RunIndexEntry {
  runId: string;
  timestamp: number;
  scenarios: number;
  hasMeta: boolean;
}

const files = fs.readdirSync(RUNS_DIR)
  .filter((f) => f.startsWith('run-') && f.endsWith('.json') && !f.endsWith('.meta.json'));

const entries: RunIndexEntry[] = [];

for (const file of files) {
  const runId = file.replace('.json', '');
  const timestamp = parseInt(runId.replace('run-', ''), 10);
  const hasMeta = fs.existsSync(path.join(RUNS_DIR, `${runId}.meta.json`));

  // Count scenarios in the data file
  let scenarios = 0;
  try {
    const data = JSON.parse(fs.readFileSync(path.join(RUNS_DIR, file), 'utf-8'));
    if (Array.isArray(data)) scenarios = data.length;
  } catch { /* corrupt file — include with 0 scenarios */ }

  entries.push({ runId, timestamp, scenarios, hasMeta });
}

entries.sort((a, b) => b.timestamp - a.timestamp);

fs.writeFileSync(INDEX_FILE, JSON.stringify(entries, null, 2) + '\n');
console.log(`Wrote ${INDEX_FILE} — ${entries.length} runs`);
