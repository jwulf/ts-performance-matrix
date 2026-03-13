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
import type { ScenarioConfig, ClusterConfig, SdkLanguage } from './config.js';
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

// ─── VM name helpers ─────────────────────────────────────

/** Shorten runId for VM names (GCE limit: 63 chars). Keep full ID for GCS paths. */
function vmTag(runId: string): string {
  return runId.replace(/^run-/, '').slice(-8);
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

function spawnChecked(cmd: string, args: string[], opts?: childProcess.SpawnSyncOptions): void {
  const result = childProcess.spawnSync(cmd, args, { stdio: 'inherit', ...opts });
  if (result.error) {
    throw new Error(`Failed to spawn '${cmd}': ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(`'${cmd} ${args.join(' ')}' exited with code ${result.status}`);
  }
}

function buildWorkerPackage(opts: GcpOptions, language: SdkLanguage): string {
  const workersDir = path.resolve(import.meta.dirname, 'workers');
  const pkgDir = path.resolve(import.meta.dirname, '..');
  const gcsPrefix = `gs://${opts.bucket}/${opts.runId}`;

  switch (language) {
    case 'ts': {
      const tarPath = `/tmp/perf-matrix-worker-ts-${opts.runId}.tar.gz`;
      spawnChecked('tar', [
        'czf', tarPath,
        '-C', pkgDir,
        'package.json',
        'node_modules',
        'src/worker-process.ts',
        'src/ts-producer.ts',
        'tsconfig.json',
      ]);
      gsutil(['cp', tarPath, `${gcsPrefix}/worker-package-ts.tar.gz`]);
      console.log(`[gcp] TS worker package uploaded`);
      return `${gcsPrefix}/worker-package-ts.tar.gz`;
    }

    case 'python': {
      const pyWorker = path.join(workersDir, 'python-worker.py');
      const pyProducer = path.join(workersDir, 'python-producer.py');
      gsutil(['cp', pyWorker, `${gcsPrefix}/python-worker.py`]);
      gsutil(['cp', pyProducer, `${gcsPrefix}/python-producer.py`]);
      console.log(`[gcp] Python worker + producer uploaded`);
      return `${gcsPrefix}/python-worker.py`;
    }

    case 'csharp': {
      const csharpDir = path.join(workersDir, 'csharp-worker');
      spawnChecked('dotnet', [
        'publish', csharpDir,
        '-c', 'Release',
        '-r', 'linux-x64',
        '--self-contained', 'true',
        '-o', `/tmp/perf-matrix-csharp-${opts.runId}`,
      ]);
      const tarPath = `/tmp/perf-matrix-worker-csharp-${opts.runId}.tar.gz`;
      spawnChecked('tar', [
        'czf', tarPath,
        '-C', `/tmp/perf-matrix-csharp-${opts.runId}`,
        '.',
      ]);
      gsutil(['cp', tarPath, `${gcsPrefix}/worker-package-csharp.tar.gz`]);
      console.log(`[gcp] C# worker package uploaded`);
      return `${gcsPrefix}/worker-package-csharp.tar.gz`;
    }

    case 'java': {
      const javaDir = path.join(workersDir, 'java-worker');
      const mvnw = path.join(javaDir, 'mvnw');
      spawnChecked(mvnw, [
        '-f', path.join(javaDir, 'pom.xml'),
        'package', '-q', '-DskipTests',
      ]);
      const jarPath = path.join(javaDir, 'target', 'java-worker-1.0-SNAPSHOT.jar');
      gsutil(['cp', jarPath, `${gcsPrefix}/java-worker.jar`]);
      console.log(`[gcp] Java worker jar uploaded`);
      return `${gcsPrefix}/java-worker.jar`;
    }
  }
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
  -e 'CAMUNDA_DATABASE_URL=jdbc:h2:mem:cpt;DB_CLOSE_DELAY=-1;MODE=PostgreSQL' \\
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
    sdkLanguage: SdkLanguage;
    sdkMode: string;
    handlerType: string;
    numWorkers: number;
    targetPerWorker: number;
    scenarioTimeout: number;
    brokerRestUrl: string;
    brokerGrpcUrl: string;
    preCreateCount: number;
    isLeader: boolean;
  },
): string {
  const envBlock = `WORKER_PROCESS_ID=${workerId} \\
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
RESULT_FILE=/opt/worker/result.json`;

  // Leader (process-0) runs deploy + pre-create before signalling ready
  const producerEnv = `BROKER_REST_URL=${config.brokerRestUrl} BPMN_PATH=/opt/worker/test-job-process.bpmn PRECREATE_COUNT=${config.preCreateCount} PAYLOAD_SIZE_KB=10`;

  let producerBlock = '';
  if (config.isLeader) {
    const bpmnDownload = `gsutil cp gs://${opts.bucket}/${opts.runId}/test-job-process.bpmn /opt/worker/test-job-process.bpmn`;
    switch (config.sdkLanguage) {
      case 'ts':
        producerBlock = `
# ─── Leader: deploy + pre-create ───
${bpmnDownload}
${producerEnv} npx tsx src/ts-producer.ts
echo "[leader] Producer finished"
`;
        break;
      case 'python':
        producerBlock = `
# ─── Leader: deploy + pre-create ───
${bpmnDownload}
gsutil cp gs://${opts.bucket}/${opts.runId}/python-producer.py /opt/worker/python-producer.py
${producerEnv} /opt/worker/venv/bin/python3 /opt/worker/python-producer.py
echo "[leader] Producer finished"
`;
        break;
      case 'csharp':
        producerBlock = `
# ─── Leader: deploy + pre-create ───
${bpmnDownload}
${producerEnv} ./CsharpWorker --produce
echo "[leader] Producer finished"
`;
        break;
      case 'java':
        producerBlock = `
# ─── Leader: deploy + pre-create ───
${bpmnDownload}
${producerEnv} java -jar java-worker.jar --produce
echo "[leader] Producer finished"
`;
        break;
    }
  }

  const barrierReady = `${producerBlock}
# Signal ready
echo "1" | gsutil cp - gs://${opts.bucket}/${opts.runId}/scenarios/${scenarioId}/ready/${workerId}

# Wait for go signal
while ! gsutil -q stat gs://${opts.bucket}/${opts.runId}/scenarios/${scenarioId}/go 2>/dev/null; do
  sleep 0.5
done`;

  const uploadResult = `# Upload result
gsutil cp /opt/worker/result.json \\
  gs://${opts.bucket}/${opts.runId}/scenarios/${scenarioId}/results/${workerId}.json

# Self-destruct after 60s (cleanup)
sleep 60 && shutdown -h now &`;

  switch (config.sdkLanguage) {
    case 'ts':
      return `#!/bin/bash
set -e

# Install Node.js 22
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt-get install -y nodejs

# Download and extract worker package
mkdir -p /opt/worker
gsutil cp gs://${opts.bucket}/${opts.runId}/worker-package-ts.tar.gz /opt/worker/
cd /opt/worker && tar xzf worker-package-ts.tar.gz
npm install @esbuild/linux-x64

${barrierReady}

# Run worker
cd /opt/worker
${envBlock} \\
npx tsx src/worker-process.ts

${uploadResult}
`;

    case 'python':
      return `#!/bin/bash
set -e

# Install Python 3 + Camunda SDK in a venv (avoids system package conflicts)
apt-get update -qq && apt-get install -y -qq python3 python3-pip python3-venv > /dev/null
python3 -m venv /opt/worker/venv
# Install deps first (stable), then SDK with --pre (--no-deps prevents pulling pre-release transitive deps)
/opt/worker/venv/bin/pip install httpx attrs pydantic python-dateutil loguru python-dotenv typing-extensions
/opt/worker/venv/bin/pip install --pre --no-deps camunda-orchestration-sdk

# Download worker script
mkdir -p /opt/worker
gsutil cp gs://${opts.bucket}/${opts.runId}/python-worker.py /opt/worker/

${barrierReady}

# Run worker
cd /opt/worker
${envBlock} \\
/opt/worker/venv/bin/python3 python-worker.py

${uploadResult}
`;

    case 'csharp':
      return `#!/bin/bash
set -e

# Download and extract self-contained C# worker
mkdir -p /opt/worker
gsutil cp gs://${opts.bucket}/${opts.runId}/worker-package-csharp.tar.gz /opt/worker/
cd /opt/worker && tar xzf worker-package-csharp.tar.gz
chmod +x /opt/worker/CsharpWorker

${barrierReady}

# Run worker
cd /opt/worker
${envBlock} \\
./CsharpWorker

${uploadResult}
`;

    case 'java':
      return `#!/bin/bash
set -e

# Install JDK 21
apt-get update -qq && apt-get install -y -qq wget > /dev/null
wget -q https://download.oracle.com/java/21/latest/jdk-21_linux-x64_bin.tar.gz -O /tmp/jdk21.tar.gz
mkdir -p /opt/jdk && tar xzf /tmp/jdk21.tar.gz -C /opt/jdk --strip-components=1
export JAVA_HOME=/opt/jdk
export PATH=/opt/jdk/bin:$PATH

# Download worker jar
mkdir -p /opt/worker
gsutil cp gs://${opts.bucket}/${opts.runId}/java-worker.jar /opt/worker/

${barrierReady}

# Run worker
cd /opt/worker
${envBlock} \\
java -jar java-worker.jar

${uploadResult}
`;
  }
}

// ─── VM lifecycle ────────────────────────────────────────

function createVm(
  opts: GcpOptions,
  vmName: string,
  machineType: string,
  startupScript: string,
  tags?: string[],
): boolean {
  // Write startup script to a temp file to avoid --metadata comma-splitting issues
  // (e.g. SPRING_PROFILES_ACTIVE=broker,consolidated-auth would break inline --metadata)
  const scriptFile = `/tmp/perf-matrix-startup-${vmName}.sh`;
  fs.writeFileSync(scriptFile, startupScript, { mode: 0o755 });

  const args = [
    'compute', 'instances', 'create', vmName,
    '--project', opts.project,
    '--zone', opts.zone,
    '--machine-type', machineType,
    '--image-family', GCP_DEFAULTS.imageFamily,
    '--image-project', GCP_DEFAULTS.imageProject,
    '--scopes', 'storage-full,compute-rw',
    '--metadata-from-file', `startup-script=${scriptFile}`,
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

function deleteVms(opts: GcpOptions, vmNames: string[]): void {
  if (vmNames.length === 0) return;
  gcloud([
    'compute', 'instances', 'delete', ...vmNames,
    '--project', opts.project,
    '--zone', opts.zone,
    '--quiet',
  ], 180_000);
  console.log(`[gcp] Deleted ${vmNames.length} VMs`);
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
    const vmName = `pb-${vmTag(opts.runId)}-${i}`;
    const script = brokerStartupScript(cluster, i, clusterSize);
    createVm(opts, vmName, GCP_DEFAULTS.brokerMachineType, script, ['camunda-broker']);
    vmNames.push(vmName);
  }

  // Wait for health check on primary broker via SSH (VMs have no external IP)
  const primaryIp = getVmInternalIp(opts, vmNames[0]);
  console.log(`[gcp] Broker primary IP: ${primaryIp}`);

  const healthTimeout = 600_000; // 10 min (Docker install + image pull is slow)
  const healthDeadline = Date.now() + healthTimeout;
  let brokerReady = false;
  let healthAttempt = 0;
  while (Date.now() < healthDeadline) {
    healthAttempt++;
    const elapsed = Math.round((Date.now() - (healthDeadline - healthTimeout)) / 1000);
    if (healthAttempt % 6 === 1) { // Log every ~30s
      console.log(`[gcp] Waiting for broker health check... (${elapsed}s elapsed)`);
    }
    const r = gcloud([
      'compute', 'ssh', vmNames[0],
      '--project', opts.project,
      '--zone', opts.zone,
      '--tunnel-through-iap',
      '--command', 'curl -sf --connect-timeout 3 http://localhost:9600/actuator/health/status',
    ], 30_000);
    if (r.exitCode === 0) {
      brokerReady = true;
      break;
    }
    await new Promise((r) => setTimeout(r, 5000));
  }

  if (!brokerReady) {
    throw new Error(`Broker pool failed health check after 10 min`);
  }
  console.log(`[gcp] Broker pool ready (${clusterSize} nodes)`);
  return { cluster, vmNames, internalIp: primaryIp };
}

function teardownBrokerPool(opts: GcpOptions, pool: BrokerPool): void {
  deleteVms(opts, pool.vmNames);
}

/**
 * Reset all broker VMs in a pool by SSH-ing in, stopping the Docker container,
 * removing it along with its volumes, pruning any remaining volumes, and re-running
 * the same `docker run` command. Waits for the primary broker health check before
 * returning.
 *
 * This ensures each scenario starts with a completely clean broker (no leftover
 * process instances, metrics, or Zeebe data).
 */
async function resetBrokerPool(opts: GcpOptions, pool: BrokerPool): Promise<boolean> {
  const clusterSize = pool.vmNames.length;
  const camundaVersion = process.env.CAMUNDA_VERSION || '8.9-SNAPSHOT';

  console.log(`[gcp] Resetting broker pool (${clusterSize} nodes)...`);

  // Reset each broker VM in parallel via SSH
  for (let i = 0; i < clusterSize; i++) {
    const vmName = pool.vmNames[i];
    const nodeId = i;

    // Build the docker run command matching brokerStartupScript exactly
    const dockerRunCmd = [
      'docker run -d',
      '--name camunda-broker',
      '--network host',
      `-e SPRING_PROFILES_ACTIVE=broker,consolidated-auth`,
      `-e ZEEBE_BROKER_CLUSTER_CLUSTERSIZE=${clusterSize}`,
      `-e ZEEBE_BROKER_CLUSTER_PARTITIONSCOUNT=${clusterSize}`,
      `-e ZEEBE_BROKER_CLUSTER_REPLICATIONFACTOR=${Math.min(clusterSize, 3)}`,
      `-e ZEEBE_BROKER_CLUSTER_NODEID=${nodeId}`,
      `-e ZEEBE_BROKER_NETWORK_HOST=0.0.0.0`,
      `-e 'CAMUNDA_DATABASE_URL=jdbc:h2:mem:cpt;DB_CLOSE_DELAY=-1;MODE=PostgreSQL'`,
      `-e CAMUNDA_DATABASE_TYPE=rdbms`,
      `-e CAMUNDA_DATABASE_USERNAME=sa`,
      `-e CAMUNDA_DATABASE_PASSWORD=`,
      `-e CAMUNDA_DATA_SECONDARY_STORAGE_TYPE=rdbms`,
      `-e ZEEBE_BROKER_EXPORTERS_RDBMS_CLASSNAME=io.camunda.exporter.rdbms.RdbmsExporter`,
      `-e ZEEBE_BROKER_EXPORTERS_RDBMS_ARGS_FLUSH_INTERVAL=PT0S`,
      `-e CAMUNDA_SECURITY_AUTHENTICATION_UNPROTECTEDAPI=true`,
      `-e CAMUNDA_SECURITY_AUTHORIZATIONS_ENABLED=false`,
      `-e MANAGEMENT_ENDPOINTS_WEB_EXPOSURE_INCLUDE=health,prometheus`,
      `-e ZEEBE_BROKER_EXECUTIONMETRICSEXPORTERENABLED=true`,
      `camunda/camunda:${camundaVersion}`,
    ].join(' \\\n  ');

    const resetScript = [
      'docker stop camunda-broker 2>/dev/null || true',
      'docker rm -v camunda-broker 2>/dev/null || true',
      'docker volume prune -f',
      dockerRunCmd,
    ].join(' && ');

    const r = gcloud([
      'compute', 'ssh', vmName,
      '--project', opts.project,
      '--zone', opts.zone,
      '--tunnel-through-iap',
      '--command', resetScript,
    ], 120_000);

    if (r.exitCode !== 0) {
      console.error(`[gcp] Failed to reset broker ${vmName}: ${r.stderr}`);
      return false;
    }
    console.log(`[gcp] Reset broker ${vmName} (node ${nodeId})`);
  }

  // Wait for primary broker health check via SSH (VMs have no external IP)
  const healthTimeout = 180_000; // 3 min
  const healthDeadline = Date.now() + healthTimeout;
  let resetAttempt = 0;
  while (Date.now() < healthDeadline) {
    resetAttempt++;
    const elapsed = Math.round((Date.now() - (healthDeadline - healthTimeout)) / 1000);
    if (resetAttempt % 5 === 1) { // Log every ~15s
      console.log(`[gcp] Waiting for broker health after reset... (${elapsed}s elapsed)`);
    }
    const r = gcloud([
      'compute', 'ssh', pool.vmNames[0],
      '--project', opts.project,
      '--zone', opts.zone,
      '--tunnel-through-iap',
      '--command', 'curl -sf --connect-timeout 3 http://localhost:9600/actuator/health/status',
    ], 30_000);
    if (r.exitCode === 0) {
      console.log(`[gcp] Broker pool reset and healthy`);
      return true;
    }
    await new Promise((r) => setTimeout(r, 3000));
  }

  console.error(`[gcp] Broker pool failed health check after reset`);
  return false;
}

// ─── GCS coordination ────────────────────────────────────

function gcsWaitForFiles(bucket: string, prefix: string, expectedCount: number, timeoutMs: number): boolean {
  const startTime = Date.now();
  const deadline = startTime + timeoutMs;
  let lastLoggedCount = -1;
  let pollCount = 0;
  while (Date.now() < deadline) {
    pollCount++;
    const output = gsutil(['ls', `gs://${bucket}/${prefix}`], 15_000);
    const files = output.trim().split('\n').filter((l) => l.trim().length > 0);
    if (files.length >= expectedCount) return true;
    const elapsed = Math.round((Date.now() - startTime) / 1000);
    if (files.length !== lastLoggedCount || pollCount % 15 === 1) { // Log on change or every ~30s
      console.log(`    ↳ GCS barrier: ${files.length}/${expectedCount} files (${elapsed}s elapsed)`);
      lastLoggedCount = files.length;
    }
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
  const { topology, sdkLanguage, sdkMode, handlerType, cluster } = scenario;
  const { processes: P, workersPerProcess: WPP, totalWorkers: W } = topology;
  const brokerRestUrl = `http://${brokerPool.internalIp}:8080`;
  const brokerGrpcUrl = `${brokerPool.internalIp}:26500`;

  console.log(`\n${'='.repeat(70)}`);
  console.log(`  [${scenario.id}]  ${P} processes × ${WPP} workers = ${W} total (GCP)`);
  console.log(`  broker=${brokerPool.internalIp}  lang=${sdkLanguage}  sdk=${sdkMode}  handler=${handlerType}`);
  console.log(`${'='.repeat(70)}`);

  const scenarioGcsPrefix = `${opts.runId}/scenarios/${scenario.id}`;

  // Build and upload language-specific worker package
  buildWorkerPackage(opts, sdkLanguage);

  // Upload BPMN to GCS (worker-0 / leader will download and deploy it)
  const bpmnPath = path.resolve(import.meta.dirname, '..', 'fixtures', 'test-job-process.bpmn');
  gsutil(['cp', bpmnPath, `gs://${opts.bucket}/${opts.runId}/test-job-process.bpmn`]);
  console.log(`  [${scenario.id}] BPMN uploaded to GCS`);
  const preCreate = { created: 0, errors: 0, durationS: 0 }; // tracked by leader VM

  // Provision worker VMs
  const workerVmNames: string[] = [];
  for (let p = 0; p < P; p++) {
    const workerId = `process-${p}`;
    const vmName = `pw-${vmTag(opts.runId)}-${scenario.id.toLowerCase().replace(/[^a-z0-9-]/g, '-')}-${p}`;
    const script = workerStartupScript(opts, scenario.id, workerId, {
      sdkLanguage, sdkMode, handlerType,
      numWorkers: WPP,
      targetPerWorker: opts.targetPerWorker,
      scenarioTimeout: opts.scenarioTimeout,
      brokerRestUrl, brokerGrpcUrl,
      preCreateCount: p === 0 ? opts.preCreateCount : 0,
      isLeader: p === 0,
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
    600_000, // 10 min — fresh VMs need time to install runtimes
  );

  if (!workersReady) {
    console.log(`  [${scenario.id}] TIMEOUT waiting for workers!`);
    // Cleanup
    deleteVms(opts, workerVmNames);
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
  deleteVms(opts, workerVmNames);

  // Aggregate
  const totalCompleted = processResults.reduce((s, p) => s + p.completed, 0);
  const totalErrors = processResults.reduce((s, p) => s + p.errors, 0);
  const aggregateThroughput = wallClockS > 0 ? totalCompleted / wallClockS : 0;
  const allWorkerThroughputs = processResults.flatMap((p) => p.perWorkerThroughputs);
  const fairness = jainFairness(allWorkerThroughputs);

  const result: ScenarioResult = {
    scenarioId: scenario.id,
    ...topology,
    sdkLanguage, sdkMode, handlerType, cluster,
    totalCompleted, totalErrors,
    wallClockS, aggregateThroughput,
    jainFairness: fairness,
    processResults,
    serverMetrics: null, // TODO: scrape from broker VM
    status: isTimeout ? 'timeout' : 'ok',
    preCreate,
  };

  console.log(`  [${scenario.id}] => ${aggregateThroughput.toFixed(1)}/s, ${totalErrors} errors, ${wallClockS.toFixed(1)}s, Jain=${fairness.toFixed(3)}`);

  return result;
}

// ─── Helper ──────────────────────────────────────────────

function errorResult(scenario: ScenarioConfig, message: string): ScenarioResult {
  return {
    scenarioId: scenario.id,
    ...scenario.topology,
    sdkLanguage: scenario.sdkLanguage,
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

export { provisionBrokerPool, teardownBrokerPool, resetBrokerPool };
export type { GcpOptions, BrokerPool };
