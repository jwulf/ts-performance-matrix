/**
 * Local Runner — executes scenarios on a single machine using Docker and child processes.
 *
 * For each scenario:
 *   1. Restart Docker broker (clean slate)
 *   2. Deploy test process
 *   3. Pre-create process instances
 *   4. Spawn P child processes, each running WPP workers
 *   5. Collect results via filesystem barrier protocol
 */

import * as childProcess from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ScenarioConfig } from './config.js';
import type { ScenarioResult, ProcessResult } from './types.js';
import { jainFairness } from './types.js';
import {
  DEFAULT_TARGET_PER_WORKER,
  DEFAULT_HANDLER_LATENCY_MS,
  DEFAULT_ACTIVATE_BATCH,
  DEFAULT_SCENARIO_TIMEOUT_S,
  DEFAULT_PAYLOAD_SIZE_KB,
  DEFAULT_PRE_CREATE_COUNT,
  DEFAULT_PRODUCER_CONCURRENCY,
} from './config.js';

// ─── Paths ───────────────────────────────────────────────

const REPO_ROOT = path.resolve(import.meta.dirname, '..');
const DOCKER_DIR = path.join(REPO_ROOT, 'docker');
const COMPOSE_1BROKER = path.join(DOCKER_DIR, 'docker-compose.1broker.yaml');
const COMPOSE_3BROKER = path.join(DOCKER_DIR, 'docker-compose.3broker.yaml');
const WORKER_SCRIPT = path.join(import.meta.dirname, 'worker-process.ts');
const RESULTS_DIR = path.join(REPO_ROOT, 'results');

// ─── Shell helpers ───────────────────────────────────────

function runCmd(cmd: string, args: string[], timeoutMs = 90_000): { stdout: string; stderr: string; exitCode: number } {
  try {
    const result = childProcess.spawnSync(cmd, args, {
      timeout: timeoutMs,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return {
      stdout: result.stdout || '',
      stderr: result.stderr || '',
      exitCode: result.status ?? -1,
    };
  } catch {
    return { stdout: '', stderr: 'spawn failed', exitCode: -1 };
  }
}

function sleepSync(ms: number) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// ─── Container management ────────────────────────────────

export function restartContainer(composeFile: string): boolean {
  const MAX_ATTEMPTS = 3;
  const HEALTH_TIMEOUT_MS = 180_000;
  const REST_TIMEOUT_MS = 30_000;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    if (attempt > 1) {
      process.stdout.write(`  [container] Retry ${attempt}/${MAX_ATTEMPTS}...`);
    }

    process.stdout.write('  [container] Stopping...');
    runCmd('docker', ['compose', '-f', composeFile, 'down', '--timeout', '30', '--volumes', '--remove-orphans']);
    sleepSync(5000);

    process.stdout.write(' starting...');
    runCmd('docker', ['compose', '-f', composeFile, 'up', '-d']);

    // Phase 1: Health endpoint
    let healthy = false;
    const healthDeadline = Date.now() + HEALTH_TIMEOUT_MS;
    while (Date.now() < healthDeadline) {
      const r = runCmd('curl', ['-sf', 'http://localhost:9600/actuator/health/status'], 5000);
      if (r.exitCode === 0) { healthy = true; break; }
      process.stdout.write('.');
      sleepSync(3000);
    }

    if (!healthy) { console.log(` TIMEOUT (health)!`); continue; }

    // Phase 2: REST API
    let restReady = false;
    const restDeadline = Date.now() + REST_TIMEOUT_MS;
    while (Date.now() < restDeadline) {
      const r = runCmd('curl', ['-sf', '-o', '/dev/null', '-w', '%{http_code}', 'http://localhost:8080/v2/topology'], 5000);
      if (r.exitCode === 0) { restReady = true; break; }
      process.stdout.write('.');
      sleepSync(2000);
    }

    if (!restReady) { console.log(` TIMEOUT (REST)!`); continue; }

    console.log(' ready!');
    sleepSync(3000);
    return true;
  }

  console.log(`  [container] FAILED after ${MAX_ATTEMPTS} attempts!`);
  return false;
}

// ─── Deploy process ──────────────────────────────────────

export async function deployProcess(): Promise<string> {
  const { createCamundaClient } = await import('@camunda8/orchestration-cluster-api');
  const client = createCamundaClient({
    config: {
      CAMUNDA_REST_ADDRESS: 'http://localhost:8080',
      CAMUNDA_SDK_LOG_LEVEL: 'error',
      CAMUNDA_OAUTH_DISABLED: true,
    } as any,
  });

  const bpmnPath = path.join(REPO_ROOT, 'fixtures', 'test-job-process.bpmn');
  const deployment = await client.deployResourcesFromFiles([bpmnPath]);
  const { processDefinitionKey } = deployment.processes[0];

  // Wait for deployment propagation
  await new Promise<void>((resolve) => setTimeout(resolve, 10000));
  return processDefinitionKey;
}

// ─── Pre-create instances ────────────────────────────────

export async function preCreateInstances(
  processDefKey: string,
  count: number,
): Promise<{ created: number; errors: number; durationS: number }> {
  if (count <= 0) return { created: 0, errors: 0, durationS: 0 };

  const { createCamundaClient } = await import('@camunda8/orchestration-cluster-api');
  const CamundaKeys = await import('@camunda8/orchestration-cluster-api');

  const client = createCamundaClient({
    config: {
      CAMUNDA_REST_ADDRESS: 'http://localhost:8080',
      CAMUNDA_SDK_LOG_LEVEL: 'error',
      CAMUNDA_SDK_BACKPRESSURE_PROFILE: 'BALANCED',
      CAMUNDA_OAUTH_DISABLED: true,
    } as any,
  });

  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let payload = '';
  while (payload.length < DEFAULT_PAYLOAD_SIZE_KB * 1024) payload += alphabet[Math.floor(Math.random() * alphabet.length)];

  let created = 0;
  let errors = 0;
  const inflight: Promise<void>[] = [];
  const t0 = Date.now();

  console.log(`[pre-create] Creating ${count} process instances...`);

  while (created + errors < count) {
    while (inflight.length < DEFAULT_PRODUCER_CONCURRENCY && created + errors + inflight.length < count) {
      const p = client
        .createProcessInstance({
          processDefinitionKey: CamundaKeys.ProcessDefinitionKey.assumeExists(processDefKey),
          variables: { data: payload },
        })
        .then(() => { created++; })
        .catch(() => { errors++; })
        .finally(() => {
          const idx = inflight.indexOf(p);
          if (idx >= 0) inflight.splice(idx, 1);
        });
      inflight.push(p);
    }
    await new Promise((r) => setTimeout(r, 5));
  }
  await Promise.allSettled(inflight);

  const durationS = (Date.now() - t0) / 1000;
  console.log(`[pre-create] Done: ${created} created, ${errors} errors in ${durationS.toFixed(1)}s`);
  return { created, errors, durationS };
}

// ─── Prometheus metrics ──────────────────────────────────

interface MetricsSnapshot {
  counters: Record<string, number>;
  histCounts: Record<string, number>;
  histSums: Record<string, number>;
}

const COUNTERS = [
  'zeebe_received_request_count_total',
  'zeebe_dropped_request_count_total',
  'zeebe_deferred_append_count_total',
  'zeebe_broker_jobs_pushed_count_total',
  'zeebe_broker_jobs_push_fail_count_total',
  'zeebe_stream_processor_records_total',
];

const HISTOGRAMS = [
  'zeebe_job_activation_time_seconds',
  'zeebe_job_life_time_seconds',
  'zeebe_process_instance_execution_time_seconds',
];

function scrapeMetrics(): MetricsSnapshot {
  const r = runCmd('curl', ['-sf', 'http://localhost:9600/actuator/prometheus'], 10_000);
  const snap: MetricsSnapshot = { counters: {}, histCounts: {}, histSums: {} };
  if (r.exitCode !== 0) return snap;

  for (const line of r.stdout.split('\n')) {
    if (line.startsWith('#') || !line.trim()) continue;
    for (const metric of COUNTERS) {
      if (line.startsWith(metric)) {
        const val = parseFloat(line.split(/\s+/).pop() || '0');
        snap.counters[metric] = (snap.counters[metric] || 0) + val;
      }
    }
    for (const metric of HISTOGRAMS) {
      if (line.startsWith(`${metric}_count`)) {
        const val = parseFloat(line.split(/\s+/).pop() || '0');
        snap.histCounts[metric] = (snap.histCounts[metric] || 0) + val;
      }
      if (line.startsWith(`${metric}_sum`)) {
        const val = parseFloat(line.split(/\s+/).pop() || '0');
        snap.histSums[metric] = (snap.histSums[metric] || 0) + val;
      }
    }
  }
  return snap;
}

function computeMetricsDelta(before: MetricsSnapshot, after: MetricsSnapshot) {
  const d = (metric: string) => (after.counters[metric] || 0) - (before.counters[metric] || 0);
  const hc = (metric: string) => (after.histCounts[metric] || 0) - (before.histCounts[metric] || 0);
  const hs = (metric: string) => (after.histSums[metric] || 0) - (before.histSums[metric] || 0);
  const avgMs = (metric: string) => {
    const count = hc(metric);
    return count > 0 ? (hs(metric) / count) * 1000 : null;
  };

  return {
    receivedRequests: d('zeebe_received_request_count_total'),
    droppedRequests: d('zeebe_dropped_request_count_total'),
    deferredAppends: d('zeebe_deferred_append_count_total'),
    jobsPushed: d('zeebe_broker_jobs_pushed_count_total'),
    jobsPushFailed: d('zeebe_broker_jobs_push_fail_count_total'),
    recordsProcessed: d('zeebe_stream_processor_records_total'),
    backpressureLimit: 0,
    backpressureInflight: 0,
    jobActivationAvgMs: avgMs('zeebe_job_activation_time_seconds'),
    jobLifetimeAvgMs: avgMs('zeebe_job_life_time_seconds'),
    piExecutionAvgMs: avgMs('zeebe_process_instance_execution_time_seconds'),
  };
}

// ─── Run one scenario locally ────────────────────────────

export async function runScenarioLocal(
  scenario: ScenarioConfig,
  opts: {
    doRestart: boolean;
    preCreateCount: number;
    targetPerWorker: number;
    scenarioTimeout: number;
  },
): Promise<ScenarioResult> {
  const { topology, sdkLanguage, sdkMode, handlerType, cluster } = scenario;
  const { processes: P, workersPerProcess: WPP, totalWorkers: W } = topology;
  const composeFile = cluster === '3broker' ? COMPOSE_3BROKER : COMPOSE_1BROKER;

  console.log(`\n${'='.repeat(70)}`);
  console.log(`  [${scenario.id}]  ${P} processes × ${WPP} workers = ${W} total`);
  console.log(`  cluster=${cluster}  lang=${sdkLanguage}  sdk=${sdkMode}  handler=${handlerType}`);
  console.log(`${'='.repeat(70)}`);

  // Restart container
  if (opts.doRestart) {
    if (!restartContainer(composeFile)) {
      return {
        scenarioId: scenario.id,
        ...topology,
        sdkLanguage, sdkMode, handlerType, cluster,
        totalCompleted: 0, totalErrors: 0, wallClockS: 0,
        aggregateThroughput: 0, jainFairness: 0,
        processResults: [], serverMetrics: null,
        status: 'error', errorMessage: 'Container failed to start',
        preCreate: { created: 0, errors: 0, durationS: 0 },
      };
    }
  }

  // Deploy
  console.log(`  [${scenario.id}] Deploying test process...`);
  const processDefKey = await deployProcess();
  console.log(`  [${scenario.id}] Deployed: ${processDefKey}`);

  // Pre-create
  const preCreate = await preCreateInstances(processDefKey, opts.preCreateCount);

  // Metrics before
  const metricsBefore = scrapeMetrics();

  // Create temp directory for barrier protocol
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'perf-matrix-'));
  const readyDir = path.join(tmpDir, 'ready');
  const resultsDir = path.join(tmpDir, 'results');
  const goFile = path.join(tmpDir, 'GO');
  fs.mkdirSync(readyDir, { recursive: true });
  fs.mkdirSync(resultsDir, { recursive: true });

  // Spawn P child processes
  const children: childProcess.ChildProcess[] = [];
  for (let p = 0; p < P; p++) {
    const processId = `process-${p}`;
    const env: Record<string, string> = {
      ...process.env as Record<string, string>,
      WORKER_PROCESS_ID: processId,
      SDK_MODE: sdkMode,
      HANDLER_TYPE: handlerType,
      HANDLER_LATENCY_MS: String(DEFAULT_HANDLER_LATENCY_MS),
      NUM_WORKERS: String(WPP),
      TARGET_PER_WORKER: String(opts.targetPerWorker),
      ACTIVATE_BATCH: String(DEFAULT_ACTIVATE_BATCH),
      PAYLOAD_SIZE_KB: String(DEFAULT_PAYLOAD_SIZE_KB),
      SCENARIO_TIMEOUT_S: String(opts.scenarioTimeout),
      BROKER_REST_URL: 'http://localhost:8080',
      BROKER_GRPC_URL: 'localhost:26500',
      RESULT_FILE: path.join(resultsDir, `${processId}.json`),
      READY_FILE: path.join(readyDir, processId),
      GO_FILE: goFile,
    };

    const child = childProcess.spawn('tsx', [WORKER_SCRIPT], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      cwd: REPO_ROOT,
    });

    child.stdout?.on('data', () => {});
    child.stderr?.on('data', (data: Buffer) => {
      const msg = data.toString().trim();
      if (msg && (msg.includes('Fatal') || msg.includes('ECONNREFUSED'))) {
        process.stderr.write(`  [${processId}] ${msg}\n`);
      }
    });

    children.push(child);
  }

  // Wait for all processes to be ready
  const readyDeadline = Date.now() + 120_000;
  while (Date.now() < readyDeadline) {
    const readyFiles = fs.readdirSync(readyDir);
    if (readyFiles.length >= P) break;
    await new Promise((r) => setTimeout(r, 100));
  }

  console.log(`  [${scenario.id}] All ${P} processes ready, sending GO...`);

  // Signal GO
  fs.writeFileSync(goFile, '1');
  const t0 = Date.now();

  // Wait for all children to exit
  const exitPromises = children.map(
    (child) => new Promise<void>((resolve) => {
      child.on('exit', () => resolve());
      child.on('error', () => resolve());
    })
  );

  await Promise.race([
    Promise.all(exitPromises),
    new Promise<void>((resolve) => setTimeout(resolve, (opts.scenarioTimeout + 60) * 1000)),
  ]);

  // Kill stragglers
  for (const child of children) {
    try { child.kill('SIGTERM'); } catch { /* ignore */ }
  }

  const wallClockS = (Date.now() - t0) / 1000;

  // Metrics after
  const metricsAfter = scrapeMetrics();
  const serverMetrics = computeMetricsDelta(metricsBefore, metricsAfter);

  // Collect results
  const processResults: ProcessResult[] = [];
  for (let p = 0; p < P; p++) {
    const processId = `process-${p}`;
    const resultFile = path.join(resultsDir, `${processId}.json`);
    try {
      const data = JSON.parse(fs.readFileSync(resultFile, 'utf-8'));
      processResults.push({
        processId,
        vmName: 'local',
        workersInProcess: data.workersInProcess || WPP,
        completed: data.totalCompleted || 0,
        errors: data.totalErrors || 0,
        throughput: data.throughput || 0,
        perWorkerThroughputs: data.perWorkerThroughputs || [],
        perWorkerCompleted: data.perWorkerCompleted || [],
        perWorkerErrors: data.perWorkerErrors || [],
      });
    } catch {
      processResults.push({
        processId,
        vmName: 'local',
        workersInProcess: WPP,
        completed: 0, errors: 0, throughput: 0,
        perWorkerThroughputs: [], perWorkerCompleted: [], perWorkerErrors: [],
      });
    }
  }

  // Cleanup
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }

  // Aggregate
  const totalCompleted = processResults.reduce((s, p) => s + p.completed, 0);
  const totalErrors = processResults.reduce((s, p) => s + p.errors, 0);
  const aggregateThroughput = wallClockS > 0 ? totalCompleted / wallClockS : 0;

  // Fairness across all individual workers
  const allWorkerThroughputs = processResults.flatMap((p) => p.perWorkerThroughputs);
  const fairness = jainFairness(allWorkerThroughputs);

  const isTimeout = wallClockS >= opts.scenarioTimeout;

  const result: ScenarioResult = {
    scenarioId: scenario.id,
    ...topology,
    sdkLanguage, sdkMode, handlerType, cluster,
    totalCompleted, totalErrors,
    wallClockS, aggregateThroughput,
    jainFairness: fairness,
    processResults,
    serverMetrics,
    status: isTimeout ? 'timeout' : 'ok',
    preCreate,
  };

  // Write result file
  const outDir = path.join(RESULTS_DIR, 'local');
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(
    path.join(outDir, `${scenario.id}.json`),
    JSON.stringify(result, null, 2)
  );

  console.log(`  [${scenario.id}] => ${aggregateThroughput.toFixed(1)}/s, ${totalErrors} errors, ${wallClockS.toFixed(1)}s, Jain=${fairness.toFixed(3)}`);

  return result;
}
