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
  type SdkLanguage,
  type HandlerType,
  type ClusterConfig,
  SDK_MODES,
  SDK_LANGUAGES,
  DEFAULT_TARGET_PER_WORKER,
  DEFAULT_HANDLER_LATENCY_MS,
  DEFAULT_SCENARIO_TIMEOUT_S,
  DEFAULT_PRE_CREATE_COUNT,
} from './config.js';
import type { ScenarioResult } from './types.js';
import type { BrokerPool } from './gcp-runner.js';

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
    languages: { type: 'string' },     // comma-separated SDK languages
    modes: { type: 'string' },         // comma-separated SDK modes
    handlers: { type: 'string' },      // comma-separated handler types
    clusters: { type: 'string' },      // comma-separated cluster configs

    // Scenario params
    target: { type: 'string' },        // target completions per worker
    timeout: { type: 'string' },       // scenario timeout seconds
    precreate: { type: 'string' },     // pre-create count

    // GCP networking
    network: { type: 'string' },        // GCP VPC network name
    subnetwork: { type: 'string' },     // GCP subnetwork name

    // Control
    lanes: { type: 'string' },          // parallel lanes (GCP only, default: 1)
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
  --languages ts,python SDK languages (default: ts,python,csharp,java)
  --modes rest,grpc     SDK modes (default: rest,grpc)
  --handlers cpu,http   Handler types (default: cpu,http)
  --clusters 1broker    Cluster configs (default: 1broker,3broker)

SCENARIO PARAMS:
  --target 10000        Target completions per worker (default: ${DEFAULT_TARGET_PER_WORKER})
  --timeout 300         Scenario timeout in seconds (default: ${DEFAULT_SCENARIO_TIMEOUT_S})
  --precreate 50000     Pre-create instance count (default: ${DEFAULT_PRE_CREATE_COUNT})

GCP NETWORKING:
  --network default     VPC network for worker VMs (default: use GCP project default)
  --subnetwork default  Subnetwork for worker VMs (default: use GCP project default)

CONTROL:
  --lanes 4             Parallel lanes (GCP only, default: 1)
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
  sdkLanguages: parseList<SdkLanguage>(str(argv.languages), [...SDK_LANGUAGES]),
  sdkModes: parseList<SdkMode>(str(argv.modes), [...SDK_MODES]),
  handlerTypes: parseList<HandlerType>(str(argv.handlers), ['cpu', 'http']),
  clusters: parseList<ClusterConfig>(str(argv.clusters), ['1broker', '3broker']),
});

const targetPerWorker = str(argv.target) ? parseInt(str(argv.target)!, 10) : DEFAULT_TARGET_PER_WORKER;
const scenarioTimeout = str(argv.timeout) ? parseInt(str(argv.timeout)!, 10) : DEFAULT_SCENARIO_TIMEOUT_S;
const preCreateCount = str(argv.precreate) ? parseInt(str(argv.precreate)!, 10) : DEFAULT_PRE_CREATE_COUNT;
const lanes = str(argv.lanes) ? parseInt(str(argv.lanes)!, 10) : 1;

if (lanes < 1 || !Number.isInteger(lanes)) {
  console.error(`Error: --lanes must be a positive integer (got "${str(argv.lanes)}")`);
  process.exit(1);
}

console.log(`Matrix: ${scenarios.length} scenarios`);
console.log(`  Target/worker: ${targetPerWorker}  Timeout: ${scenarioTimeout}s  Pre-create: ${preCreateCount}`);
if (lanes > 1) {
  console.log(`  Lanes: ${lanes} (parallel execution)`);
}

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

// Each run gets its own directory: results/<mode>/<runId>/
let currentRunDir = '';

function resultsDir(mode: string, runId: string): string {
  return path.join(RESULTS_DIR, mode, runId);
}

function resultExists(scenarioId: string, mode: string, runId: string): boolean {
  const filePath = path.join(resultsDir(mode, runId), `${scenarioId}.json`);
  return fs.existsSync(filePath);
}

function saveResult(result: ScenarioResult, mode: string, runId: string): void {
  const dir = resultsDir(mode, runId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, `${result.scenarioId}.json`),
    JSON.stringify(result, null, 2),
  );
}

interface SdkVersions {
  ts?: string;
  python?: string;
  csharp?: string;
  java?: string;
}

interface RunMetadata {
  runId: string;
  mode: string;
  startedAt: string;
  completedAt: string | null;
  status: 'running' | 'completed' | 'interrupted';
  commit: string;
  scenarioCount: number;
  scenariosCompleted: number;
  lanes: number;
  sdkVersions: SdkVersions;
  handlerLatencyMs: number;
  cliArgs: Record<string, string | boolean | undefined>;
  gcpProject?: string;
  gcpZone?: string;
  gcpBucket?: string;
}

function getGitCommit(): string {
  try {
    const { execSync } = require('child_process');
    return execSync('git rev-parse --short HEAD', { encoding: 'utf8', cwd: REPO_ROOT }).trim();
  } catch {
    return 'unknown';
  }
}

/** Read SDK versions from the local project config files. */
function collectSdkVersions(): SdkVersions {
  const versions: SdkVersions = {};

  // TypeScript: read from package.json
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf-8'));
    const dep = pkg.dependencies?.['@camunda8/orchestration-cluster-api'];
    if (dep) versions.ts = dep;
  } catch { /* best effort */ }

  // Java: read camunda.client.version from pom.xml
  try {
    const pom = fs.readFileSync(path.join(REPO_ROOT, 'src/workers/java-worker/pom.xml'), 'utf-8');
    const match = pom.match(/<camunda\.client\.version>([^<]+)<\/camunda\.client\.version>/);
    if (match) versions.java = match[1];
  } catch { /* best effort */ }

  // C#: read PackageReference from .csproj
  try {
    const csproj = fs.readFileSync(path.join(REPO_ROOT, 'src/workers/csharp-worker/CsharpWorker.csproj'), 'utf-8');
    const match = csproj.match(/Include="Camunda\.Orchestration\.Sdk"\s+Version="([^"]+)"/);
    if (match) versions.csharp = match[1];
  } catch { /* best effort */ }

  // Python: installed via pip --pre (latest prerelease)
  try {
    const { execSync } = require('child_process');
    const output = execSync('pip show camunda-orchestration-sdk 2>/dev/null || pip3 show camunda-orchestration-sdk 2>/dev/null', {
      encoding: 'utf-8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'],
    });
    const match = output.match(/Version:\s*(\S+)/);
    if (match) versions.python = match[1];
  } catch {
    versions.python = 'latest-prerelease';
  }

  return versions;
}

function writeMetadata(metadata: RunMetadata): void {
  fs.mkdirSync(currentRunDir, { recursive: true });
  fs.writeFileSync(
    path.join(currentRunDir, 'metadata.json'),
    JSON.stringify(metadata, null, 2),
  );
}

let currentMetadata: RunMetadata | null = null;

function markRunInterrupted(): void {
  if (currentMetadata && currentRunDir) {
    currentMetadata.status = 'interrupted';
    currentMetadata.completedAt = new Date().toISOString();
    try { writeMetadata(currentMetadata); } catch { /* best-effort */ }
  }
}

function markRunCompleted(scenariosCompleted: number): void {
  if (currentMetadata && currentRunDir) {
    currentMetadata.status = 'completed';
    currentMetadata.completedAt = new Date().toISOString();
    currentMetadata.scenariosCompleted = scenariosCompleted;
    writeMetadata(currentMetadata);
  }
}

// ─── Report generation ───────────────────────────────────

function generateReport(results: ScenarioResult[], mode: string, runId: string): void {
  const reportDir = resultsDir(mode, runId);
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
      lang: r.sdkLanguage,
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
    lines.push('| Topology | Lang | SDK Mode | Handler | Cluster | Throughput | Errors | Time (s) | Fairness | Status |');
    lines.push('|----------|------|----------|---------|---------|------------|--------|----------|----------|--------|');

    for (const s of scenariosForW.sort((a, b) => b.throughput - a.throughput)) {
      lines.push(
        `| ${s.P}×${s.WPP} | ${s.lang} | ${s.mode} | ${s.handler} | ${s.cluster} | ${s.throughput}/s | ${s.errors} | ${s.wallClockS} | ${s.fairness} | ${s.status} |`,
      );
    }
    lines.push('');
  }

  // Cross-cutting: best topology per (W, mode, handler)
  lines.push('## Best Topology by Configuration');
  lines.push('');
  lines.push('| W | Lang | SDK Mode | Handler | Best Topology | Throughput | Fairness |');
  lines.push('|---|------|----------|---------|---------------|------------|----------|');

  const grouped = new Map<string, typeof summary.scenarios>();
  for (const s of summary.scenarios.filter((s) => s.status === 'ok')) {
    const key = `${s.W}-${s.lang}-${s.mode}-${s.handler}`;
    const arr = grouped.get(key) || [];
    arr.push(s);
    grouped.set(key, arr);
  }

  for (const [, group] of [...grouped.entries()].sort()) {
    const best = group.sort((a, b) => b.throughput - a.throughput)[0];
    lines.push(
      `| ${best.W} | ${best.lang} | ${best.mode} | ${best.handler} | ${best.P}×${best.WPP} | ${best.throughput}/s | ${best.fairness} |`,
    );
  }
  lines.push('');

  fs.writeFileSync(path.join(reportDir, 'REPORT.md'), lines.join('\n'));
  console.log(`\nReport written to ${path.join(reportDir, 'REPORT.md')}`);
}

// ─── Main execution ──────────────────────────────────────

async function runLocal(): Promise<void> {
  const { runScenarioLocal, restartContainer } = await import('./local-runner.js');

  if (lanes > 1) {
    console.warn(`Warning: --lanes ${lanes} ignored in local mode (local always runs sequentially).`);
  }

  const mode = 'local';
  const runId = `run-${Date.now()}`;
  currentRunDir = resultsDir(mode, runId);
  const results: ScenarioResult[] = [];
  let completed = 0;

  currentMetadata = {
    runId,
    mode,
    startedAt: new Date().toISOString(),
    completedAt: null,
    status: 'running',
    commit: getGitCommit(),
    scenarioCount: scenarios.length,
    scenariosCompleted: 0,
    lanes: 1,
    sdkVersions: collectSdkVersions(),
    handlerLatencyMs: DEFAULT_HANDLER_LATENCY_MS,
    cliArgs: {
      local: true,
      resume: argv.resume as boolean | undefined,
      languages: str(argv.languages),
      scenarios: str(argv.scenarios),
    },
  };
  writeMetadata(currentMetadata);
  console.log(`Local Run ID: ${runId}`);
  console.log(`SDK versions: ${JSON.stringify(currentMetadata.sdkVersions)}`);

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

      if (argv.resume && resultExists(scenario.id, mode, runId)) {
        console.log(`${progress} SKIP (exists): ${scenario.id}`);
        // Load existing result
        const existing = JSON.parse(
          fs.readFileSync(path.join(resultsDir(mode, runId), `${scenario.id}.json`), 'utf-8'),
        ) as ScenarioResult;
        results.push(existing);
        continue;
      }

      const brokerCount = scenario.cluster === '3broker' ? 3 : 1;
      console.log(`\n${progress} Beginning scenario ${scenario.sdkLanguage} - ${scenario.sdkMode} - ${brokerCount}-broker - W: ${scenario.topology.totalWorkers} - P: ${scenario.topology.processes}`);
      const result = await runScenarioLocal(scenario, {
        doRestart: needsRestart,
        preCreateCount,
        targetPerWorker,
        scenarioTimeout,
      });
      console.log(`${progress} Finished scenario ${scenario.sdkLanguage} - ${scenario.sdkMode} - ${brokerCount}-broker - W: ${scenario.topology.totalWorkers} - P: ${scenario.topology.processes} => ${result.status}, ${result.aggregateThroughput.toFixed(1)}/s`);

      needsRestart = true; // restart between scenarios for clean state
      results.push(result);
      saveResult(result, mode, runId);
      currentMetadata!.scenariosCompleted = results.length;
    }
  }

  generateReport(results, mode, runId);
  markRunCompleted(results.length);
}

async function runGcp(): Promise<void> {
  const { runScenarioGcp, provisionBrokerPool, teardownBrokerPool, resetBrokerPool, cleanupAllVms } = await import('./gcp-runner.js');

  const runId = `run-${Date.now()}`;
  const mode = 'gcp';
  currentRunDir = resultsDir(mode, runId);

  // Register signal handlers early — catch both SIGINT (Ctrl-C) and SIGTERM
  // (sent by npm/parent process on shutdown). Must be registered before any VMs
  // are created so cleanup always fires.
  const signalCleanup = (signal: string) => {
    console.log(`\n\n${signal} received — cleaning up all GCP VMs...`);
    markRunInterrupted();
    cleanupAllVms();
    process.exit(signal === 'SIGINT' ? 130 : 143);
  };
  process.on('SIGINT', () => signalCleanup('SIGINT'));
  process.on('SIGTERM', () => signalCleanup('SIGTERM'));

  const gcpOpts = {
    project: String(argv.project),
    zone: str(argv.zone) || 'us-central1-a',
    bucket: str(argv.bucket) || 'camunda-perf-matrix',
    runId,
    ...(argv.network ? { network: String(argv.network) } : {}),
    ...(argv.subnetwork ? { subnetwork: String(argv.subnetwork) } : {}),
  };

  currentMetadata = {
    runId,
    mode,
    startedAt: new Date().toISOString(),
    completedAt: null,
    status: 'running',
    commit: getGitCommit(),
    scenarioCount: scenarios.length,
    scenariosCompleted: 0,
    lanes,
    sdkVersions: collectSdkVersions(),
    handlerLatencyMs: DEFAULT_HANDLER_LATENCY_MS,
    cliArgs: {
      resume: argv.resume as boolean | undefined,
      languages: str(argv.languages),
      scenarios: str(argv.scenarios),
      lanes: String(lanes),
    },
    gcpProject: gcpOpts.project,
    gcpZone: gcpOpts.zone,
    gcpBucket: gcpOpts.bucket,
  };
  writeMetadata(currentMetadata);

  console.log(`GCP Run ID: ${runId}`);
  console.log(`SDK versions: ${JSON.stringify(currentMetadata.sdkVersions)}`);
  console.log(`Results: ${currentRunDir}`);
  console.log(`Project: ${gcpOpts.project}, Zone: ${gcpOpts.zone}, Bucket: ${gcpOpts.bucket}`);

  if (lanes > 1 && argv.local) {
    console.warn('Warning: --lanes > 1 is only supported in GCP mode. Ignoring for local mode.');
  }

  // ── Distribute scenarios across lanes ──────────────────
  // Each lane gets ONE cluster type and keeps its broker pool for the entire run.
  // Lanes are allocated proportionally: if 60% of scenarios are 1broker and 40%
  // are 3broker, ~60% of lanes get 1broker work and ~40% get 3broker work.
  // This minimises total broker VMs and avoids per-lane provisioning churn.

  type ClusterGroup = { cluster: ClusterConfig; scenarios: typeof scenarios };

  const byCluster = new Map<ClusterConfig, typeof scenarios>();
  for (const s of scenarios) {
    const arr = byCluster.get(s.cluster) || [];
    arr.push(s);
    byCluster.set(s.cluster, arr);
  }

  // Allocate lanes proportionally to each cluster type (minimum 1 lane per type)
  const clusterEntries = [...byCluster.entries()]; // [[cluster, scenarios], ...]
  const totalScenarios = clusterEntries.reduce((s, [, sc]) => s + sc.length, 0);

  // First pass: proportional allocation with floor
  const clusterLaneCounts = new Map<ClusterConfig, number>();
  let allocatedLanes = 0;
  for (const [cluster, sc] of clusterEntries) {
    const share = Math.max(1, Math.floor((sc.length / totalScenarios) * lanes));
    clusterLaneCounts.set(cluster, share);
    allocatedLanes += share;
  }
  // Distribute remainder to the cluster type(s) with the most scenarios
  const sorted = clusterEntries.sort((a, b) => b[1].length - a[1].length);
  let remainder = lanes - allocatedLanes;
  for (const [cluster] of sorted) {
    if (remainder <= 0) break;
    clusterLaneCounts.set(cluster, clusterLaneCounts.get(cluster)! + 1);
    remainder--;
  }

  // Build lane assignments: each lane gets one cluster group
  const laneAssignments: ClusterGroup[][] = [];
  for (const [cluster, clusterScenarios] of clusterEntries) {
    const numLanes = clusterLaneCounts.get(cluster)!;
    const chunkSize = Math.ceil(clusterScenarios.length / numLanes);
    for (let l = 0; l < numLanes; l++) {
      const slice = clusterScenarios.slice(l * chunkSize, (l + 1) * chunkSize);
      if (slice.length > 0) {
        laneAssignments.push([{ cluster, scenarios: slice }]);
      }
    }
  }

  // Count scenarios per lane for logging
  const laneCounts = laneAssignments.map((groups) =>
    groups.reduce((sum, g) => sum + g.scenarios.length, 0),
  );
  if (lanes > 1) {
    const clusterSummary = [...clusterLaneCounts.entries()]
      .map(([c, n]) => `${c}=${n} lanes`)
      .join(', ');
    console.log(`Distributing across ${laneAssignments.length} lanes (${clusterSummary}): [${laneCounts.join(', ')}] scenarios`);
  }

  // Emit detailed lane→scenario mapping for debugging
  console.log(`\n${'═'.repeat(70)}`);
  console.log(`  LANE ASSIGNMENTS  (${laneAssignments.length} lanes, ${scenarios.length} scenarios)`);
  console.log(`${'═'.repeat(70)}`);
  for (let li = 0; li < laneAssignments.length; li++) {
    for (const group of laneAssignments[li]) {
      console.log(`\n  [lane ${li}] ${group.cluster} — ${group.scenarios.length} scenarios:`);
      for (const s of group.scenarios) {
        console.log(`    • ${s.id}`);
      }
    }
  }
  console.log(`${'═'.repeat(70)}\n`);

  const allResults: ScenarioResult[] = [];
  let globalCompleted = 0;

  // ── Run a single lane ──────────────────────────────────
  // If preProvisionedPools is provided, the lane will use those pools instead
  // of provisioning its own. Keys are cluster type names.
  async function runLane(
    laneIndex: number,
    groups: ClusterGroup[],
    preProvisionedPools?: Map<ClusterConfig, BrokerPool>,
  ): Promise<ScenarioResult[]> {
    const laneResults: ScenarioResult[] = [];
    const laneTag = lanes > 1 ? ` [lane ${laneIndex}]` : '';
    const laneRunId = lanes > 1 ? `${runId}-l${laneIndex}` : runId;

    const laneGcpOpts = { ...gcpOpts, runId: laneRunId, laneTag: laneTag || undefined };

    for (const { cluster, scenarios: clusterScenarios } of groups) {
      let brokerPool: BrokerPool | null = preProvisionedPools?.get(cluster) ?? null;
      const wasPreProvisioned = brokerPool !== null;

      if (!brokerPool) {
        console.log(`\n---${laneTag} Provisioning ${cluster} broker pool ---`);
        brokerPool = await provisionBrokerPool(laneGcpOpts, cluster);
      }
      if (!brokerPool) {
        console.error(`${laneTag} Broker provisioning failed for ${cluster} — skipping ${clusterScenarios.length} scenarios`);
        continue;
      }

      let needsReset = false;

      for (const scenario of clusterScenarios) {
        globalCompleted++;
        const progress = `[${globalCompleted}/${scenarios.length}]`;

        if (argv.resume && resultExists(scenario.id, mode, runId)) {
          console.log(`${progress}${laneTag} SKIP (exists): ${scenario.id}`);
          const existing = JSON.parse(
            fs.readFileSync(path.join(resultsDir(mode, runId), `${scenario.id}.json`), 'utf-8'),
          ) as ScenarioResult;
          laneResults.push(existing);
          needsReset = true; // next non-skipped scenario should still reset
          continue;
        }

        // Reset broker between scenarios for a clean baseline
        if (needsReset) {
          console.log(`\n${progress}${laneTag} Resetting broker pool for clean baseline...`);
          const resetOk = await resetBrokerPool(laneGcpOpts, brokerPool);
          if (!resetOk) {
            console.error(`${laneTag} Broker reset failed — skipping remaining scenarios in ${cluster}`);
            break;
          }
        }
        needsReset = true;

        const brokerCount = cluster === '3broker' ? 3 : 1;
        const { sdkLanguage: lang, sdkMode: mode_, topology: { totalWorkers: W, processes: P } } = scenario;
        console.log(`\n${progress}${laneTag} Beginning scenario ${lang} - ${mode_} - ${brokerCount}-broker - W: ${W} - P: ${P} on lane ${laneIndex}`);
        const result = await runScenarioGcp(scenario, brokerPool, {
          ...laneGcpOpts,
          targetPerWorker,
          scenarioTimeout,
          preCreateCount,
        });
        console.log(`${progress}${laneTag} Finished scenario ${lang} - ${mode_} - ${brokerCount}-broker - W: ${W} - P: ${P} on lane ${laneIndex} => ${result.status}, ${result.aggregateThroughput.toFixed(1)}/s`);
        laneResults.push(result);
        saveResult(result, mode, runId);
        if (currentMetadata) currentMetadata.scenariosCompleted = allResults.length + laneResults.length;
      }

      if (!wasPreProvisioned) {
        console.log(`\n---${laneTag} Tearing down ${cluster} broker pool ---`);
        await teardownBrokerPool(laneGcpOpts, brokerPool);
      } else {
        console.log(`${laneTag} Skipping teardown for pre-provisioned ${cluster} pool (caller will handle)`);
      }
    }

    return laneResults;
  }

  // ── Execute lanes ──────────────────────────────────────
  if (lanes === 1) {
    // Single lane — same as before, no extra overhead
    const results = await runLane(0, laneAssignments[0] || []);
    allResults.push(...results);
  } else {
    // Multi-lane strategy:
    // 3-broker pools are pre-provisioned sequentially to avoid GCP API contention
    // (creating 3 VMs per pool simultaneously across multiple lanes overwhelms quota).
    // 1-broker lanes start eagerly with staggered starts (cheap: 1 VM each).
    // Once all 3-broker pools are ready, those lanes start immediately with their
    // pre-provisioned pools.

    // Categorize lanes by cluster type
    const oneBrokerLanes: Array<{ index: number; groups: ClusterGroup[] }> = [];
    const threeBrokerLanes: Array<{ index: number; groups: ClusterGroup[] }> = [];

    for (let i = 0; i < laneAssignments.length; i++) {
      const groups = laneAssignments[i];
      if (groups.length === 0) continue;
      const cluster = groups[0].cluster;
      if (cluster === '3broker') {
        threeBrokerLanes.push({ index: i, groups });
      } else {
        oneBrokerLanes.push({ index: i, groups });
      }
    }

    console.log(`\nLane strategy: ${oneBrokerLanes.length} x 1-broker (eager), ${threeBrokerLanes.length} x 3-broker (pre-provisioned)`);

    // Pre-provision all 3-broker pools sequentially
    const preProvisionedPools = new Map<number, BrokerPool>(); // lane index → pool
    if (threeBrokerLanes.length > 0) {
      console.log(`\n${'─'.repeat(50)}`);
      console.log(`  PRE-PROVISIONING ${threeBrokerLanes.length} x 3-broker pools (sequential)`);
      console.log(`${'─'.repeat(50)}`);
      for (const { index, groups } of threeBrokerLanes) {
        const cluster = groups[0].cluster;
        const laneRunId = `${runId}-l${index}`;
        const laneGcpOpts = { ...gcpOpts, runId: laneRunId, laneTag: ` [lane ${index}]` };
        console.log(`\n[lane ${index}] Provisioning ${cluster} pool...`);
        const pool = await provisionBrokerPool(laneGcpOpts, cluster);
        if (pool) {
          preProvisionedPools.set(index, pool);
          console.log(`[lane ${index}] ${cluster} pool ready (${pool.vmNames.join(', ')})`);
        } else {
          console.error(`[lane ${index}] ${cluster} pool provisioning failed — lane will skip all scenarios`);
        }
      }
      console.log(`\n${'─'.repeat(50)}`);
      console.log(`  Pre-provisioning complete: ${preProvisionedPools.size}/${threeBrokerLanes.length} pools ready`);
      console.log(`${'─'.repeat(50)}\n`);
    }

    // Launch all lanes concurrently
    const lanePromises: Array<Promise<ScenarioResult[]>> = [];

    // 1-broker lanes: staggered starts (they provision their own single VM)
    for (let i = 0; i < oneBrokerLanes.length; i++) {
      const { index, groups } = oneBrokerLanes[i];
      lanePromises.push(
        (async () => {
          if (i > 0) {
            const delayMs = i * 15_000;
            console.log(`[lane ${index}] Staggering start by ${delayMs / 1000}s to reduce API contention...`);
            await new Promise((r) => setTimeout(r, delayMs));
          }
          return runLane(index, groups);
        })().catch((err) => {
          console.error(`[lane ${index}] Fatal lane error:`, err);
          return [] as ScenarioResult[];
        }),
      );
    }

    // 3-broker lanes: start immediately with pre-provisioned pools
    for (const { index, groups } of threeBrokerLanes) {
      const pool = preProvisionedPools.get(index);
      if (!pool) {
        // Provisioning failed — lane will have no pool, runLane will skip
        lanePromises.push(
          runLane(index, groups).catch((err) => {
            console.error(`[lane ${index}] Fatal lane error:`, err);
            return [] as ScenarioResult[];
          }),
        );
        continue;
      }
      const poolMap = new Map<ClusterConfig, BrokerPool>();
      poolMap.set(groups[0].cluster, pool);
      lanePromises.push(
        runLane(index, groups, poolMap).catch((err) => {
          console.error(`[lane ${index}] Fatal lane error:`, err);
          return [] as ScenarioResult[];
        }),
      );
    }

    const laneResults = await Promise.all(lanePromises);
    for (const results of laneResults) {
      allResults.push(...results);
    }

    // Teardown pre-provisioned 3-broker pools
    for (const { index, groups } of threeBrokerLanes) {
      const pool = preProvisionedPools.get(index);
      if (pool) {
        const laneRunId = `${runId}-l${index}`;
        const laneGcpOpts = { ...gcpOpts, runId: laneRunId, laneTag: ` [lane ${index}]` };
        console.log(`\n--- [lane ${index}] Tearing down pre-provisioned ${groups[0].cluster} pool ---`);
        await teardownBrokerPool(laneGcpOpts, pool);
      }
    }
  }

  // Final safety sweep: delete any VMs that survived partial deletion failures
  // during normal scenario teardown. This catches VMs that were untrackable
  // because gcloud returned non-zero (partial batch failure).
  cleanupAllVms();

  generateReport(allResults, mode, runId);
  markRunCompleted(allResults.length);
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
