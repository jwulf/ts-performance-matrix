#!/usr/bin/env tsx
/**
 * Performance Envelope Matrix Runner
 *
 * Answers: "For a given total worker count, what is the optimal split
 * between processes and workers-per-process?"
 *
 * Usage:
 *   # Local mode (Docker + child processes)
 *   npx tsx src/run-matrix.ts --local
 *
 *   # Subset local
 *   npx tsx src/run-matrix.ts --local --workers 10 --wpp 1,2,5,10 --modes rest-balanced --clusters 1broker
 *
 *   # GCP mode
 *   npx tsx src/run-matrix.ts --project my-gcp-project --zone us-central1-a --bucket perf-matrix
 *
 *   # Resume (skip already-completed scenarios)
 *   npx tsx src/run-matrix.ts --local --resume
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseArgs } from 'node:util';
import {
  generateMatrix,
  type SdkMode,
  type HandlerType,
  type ClusterConfig,
  DEFAULT_TARGET_PER_WORKER,
  DEFAULT_SCENARIO_TIMEOUT_S,
  DEFAULT_PRE_CREATE_COUNT,
} from './config.js';
import type { ScenarioResult } from './types.js';

// ─── CLI argument parsing ────────────────────────────────

const { values: argv } = parseArgs({
  options: {
    // Execution mode
    local: { type: 'boolean', default: false },
    project: { type: 'string' },
    zone: { type: 'string', default: 'us-central1-a' },
    bucket: { type: 'string', default: 'camunda-perf-matrix' },

    // Matrix filter
    workers: { type: 'string' },       // comma-separated total worker counts
    wpp: { type: 'string' },           // comma-separated workers-per-process
    modes: { type: 'string' },         // comma-separated SDK modes
    handlers: { type: 'string' },      // comma-separated handler types
    clusters: { type: 'string' },      // comma-separated cluster configs

    // Scenario params
    target: { type: 'string' },        // target completions per worker
    timeout: { type: 'string' },       // scenario timeout seconds
    precreate: { type: 'string' },     // pre-create count

    // Control
    resume: { type: 'boolean', default: false },
    'dry-run': { type: 'boolean', default: false },
    help: { type: 'boolean', default: false },
  },
  strict: false,
});

function printUsage(): void {
  console.log(`
Performance Envelope Matrix Runner

MODES:
  --local               Run locally using Docker + child processes
  --project <id>        Run on GCP (requires --project)

FILTERS (comma-separated):
  --workers 10,20       Total worker counts (default: 10,20,50)
  --wpp 1,2,5,10        Workers per process (default: 1,2,5,10,25,50)
  --modes rest-balanced  SDK modes (default: rest-balanced,grpc-poll)
  --handlers cpu,http   Handler types (default: cpu,http)
  --clusters 1broker    Cluster configs (default: 1broker,3broker)

SCENARIO PARAMS:
  --target 10000        Target completions per worker (default: ${DEFAULT_TARGET_PER_WORKER})
  --timeout 300         Scenario timeout in seconds (default: ${DEFAULT_SCENARIO_TIMEOUT_S})
  --precreate 50000     Pre-create instance count (default: ${DEFAULT_PRE_CREATE_COUNT})

CONTROL:
  --resume              Skip scenarios with existing result files
  --dry-run             Print scenarios without executing
  --help                Show this help
  `);
}

if (argv.help) {
  printUsage();
  process.exit(0);
}

if (!argv.local && !argv.project) {
  console.error('Error: specify --local or --project <gcp-project-id>');
  printUsage();
  process.exit(1);
}

// ─── Build matrix ────────────────────────────────────────

function parseList<T>(raw: string | undefined, valid: readonly string[]): T[] | undefined {
  if (!raw) return undefined;
  const items = raw.split(',').map((s) => s.trim()).filter(Boolean);
  for (const item of items) {
    if (!valid.includes(item)) {
      console.error(`Unknown value: "${item}". Valid: ${valid.join(', ')}`);
      process.exit(1);
    }
  }
  return items as T[];
}

function parseNumList(raw: string | undefined): number[] | undefined {
  if (!raw) return undefined;
  return raw.split(',').map((s) => parseInt(s.trim(), 10)).filter((n) => !isNaN(n));
}

// parseArgs types string options as string | boolean | undefined; narrow to string | undefined
const str = (v: string | boolean | undefined): string | undefined =>
  typeof v === 'string' ? v : undefined;

const scenarios = generateMatrix({
  totalWorkers: parseNumList(str(argv.workers)),
  workersPerProcess: parseNumList(str(argv.wpp)),
  sdkModes: parseList<SdkMode>(str(argv.modes), ['rest-balanced', 'grpc-poll']),
  handlerTypes: parseList<HandlerType>(str(argv.handlers), ['cpu', 'http']),
  clusters: parseList<ClusterConfig>(str(argv.clusters), ['1broker', '3broker']),
});

const targetPerWorker = str(argv.target) ? parseInt(str(argv.target)!, 10) : DEFAULT_TARGET_PER_WORKER;
const scenarioTimeout = str(argv.timeout) ? parseInt(str(argv.timeout)!, 10) : DEFAULT_SCENARIO_TIMEOUT_S;
const preCreateCount = str(argv.precreate) ? parseInt(str(argv.precreate)!, 10) : DEFAULT_PRE_CREATE_COUNT;

console.log(`Matrix: ${scenarios.length} scenarios`);
console.log(`  Target/worker: ${targetPerWorker}  Timeout: ${scenarioTimeout}s  Pre-create: ${preCreateCount}`);

if (argv['dry-run']) {
  console.log('\nScenarios:');
  for (const s of scenarios) {
    console.log(`  ${s.id}  (${s.topology.processes}P × ${s.topology.workersPerProcess}WPP = ${s.topology.totalWorkers}W)`);
  }
  process.exit(0);
}

// ─── Results tracking ────────────────────────────────────

const REPO_ROOT = path.resolve(import.meta.dirname, '..');
const RESULTS_DIR = path.join(REPO_ROOT, 'results');

function resultsDir(mode: string): string {
  return path.join(RESULTS_DIR, mode);
}

function resultExists(scenarioId: string, mode: string): boolean {
  const filePath = path.join(resultsDir(mode), `${scenarioId}.json`);
  return fs.existsSync(filePath);
}

function saveResult(result: ScenarioResult, mode: string): void {
  const dir = resultsDir(mode);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, `${result.scenarioId}.json`),
    JSON.stringify(result, null, 2),
  );
}

// ─── Report generation ───────────────────────────────────

function generateReport(results: ScenarioResult[], mode: string): void {
  const reportDir = path.join(RESULTS_DIR, mode);
  fs.mkdirSync(reportDir, { recursive: true });

  // Summary JSON
  const summary = {
    timestamp: new Date().toISOString(),
    mode,
    totalScenarios: results.length,
    completed: results.filter((r) => r.status === 'ok').length,
    timedOut: results.filter((r) => r.status === 'timeout').length,
    errored: results.filter((r) => r.status === 'error').length,
    scenarios: results.map((r) => ({
      id: r.scenarioId,
      W: r.totalWorkers,
      P: r.processes,
      WPP: r.workersPerProcess,
      mode: r.sdkMode,
      handler: r.handlerType,
      cluster: r.cluster,
      throughput: Math.round(r.aggregateThroughput),
      errors: r.totalErrors,
      wallClockS: Math.round(r.wallClockS * 10) / 10,
      fairness: Math.round(r.jainFairness * 1000) / 1000,
      status: r.status,
    })),
  };

  fs.writeFileSync(
    path.join(reportDir, 'summary.json'),
    JSON.stringify(summary, null, 2),
  );

  // Markdown report
  const lines: string[] = [
    '# Performance Envelope Results',
    '',
    `Generated: ${summary.timestamp}`,
    `Mode: ${mode}`,
    `Scenarios: ${summary.totalScenarios} (${summary.completed} ok, ${summary.timedOut} timeout, ${summary.errored} error)`,
    '',
  ];

  // Group by total workers
  const byW = new Map<number, typeof summary.scenarios>();
  for (const s of summary.scenarios) {
    const arr = byW.get(s.W) || [];
    arr.push(s);
    byW.set(s.W, arr);
  }

  for (const [W, scenariosForW] of [...byW.entries()].sort((a, b) => a[0] - b[0])) {
    lines.push(`## W=${W} Total Workers`);
    lines.push('');
    lines.push('| Topology | SDK Mode | Handler | Cluster | Throughput | Errors | Time (s) | Fairness | Status |');
    lines.push('|----------|----------|---------|---------|------------|--------|----------|----------|--------|');

    for (const s of scenariosForW.sort((a, b) => b.throughput - a.throughput)) {
      lines.push(
        `| ${s.P}×${s.WPP} | ${s.mode} | ${s.handler} | ${s.cluster} | ${s.throughput}/s | ${s.errors} | ${s.wallClockS} | ${s.fairness} | ${s.status} |`,
      );
    }
    lines.push('');
  }

  // Cross-cutting: best topology per (W, mode, handler)
  lines.push('## Best Topology by Configuration');
  lines.push('');
  lines.push('| W | SDK Mode | Handler | Best Topology | Throughput | Fairness |');
  lines.push('|---|----------|---------|---------------|------------|----------|');

  const grouped = new Map<string, typeof summary.scenarios>();
  for (const s of summary.scenarios.filter((s) => s.status === 'ok')) {
    const key = `${s.W}-${s.mode}-${s.handler}`;
    const arr = grouped.get(key) || [];
    arr.push(s);
    grouped.set(key, arr);
  }

  for (const [, group] of [...grouped.entries()].sort()) {
    const best = group.sort((a, b) => b.throughput - a.throughput)[0];
    lines.push(
      `| ${best.W} | ${best.mode} | ${best.handler} | ${best.P}×${best.WPP} | ${best.throughput}/s | ${best.fairness} |`,
    );
  }
  lines.push('');

  fs.writeFileSync(path.join(reportDir, 'REPORT.md'), lines.join('\n'));
  console.log(`\nReport written to ${path.join(reportDir, 'REPORT.md')}`);
}

// ─── Main execution ──────────────────────────────────────

async function runLocal(): Promise<void> {
  const { runScenarioLocal, restartContainer } = await import('./local-runner.js');

  const mode = 'local';
  const results: ScenarioResult[] = [];
  let completed = 0;

  // Group by cluster to minimize restarts
  const byCluster = new Map<string, typeof scenarios>();
  for (const s of scenarios) {
    const arr = byCluster.get(s.cluster) || [];
    arr.push(s);
    byCluster.set(s.cluster, arr);
  }

  for (const [cluster, clusterScenarios] of byCluster) {
    let needsRestart = true;

    for (const scenario of clusterScenarios) {
      completed++;
      const progress = `[${completed}/${scenarios.length}]`;

      if (argv.resume && resultExists(scenario.id, mode)) {
        console.log(`${progress} SKIP (exists): ${scenario.id}`);
        // Load existing result
        const existing = JSON.parse(
          fs.readFileSync(path.join(resultsDir(mode), `${scenario.id}.json`), 'utf-8'),
        ) as ScenarioResult;
        results.push(existing);
        continue;
      }

      console.log(`\n${progress} Running: ${scenario.id}`);
      const result = await runScenarioLocal(scenario, {
        doRestart: needsRestart,
        preCreateCount,
        targetPerWorker,
        scenarioTimeout,
      });

      needsRestart = true; // restart between scenarios for clean state
      results.push(result);
      saveResult(result, mode);
    }
  }

  generateReport(results, mode);
}

async function runGcp(): Promise<void> {
  const { runScenarioGcp, provisionBrokerPool, teardownBrokerPool } = await import('./gcp-runner.js');

  const runId = `run-${Date.now()}`;
  const mode = 'gcp';
  const gcpOpts = {
    project: String(argv.project),
    zone: str(argv.zone) || 'us-central1-a',
    bucket: str(argv.bucket) || 'camunda-perf-matrix',
    runId,
  };

  console.log(`GCP Run ID: ${runId}`);
  console.log(`Project: ${gcpOpts.project}, Zone: ${gcpOpts.zone}, Bucket: ${gcpOpts.bucket}`);

  const results: ScenarioResult[] = [];
  let completed = 0;

  // Group by cluster for broker pool reuse
  const byCluster = new Map<ClusterConfig, typeof scenarios>();
  for (const s of scenarios) {
    const arr = byCluster.get(s.cluster) || [];
    arr.push(s);
    byCluster.set(s.cluster, arr);
  }

  for (const [cluster, clusterScenarios] of byCluster) {
    console.log(`\n--- Provisioning ${cluster} broker pool ---`);
    const brokerPool = await provisionBrokerPool(gcpOpts, cluster);

    for (const scenario of clusterScenarios) {
      completed++;
      const progress = `[${completed}/${scenarios.length}]`;

      if (argv.resume && resultExists(scenario.id, mode)) {
        console.log(`${progress} SKIP (exists): ${scenario.id}`);
        const existing = JSON.parse(
          fs.readFileSync(path.join(resultsDir(mode), `${scenario.id}.json`), 'utf-8'),
        ) as ScenarioResult;
        results.push(existing);
        continue;
      }

      console.log(`\n${progress} Running: ${scenario.id}`);
      const result = await runScenarioGcp(scenario, brokerPool, {
        ...gcpOpts,
        targetPerWorker,
        scenarioTimeout,
        preCreateCount,
      });
      results.push(result);
      saveResult(result, mode);
    }

    console.log(`\n--- Tearing down ${cluster} broker pool ---`);
    teardownBrokerPool(gcpOpts, brokerPool);
  }

  generateReport(results, mode);
}

// ─── Entry point ─────────────────────────────────────────

const t0 = Date.now();

try {
  if (argv.local) {
    await runLocal();
  } else {
    await runGcp();
  }
} catch (err) {
  console.error('Fatal error:', err);
  process.exit(1);
} finally {
  const elapsed = ((Date.now() - t0) / 1000 / 60).toFixed(1);
  console.log(`\nTotal runtime: ${elapsed} min`);
}
