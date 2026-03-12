/**
 * GCP Cloud Runner — provisions VMs in Google Cloud to execute scenarios
 * with true process isolation.
 *
 * For each scenario:
 *   1. Provision broker VM(s)
 *   2. Deploy test process + pre-create instances
 *   3. Provision P worker VMs (each runs WPP workers)
 *   4. Coordinate via GCS barrier protocol
 *   5. Collect results from GCS
 *   6. Tear down worker VMs (broker VMs reused across same-cluster scenarios)
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as childProcess from 'node:child_process';
import type { ScenarioConfig, ClusterConfig } from './config.js';
import { GCP_DEFAULTS } from './config.js';
import type { ScenarioResult, ProcessResult } from './types.js';
import { jainFairness } from './types.js';

// ─── Types ───────────────────────────────────────────────

interface GcpOptions {
  project: string;
  zone: string;
  bucket: string;
  runId: string;
  network?: string;
  subnetwork?: string;
}

interface BrokerPool {
  cluster: ClusterConfig;
  vmNames: string[];
  internalIp: string; // IP of the primary broker (REST + gRPC)
}

// ─── Shell helpers ───────────────────────────────────────

function gcloud(args: string[], timeoutMs = 120_000): { stdout: string; stderr: string; exitCode: number } {
  const result = childProcess.spawnSync('gcloud', args, {
    timeout: timeoutMs,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return {
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    exitCode: result.status ?? -1,
  };
}

function gsutil(args: string[], timeoutMs = 30_000): string {
  const result = childProcess.spawnSync('gsutil', args, {
    timeout: timeoutMs,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return result.stdout || '';
}

// ─── Worker package ──────────────────────────────────────

function buildWorkerPackage(opts: GcpOptions): string {
  const pkgDir = path.resolve(import.meta.dirname, '..');
  const tarPath = `/tmp/perf-matrix-worker-${opts.runId}.tar.gz`;

  // Create a tarball of essential files
  childProcess.spawnSync('tar', [
    'czf', tarPath,
    '-C', pkgDir,
    'package.json',
    'node_modules',
    'src/worker-process.ts',
    'tsconfig.json',
  ], { stdio: 'inherit' });

  // Upload to GCS
  gsutil(['cp', tarPath, `gs://${opts.bucket}/${opts.runId}/worker-package.tar.gz`]);
  console.log(`[gcp] Worker package uploaded to gs://${opts.bucket}/${opts.runId}/worker-package.tar.gz`);

  return `gs://${opts.bucket}/${opts.runId}/worker-package.tar.gz`;
}

// ─── Startup scripts ─────────────────────────────────────

function brokerStartupScript(cluster: ClusterConfig, nodeId: number, clusterSize: number): string {
  const camundaVersion = process.env.CAMUNDA_VERSION || '8.9-SNAPSHOT';
  return `#!/bin/bash
set -e

# Install Docker
curl -fsSL https://get.docker.com | sh

# Pull Camunda image
docker pull camunda/camunda:${camundaVersion}

# Run broker
docker run -d \\
  --name camunda-broker \\
  --network host \\
  -e SPRING_PROFILES_ACTIVE=broker,consolidated-auth \\
  -e ZEEBE_BROKER_CLUSTER_CLUSTERSIZE=${clusterSize} \\
  -e ZEEBE_BROKER_CLUSTER_PARTITIONSCOUNT=${clusterSize} \\
  -e ZEEBE_BROKER_CLUSTER_REPLICATIONFACTOR=${Math.min(clusterSize, 3)} \\
  -e ZEEBE_BROKER_CLUSTER_NODEID=${nodeId} \\
  -e ZEEBE_BROKER_NETWORK_HOST=0.0.0.0 \\
  -e CAMUNDA_DATABASE_URL=jdbc:h2:mem:cpt;DB_CLOSE_DELAY=-1;MODE=PostgreSQL \\
  -e CAMUNDA_DATABASE_TYPE=rdbms \\
  -e CAMUNDA_DATABASE_USERNAME=sa \\
  -e CAMUNDA_DATABASE_PASSWORD= \\
  -e CAMUNDA_DATA_SECONDARY_STORAGE_TYPE=rdbms \\
  -e ZEEBE_BROKER_EXPORTERS_RDBMS_CLASSNAME=io.camunda.exporter.rdbms.RdbmsExporter \\
  -e ZEEBE_BROKER_EXPORTERS_RDBMS_ARGS_FLUSH_INTERVAL=PT0S \\
  -e CAMUNDA_SECURITY_AUTHENTICATION_UNPROTECTEDAPI=true \\
  -e CAMUNDA_SECURITY_AUTHORIZATIONS_ENABLED=false \\
  -e MANAGEMENT_ENDPOINTS_WEB_EXPOSURE_INCLUDE=health,prometheus \\
  -e ZEEBE_BROKER_EXECUTIONMETRICSEXPORTERENABLED=true \\
  camunda/camunda:${camundaVersion}

echo "Broker ${nodeId} started"
`;
}

function workerStartupScript(
  opts: GcpOptions,
  scenarioId: string,
  workerId: string,
  config: {
    sdkMode: string;
    handlerType: string;
    numWorkers: number;
    targetPerWorker: number;
    scenarioTimeout: number;
    brokerRestUrl: string;
    brokerGrpcUrl: string;
  },
): string {
  return `#!/bin/bash
set -e

# Install Node.js 22
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt-get install -y nodejs

# Download and extract worker package
mkdir -p /opt/worker
gsutil cp gs://${opts.bucket}/${opts.runId}/worker-package.tar.gz /opt/worker/
cd /opt/worker && tar xzf worker-package.tar.gz

# Signal ready
echo "1" | gsutil cp - gs://${opts.bucket}/${opts.runId}/scenarios/${scenarioId}/ready/${workerId}

# Wait for go signal
while ! gsutil -q stat gs://${opts.bucket}/${opts.runId}/scenarios/${scenarioId}/go 2>/dev/null; do
  sleep 0.5
done

# Run worker
cd /opt/worker
WORKER_PROCESS_ID=${workerId} \\
SDK_MODE=${config.sdkMode} \\
HANDLER_TYPE=${config.handlerType} \\
HANDLER_LATENCY_MS=${config.handlerType === 'http' ? '200' : '0'} \\
NUM_WORKERS=${config.numWorkers} \\
TARGET_PER_WORKER=${config.targetPerWorker} \\
ACTIVATE_BATCH=32 \\
PAYLOAD_SIZE_KB=10 \\
SCENARIO_TIMEOUT_S=${config.scenarioTimeout} \\
BROKER_REST_URL=${config.brokerRestUrl} \\
BROKER_GRPC_URL=${config.brokerGrpcUrl} \\
RESULT_FILE=/opt/worker/result.json \\
npx tsx src/worker-process.ts

# Upload result
gsutil cp /opt/worker/result.json \\
  gs://${opts.bucket}/${opts.runId}/scenarios/${scenarioId}/results/${workerId}.json

# Self-destruct after 60s (cleanup)
sleep 60 && shutdown -h now &
`;
}

// ─── VM lifecycle ────────────────────────────────────────

function createVm(
  opts: GcpOptions,
  vmName: string,
  machineType: string,
  startupScript: string,
  tags?: string[],
): boolean {
  const args = [
    'compute', 'instances', 'create', vmName,
    '--project', opts.project,
    '--zone', opts.zone,
    '--machine-type', machineType,
    '--image-family', GCP_DEFAULTS.imageFamily,
    '--image-project', GCP_DEFAULTS.imageProject,
    '--scopes', 'storage-full,compute-rw',
    '--metadata', `startup-script=${startupScript}`,
    '--no-address', // internal IP only (use IAP for SSH)
  ];

  if (opts.network) args.push('--network', opts.network);
  if (opts.subnetwork) args.push('--subnet', opts.subnetwork);
  if (tags?.length) args.push('--tags', tags.join(','));

  const r = gcloud(args, 180_000);
  if (r.exitCode !== 0) {
    console.error(`[gcp] Failed to create VM ${vmName}: ${r.stderr}`);
    return false;
  }
  console.log(`[gcp] Created VM: ${vmName}`);
  return true;
}

function deleteVm(opts: GcpOptions, vmName: string): void {
  gcloud([
    'compute', 'instances', 'delete', vmName,
    '--project', opts.project,
    '--zone', opts.zone,
    '--quiet',
  ], 120_000);
  console.log(`[gcp] Deleted VM: ${vmName}`);
}

function getVmInternalIp(opts: GcpOptions, vmName: string): string {
  const r = gcloud([
    'compute', 'instances', 'describe', vmName,
    '--project', opts.project,
    '--zone', opts.zone,
    '--format', 'get(networkInterfaces[0].networkIP)',
  ]);
  return r.stdout.trim();
}

// ─── Broker pool management ──────────────────────────────

async function provisionBrokerPool(opts: GcpOptions, cluster: ClusterConfig): Promise<BrokerPool> {
  const clusterSize = cluster === '3broker' ? 3 : 1;
  const vmNames: string[] = [];

  for (let i = 0; i < clusterSize; i++) {
    const vmName = `perf-broker-${opts.runId}-${i}`;
    const script = brokerStartupScript(cluster, i, clusterSize);
    createVm(opts, vmName, GCP_DEFAULTS.brokerMachineType, script, ['camunda-broker']);
    vmNames.push(vmName);
  }

  // Wait for health check on primary broker
  const primaryIp = getVmInternalIp(opts, vmNames[0]);
  console.log(`[gcp] Broker primary IP: ${primaryIp}`);

  const healthDeadline = Date.now() + 300_000; // 5 min
  while (Date.now() < healthDeadline) {
    try {
      const r = childProcess.spawnSync('curl', [
        '-sf', '--connect-timeout', '3',
        `http://${primaryIp}:9600/actuator/health/status`,
      ], { encoding: 'utf-8', timeout: 10_000 });
      if (r.status === 0) break;
    } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, 5000));
  }

  console.log(`[gcp] Broker pool ready (${clusterSize} nodes)`);
  return { cluster, vmNames, internalIp: primaryIp };
}

function teardownBrokerPool(opts: GcpOptions, pool: BrokerPool): void {
  for (const vm of pool.vmNames) {
    deleteVm(opts, vm);
  }
}

// ─── GCS coordination ────────────────────────────────────

function gcsWaitForFiles(bucket: string, prefix: string, expectedCount: number, timeoutMs: number): boolean {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const output = gsutil(['ls', `gs://${bucket}/${prefix}`], 15_000);
    const files = output.trim().split('\n').filter((l) => l.trim().length > 0);
    if (files.length >= expectedCount) return true;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2000);
  }
  return false;
}

function gcsWriteFlag(bucket: string, flagPath: string): void {
  childProcess.spawnSync('bash', ['-c', `echo "1" | gsutil cp - gs://${bucket}/${flagPath}`], {
    encoding: 'utf-8',
    timeout: 10_000,
  });
}

function gcsReadJson(bucket: string, filePath: string): any {
  const tmpFile = `/tmp/gcs-read-${Date.now()}.json`;
  gsutil(['cp', `gs://${bucket}/${filePath}`, tmpFile], 15_000);
  try {
    return JSON.parse(fs.readFileSync(tmpFile, 'utf-8'));
  } finally {
    try { fs.unlinkSync(tmpFile); } catch { /* ignore */ }
  }
}

// ─── Run one scenario on GCP ─────────────────────────────

export async function runScenarioGcp(
  scenario: ScenarioConfig,
  brokerPool: BrokerPool,
  opts: GcpOptions & {
    targetPerWorker: number;
    scenarioTimeout: number;
    preCreateCount: number;
  },
): Promise<ScenarioResult> {
  const { topology, sdkMode, handlerType, cluster } = scenario;
  const { processes: P, workersPerProcess: WPP, totalWorkers: W } = topology;
  const brokerRestUrl = `http://${brokerPool.internalIp}:8080`;
  const brokerGrpcUrl = `${brokerPool.internalIp}:26500`;

  console.log(`\n${'='.repeat(70)}`);
  console.log(`  [${scenario.id}]  ${P} processes × ${WPP} workers = ${W} total (GCP)`);
  console.log(`  broker=${brokerPool.internalIp}  sdk=${sdkMode}  handler=${handlerType}`);
  console.log(`${'='.repeat(70)}`);

  const scenarioGcsPrefix = `${opts.runId}/scenarios/${scenario.id}`;

  // TODO: Deploy process and pre-create instances via broker REST API
  // For now, we'll deploy from the orchestrator (which needs network access to broker)

  // Provision worker VMs
  const workerVmNames: string[] = [];
  for (let p = 0; p < P; p++) {
    const workerId = `process-${p}`;
    const vmName = `perf-worker-${opts.runId}-${scenario.id.toLowerCase().replace(/[^a-z0-9-]/g, '-')}-${p}`;
    const script = workerStartupScript(opts, scenario.id, workerId, {
      sdkMode, handlerType,
      numWorkers: WPP,
      targetPerWorker: opts.targetPerWorker,
      scenarioTimeout: opts.scenarioTimeout,
      brokerRestUrl, brokerGrpcUrl,
    });

    createVm(opts, vmName, GCP_DEFAULTS.workerMachineType, script, ['perf-worker']);
    workerVmNames.push(vmName);
  }

  // Wait for all workers to be ready
  console.log(`  [${scenario.id}] Waiting for ${P} workers to be ready...`);
  const workersReady = gcsWaitForFiles(
    opts.bucket,
    `${scenarioGcsPrefix}/ready/`,
    P,
    180_000, // 3 min
  );

  if (!workersReady) {
    console.log(`  [${scenario.id}] TIMEOUT waiting for workers!`);
    // Cleanup
    for (const vm of workerVmNames) deleteVm(opts, vm);
    return errorResult(scenario, 'Workers failed to become ready');
  }

  // Signal GO
  console.log(`  [${scenario.id}] All workers ready, sending GO...`);
  gcsWriteFlag(opts.bucket, `${scenarioGcsPrefix}/go`);
  const t0 = Date.now();

  // Wait for results
  const resultsReady = gcsWaitForFiles(
    opts.bucket,
    `${scenarioGcsPrefix}/results/`,
    P,
    (opts.scenarioTimeout + 60) * 1000,
  );

  const wallClockS = (Date.now() - t0) / 1000;
  const isTimeout = !resultsReady;

  // Collect results
  const processResults: ProcessResult[] = [];
  for (let p = 0; p < P; p++) {
    const processId = `process-${p}`;
    try {
      const data = gcsReadJson(opts.bucket, `${scenarioGcsPrefix}/results/${processId}.json`);
      processResults.push({
        processId,
        vmName: workerVmNames[p],
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
        vmName: workerVmNames[p],
        workersInProcess: WPP,
        completed: 0, errors: 0, throughput: 0,
        perWorkerThroughputs: [], perWorkerCompleted: [], perWorkerErrors: [],
      });
    }
  }

  // Cleanup worker VMs
  for (const vm of workerVmNames) deleteVm(opts, vm);

  // Aggregate
  const totalCompleted = processResults.reduce((s, p) => s + p.completed, 0);
  const totalErrors = processResults.reduce((s, p) => s + p.errors, 0);
  const aggregateThroughput = wallClockS > 0 ? totalCompleted / wallClockS : 0;
  const allWorkerThroughputs = processResults.flatMap((p) => p.perWorkerThroughputs);
  const fairness = jainFairness(allWorkerThroughputs);

  const result: ScenarioResult = {
    scenarioId: scenario.id,
    ...topology,
    sdkMode, handlerType, cluster,
    totalCompleted, totalErrors,
    wallClockS, aggregateThroughput,
    jainFairness: fairness,
    processResults,
    serverMetrics: null, // TODO: scrape from broker VM
    status: isTimeout ? 'timeout' : 'ok',
    preCreate: { created: 0, errors: 0, durationS: 0 }, // Handled externally
  };

  console.log(`  [${scenario.id}] => ${aggregateThroughput.toFixed(1)}/s, ${totalErrors} errors, ${wallClockS.toFixed(1)}s, Jain=${fairness.toFixed(3)}`);

  return result;
}

// ─── Helper ──────────────────────────────────────────────

function errorResult(scenario: ScenarioConfig, message: string): ScenarioResult {
  return {
    scenarioId: scenario.id,
    ...scenario.topology,
    sdkMode: scenario.sdkMode,
    handlerType: scenario.handlerType,
    cluster: scenario.cluster,
    totalCompleted: 0, totalErrors: 0, wallClockS: 0,
    aggregateThroughput: 0, jainFairness: 0,
    processResults: [], serverMetrics: null,
    status: 'error', errorMessage: message,
    preCreate: { created: 0, errors: 0, durationS: 0 },
  };
}

// ─── Exports for orchestrator ────────────────────────────

export { provisionBrokerPool, teardownBrokerPool };
export type { GcpOptions, BrokerPool };
