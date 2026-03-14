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

// ─── Active VM tracking (for SIGINT cleanup) ────────────

const activeVms = new Map<string, GcpOptions>();

function trackVm(opts: GcpOptions, vmName: string): void {
  activeVms.set(vmName, opts);
}

function untrackVms(vmNames: string[]): void {
  for (const n of vmNames) activeVms.delete(n);
}

/** Delete all tracked VMs (called on SIGINT). */
function cleanupAllVms(): void {
  if (activeVms.size === 0) return;
  // Group by project+zone so we can batch
  const groups = new Map<string, { opts: GcpOptions; names: string[] }>();
  for (const [name, opts] of activeVms) {
    const key = `${opts.project}/${opts.zone}`;
    const g = groups.get(key) || { opts, names: [] };
    g.names.push(name);
    groups.set(key, g);
  }
  for (const { opts, names } of groups.values()) {
    console.log(`[gcp] SIGINT cleanup: deleting ${names.length} VMs in ${opts.project}/${opts.zone}...`);
    gcloud([
      'compute', 'instances', 'delete', ...names,
      '--project', opts.project,
      '--zone', opts.zone,
      '--quiet',
    ], 180_000);
  }
  activeVms.clear();
  console.log('[gcp] SIGINT cleanup complete.');
}

// ─── Types ───────────────────────────────────────────────

interface GcpOptions {
  project: string;
  zone: string;
  bucket: string;
  runId: string;
  network?: string;
  subnetwork?: string;
  laneTag?: string;
}

interface BrokerPool {
  cluster: ClusterConfig;
  vmNames: string[];
  internalIps: string[]; // IPs of all broker nodes (index 0 = primary)
}

/** Result of a single health check probe. */
interface HealthProbe {
  healthy: boolean;
  status: number | null;
  body: string;
  error: string;
}

// ─── VM name helpers ─────────────────────────────────────

/** Shorten runId for VM names (GCE limit: 63 chars). Keep full ID for GCS paths. */
function vmTag(runId: string): string {
  return runId.replace(/^run-/, '').slice(-8);
}

// ─── Connectivity helpers ────────────────────────────────

/**
 * Detect whether we're running on a GCP VM by probing the metadata server.
 * Cached after first call. When true, we can reach other VMs in the same VPC
 * directly via internal IP (no IAP tunnel needed).
 */
let _onGcpVm: boolean | null = null;
function isRunningOnGcpVm(): boolean {
  if (_onGcpVm !== null) return _onGcpVm;
  const r = childProcess.spawnSync('curl', [
    '-sf', '--connect-timeout', '1',
    '-H', 'Metadata-Flavor: Google',
    'http://metadata.google.internal/computeMetadata/v1/instance/name',
  ], { encoding: 'utf-8', timeout: 3000 });
  _onGcpVm = r.status === 0;
  if (_onGcpVm) console.log('[gcp] Running on GCP VM — using internal IP for SSH and health checks');
  return _onGcpVm;
}

/** Build gcloud compute ssh args, using --internal-ip on GCP VMs, --tunnel-through-iap otherwise. */
function sshArgs(opts: GcpOptions, vmName: string, command: string, timeoutMs = 30_000): string[] {
  const args = ['compute', 'ssh', vmName, '--project', opts.project, '--zone', opts.zone];
  if (isRunningOnGcpVm()) {
    args.push('--internal-ip');
  } else {
    args.push('--tunnel-through-iap');
  }
  args.push('--command', command);
  return args;
}

/** Probe a single broker's health endpoint. Returns detailed diagnostics. */
async function probeBrokerHealth(opts: GcpOptions, vmName: string, internalIp: string): Promise<HealthProbe> {
  if (isRunningOnGcpVm()) {
    // Direct curl from same VPC — non-blocking, allows other lanes to progress
    const r = await spawnAsync('curl', [
      '-s', '--connect-timeout', '2', '--max-time', '5',
      '-w', '\n%{http_code}',
      `http://${internalIp}:9600/actuator/health`,
    ], 10_000);
    if (r.exitCode !== 0) {
      return { healthy: false, status: null, body: '', error: r.stderr?.trim() || `curl exit ${r.exitCode}` };
    }
    const lines = (r.stdout || '').trim().split('\n');
    const httpCode = parseInt(lines.pop() || '0', 10);
    const body = lines.join('\n').trim();
    return { healthy: httpCode === 200, status: httpCode, body, error: '' };
  }
  // SSH into broker and curl localhost
  const curlCmd = `curl -s --connect-timeout 2 --max-time 5 -w '\\n%{http_code}' http://localhost:9600/actuator/health`;
  const r = await gcloudAsync([
    'compute', 'ssh', vmName,
    '--project', opts.project,
    '--zone', opts.zone,
    '--tunnel-through-iap',
    '--command', curlCmd,
  ], 30_000);
  if (r.exitCode !== 0) {
    return { healthy: false, status: null, body: '', error: r.stderr?.trim() || `ssh exit ${r.exitCode}` };
  }
  const lines = (r.stdout || '').trim().split('\n');
  const httpCode = parseInt(lines.pop() || '0', 10);
  const body = lines.join('\n').trim();
  return { healthy: httpCode === 200, status: httpCode, body, error: '' };
}

/** Check that ALL brokers in a pool are healthy. Returns true only if every node responds 200. */
async function checkPoolHealth(opts: GcpOptions, pool: BrokerPool): Promise<boolean> {
  // Probe all nodes in parallel — don't serialize across lanes
  const probes = await Promise.all(
    pool.vmNames.map((vm, i) => probeBrokerHealth(opts, vm, pool.internalIps[i])),
  );
  return probes.every((p) => p.healthy);
}

/** Log health status of every node in the pool. */
async function logPoolHealth(opts: GcpOptions, pool: BrokerPool): Promise<void> {
  const curlerror: Record<number, string> = {
    7: 'connection refused (Docker container not listening yet)',
    28: 'timeout (VM still booting or pulling Docker image)',
    6: 'DNS resolution failed',
    56: 'connection reset',
  };
  const tag = opts.laneTag ?? '';
  // Probe all nodes in parallel
  const probes = await Promise.all(
    pool.vmNames.map((vm, i) => probeBrokerHealth(opts, vm, pool.internalIps[i])),
  );
  for (let i = 0; i < pool.vmNames.length; i++) {
    const probe = probes[i];
    const icon = probe.healthy ? '✓' : '⏳';
    let detail: string;
    if (probe.healthy) {
      detail = probe.body.slice(0, 80);
    } else if (probe.error) {
      const exitMatch = probe.error.match(/curl exit (\d+)/);
      const code = exitMatch ? parseInt(exitMatch[1], 10) : 0;
      const hint = curlerror[code] || probe.error;
      detail = hint;
    } else {
      detail = `HTTP ${probe.status} — ${probe.body.slice(0, 80)}`;
    }
    console.log(`  ${tag} [node ${i}] ${icon} ${pool.vmNames[i]}: ${detail}`);
  }
}

/** Fetch docker logs from a broker VM (last N lines). */
async function fetchBrokerLogs(opts: GcpOptions, vmName: string, lines = 30): Promise<string> {
  const r = await gcloudAsync(sshArgs(opts, vmName, `docker logs camunda-broker --tail ${lines} 2>&1`), 30_000);
  return r.exitCode === 0 ? r.stdout : `(failed to fetch logs: ${r.stderr})`;
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

/** Non-blocking spawn — allows other lanes to progress while waiting for a process. */
function spawnAsync(
  cmd: string, args: string[], timeoutMs = 120_000,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve) => {
    const proc = childProcess.spawn(cmd, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let resolved = false;
    const done = (exitCode: number) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      resolve({ stdout, stderr, exitCode });
    };
    proc.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
    proc.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
    const timer = setTimeout(() => { proc.kill('SIGTERM'); done(-1); }, timeoutMs);
    proc.on('close', (code) => done(code ?? -1));
    proc.on('error', () => done(-1));
  });
}

/** Async gcloud — doesn't block the event loop. Use for parallelizable operations. */
function gcloudAsync(args: string[], timeoutMs = 120_000) {
  return spawnAsync('gcloud', args, timeoutMs);
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
      const nodeModules = path.join(pkgDir, 'node_modules');
      if (!fs.existsSync(nodeModules)) {
        throw new Error(
          `node_modules not found at ${nodeModules}. Run 'npm install' before starting a GCP run.`,
        );
      }
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

/**
 * Build the `docker run` command for a broker node.
 * For multi-broker clusters, contactPointIps must include all broker IPs.
 */
function brokerDockerRunCmd(
  nodeId: number, clusterSize: number, contactPointIps: string[] = [],
): string {
  const camundaVersion = process.env.CAMUNDA_VERSION || '8.9-SNAPSHOT';
  const envs = [
    'docker run -d',
    '--name camunda-broker',
    '--network host',
    `-e SPRING_PROFILES_ACTIVE=broker,consolidated-auth`,
    `-e ZEEBE_BROKER_CLUSTER_CLUSTERSIZE=${clusterSize}`,
    `-e ZEEBE_BROKER_CLUSTER_PARTITIONSCOUNT=${clusterSize}`,
    `-e ZEEBE_BROKER_CLUSTER_REPLICATIONFACTOR=${Math.min(clusterSize, 3)}`,
    `-e ZEEBE_BROKER_CLUSTER_NODEID=${nodeId}`,
    `-e ZEEBE_BROKER_NETWORK_HOST=0.0.0.0`,
  ];
  // Multi-broker: each node needs to know all peers for SWIM discovery,
  // and must advertise its own IP (not 0.0.0.0) so peers can reach it.
  if (clusterSize > 1 && contactPointIps.length > 0) {
    const points = contactPointIps.map((ip) => `${ip}:26502`).join(',');
    envs.push(`-e ZEEBE_BROKER_CLUSTER_INITIALCONTACTPOINTS=${points}`);
    envs.push(`-e ZEEBE_BROKER_NETWORK_ADVERTISEDHOST=${contactPointIps[nodeId]}`);
  }
  envs.push(
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
  );
  return envs.join(' \\\n  ');
}

function brokerStartupScript(cluster: ClusterConfig, nodeId: number, clusterSize: number): string {
  const camundaVersion = process.env.CAMUNDA_VERSION || '8.9-SNAPSHOT';
  // Broker VMs use Container-Optimized OS (COS) which has Docker pre-installed.
  // Just need to wait for Docker daemon, open socket for SSH commands, and pull image.
  if (clusterSize > 1) {
    // Multi-broker: only pull image. Container started later via SSH
    // once all IPs are known (needed for initialContactPoints / SWIM discovery).
    return `#!/bin/bash
set -e
# COS: wait for Docker daemon to be ready
while ! docker info >/dev/null 2>&1; do sleep 1; done
# Allow non-root users (SSH) to use Docker
chmod 666 /var/run/docker.sock
# COS has INPUT policy DROP — open Camunda ports for worker VMs
iptables -A INPUT -p tcp --dport 8080 -j ACCEPT
iptables -A INPUT -p tcp --dport 9600 -j ACCEPT
iptables -A INPUT -p tcp --dport 26500 -j ACCEPT
iptables -A INPUT -p tcp --dport 26501 -j ACCEPT
iptables -A INPUT -p tcp --dport 26502 -j ACCEPT
docker pull camunda/camunda:${camundaVersion}
echo "Docker ready, waiting for cluster start command"
`;
  }
  // Single broker: start immediately (no contact points needed)
  return `#!/bin/bash
set -e
# COS: wait for Docker daemon to be ready
while ! docker info >/dev/null 2>&1; do sleep 1; done
# Allow non-root users (SSH) to use Docker
chmod 666 /var/run/docker.sock
# COS has INPUT policy DROP — open Camunda ports for worker VMs
iptables -A INPUT -p tcp --dport 8080 -j ACCEPT
iptables -A INPUT -p tcp --dport 9600 -j ACCEPT
iptables -A INPUT -p tcp --dport 26500 -j ACCEPT
iptables -A INPUT -p tcp --dport 26501 -j ACCEPT
iptables -A INPUT -p tcp --dport 26502 -j ACCEPT
docker pull camunda/camunda:${camundaVersion}
${brokerDockerRunCmd(nodeId, clusterSize)}
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

  // Startup log preamble — capture all output and upload to GCS on failure
  const logPreamble = `#!/bin/bash
exec > >(tee -a /var/log/worker-startup.log) 2>&1
set -euo pipefail
trap 'echo "[FATAL] Startup script failed at line $LINENO (exit $?)"; gsutil cp /var/log/worker-startup.log gs://${opts.bucket}/${opts.runId}/scenarios/${scenarioId}/logs/${workerId}-startup.log 2>/dev/null || true' ERR
echo "=== Worker startup: ${workerId} at $(date) ==="
`;

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
      return `${logPreamble}
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
      return `${logPreamble}
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
      return `${logPreamble}
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
      return `${logPreamble}
# Install JDK 21
apt-get update -qq && apt-get install -y -qq wget > /dev/null
wget -q https://download.oracle.com/java/21/latest/jdk-21_linux-x64_bin.tar.gz -O /tmp/jdk21.tar.gz
mkdir -p /opt/jdk && tar xzf /tmp/jdk21.tar.gz -C /opt/jdk --strip-components=1
export JAVA_HOME=/opt/jdk
export PATH=/opt/jdk/bin:$PATH

# Download worker jar
mkdir -p /opt/worker
gsutil cp gs://${opts.bucket}/${opts.runId}/java-worker.jar /opt/worker/
cd /opt/worker

${barrierReady}

# Run worker
${envBlock} \\
java -jar java-worker.jar

${uploadResult}
`;
  }
}

// ─── VM lifecycle ────────────────────────────────────────

async function createVm(
  opts: GcpOptions,
  vmName: string,
  machineType: string,
  startupScript: string,
  tags?: string[],
  imageFamily: string = GCP_DEFAULTS.imageFamily,
  imageProject: string = GCP_DEFAULTS.imageProject,
): Promise<boolean> {
  // Write startup script to a temp file to avoid --metadata comma-splitting issues
  // (e.g. SPRING_PROFILES_ACTIVE=broker,consolidated-auth would break inline --metadata)
  const scriptFile = `/tmp/perf-matrix-startup-${vmName}.sh`;
  fs.writeFileSync(scriptFile, startupScript, { mode: 0o755 });

  const args = [
    'compute', 'instances', 'create', vmName,
    '--project', opts.project,
    '--zone', opts.zone,
    '--machine-type', machineType,
    '--image-family', imageFamily,
    '--image-project', imageProject,
    '--scopes', 'storage-full,compute-rw',
    '--metadata-from-file', `startup-script=${scriptFile}`,
  ];

  if (opts.network) args.push('--network', opts.network);
  if (opts.subnetwork) args.push('--subnet', opts.subnetwork);
  if (tags?.length) args.push('--tags', tags.join(','));

  const r = await gcloudAsync(args, 180_000);
  if (r.exitCode !== 0) {
    console.error(`[gcp] Failed to create VM ${vmName}: ${r.stderr}`);
    return false;
  }
  console.log(`[gcp] Created VM: ${vmName}`);
  trackVm(opts, vmName);
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
  untrackVms(vmNames);
  console.log(`[gcp] Deleted ${vmNames.length} VMs`);
}

async function getVmInternalIp(opts: GcpOptions, vmName: string): Promise<string> {
  const r = await gcloudAsync([
    'compute', 'instances', 'describe', vmName,
    '--project', opts.project,
    '--zone', opts.zone,
    '--format', 'get(networkInterfaces[0].networkIP)',
  ]);
  return r.stdout.trim();
}

// ─── Broker pool management ──────────────────────────────

async function provisionBrokerPool(opts: GcpOptions, cluster: ClusterConfig): Promise<BrokerPool | null> {
  const clusterSize = cluster === '3broker' ? 3 : 1;
  const vmNames: string[] = [];

  // Create all broker VMs in parallel (async — doesn't block other lanes)
  const createPromises = [];
  for (let i = 0; i < clusterSize; i++) {
    const vmName = `pb-${vmTag(opts.runId)}-${i}`;
    const script = brokerStartupScript(cluster, i, clusterSize);
    vmNames.push(vmName);
    createPromises.push(
      createVm(opts, vmName, GCP_DEFAULTS.brokerMachineType, script, ['camunda-broker'],
        GCP_DEFAULTS.brokerImageFamily, GCP_DEFAULTS.brokerImageProject),
    );
  }
  await Promise.all(createPromises);

  // Collect IPs for all nodes (in parallel)
  const internalIps = await Promise.all(vmNames.map((vm) => getVmInternalIp(opts, vm)));
  console.log(`[gcp]${opts.laneTag ?? ''} Broker IPs: ${vmNames.map((n, i) => `${n}=${internalIps[i]}`).join(', ')}`);

  const pool: BrokerPool = { cluster, vmNames, internalIps };

  // Multi-broker: startup script only pulled image (COS has Docker pre-installed).
  // Now SSH in to start each container with initialContactPoints (all IPs known).
  if (clusterSize > 1) {
    console.log(`[gcp]${opts.laneTag ?? ''} Waiting for Docker pull to complete on all ${clusterSize} nodes before starting cluster...`);
    // Wait for Docker to be ready on all nodes (pull can take a while)
    const pullDeadline = Date.now() + 600_000; // 10 min for pull
    while (Date.now() < pullDeadline) {
      const checks = await Promise.all(
        vmNames.map((vm) =>
          gcloudAsync(sshArgs(opts, vm, 'docker image inspect camunda/camunda:' + (process.env.CAMUNDA_VERSION || '8.9-SNAPSHOT') + ' >/dev/null 2>&1'), 30_000),
        ),
      );
      if (checks.every((r) => r.exitCode === 0)) break;
      await new Promise((r) => setTimeout(r, 10_000));
    }

    // Start containers with contact points
    for (let i = 0; i < clusterSize; i++) {
      const cmd = brokerDockerRunCmd(i, clusterSize, internalIps);
      const r = await gcloudAsync(sshArgs(opts, vmNames[i], cmd), 60_000);
      if (r.exitCode !== 0) {
        console.error(`[gcp]${opts.laneTag ?? ''} Failed to start broker ${vmNames[i]}: ${r.stderr}`);
        deleteVms(opts, vmNames);
        return null;
      }
      console.log(`[gcp]${opts.laneTag ?? ''} Started broker ${vmNames[i]} (node ${i}) with contact points`);
    }
  }

  // Timeout is shorter with COS (no Docker install), but JVM still needs time
  const healthTimeout = clusterSize > 1 ? 600_000 : 420_000; // 10 min / 7 min
  const healthDeadline = Date.now() + healthTimeout;
  let brokerReady = false;
  let healthAttempt = 0;
  while (Date.now() < healthDeadline) {
    healthAttempt++;
    const elapsed = Math.round((Date.now() - (healthDeadline - healthTimeout)) / 1000);
    if (healthAttempt % 6 === 1) { // Log every ~30s
      const phase = elapsed < 60 ? '(pulling image)' :
        elapsed < 180 ? '(starting JVM)' : '(waiting for ready)';
      console.log(`[gcp]${opts.laneTag ?? ''} Broker health poll ${phase} — ${elapsed}s / ${Math.round(healthTimeout / 1000)}s`);
      await logPoolHealth(opts, pool);
    }
    if (await checkPoolHealth(opts, pool)) {
      brokerReady = true;
      break;
    }
    await new Promise((r) => setTimeout(r, 5000));
  }

  if (!brokerReady) {
    const mins = Math.round(healthTimeout / 60_000);
    console.error(`[gcp]${opts.laneTag ?? ''} FAILED: Broker pool not healthy after ${mins} min — dumping diagnostics:`);
    await logPoolHealth(opts, pool);
    for (const vm of vmNames) {
      console.error(`[gcp]${opts.laneTag ?? ''} Docker logs for ${vm}:\n${await fetchBrokerLogs(opts, vm, 40)}`);
    }
    console.error(`[gcp]${opts.laneTag ?? ''} Cleaning up failed broker VMs...`);
    deleteVms(opts, vmNames);
    return null;
  }
  console.log(`[gcp]${opts.laneTag ?? ''} Broker pool ready (${clusterSize} nodes)`);
  return pool;
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

  console.log(`[gcp]${opts.laneTag ?? ''} Resetting broker pool (${clusterSize} nodes)...`);

  // Reset all broker VMs in parallel via async SSH
  const resetResults = await Promise.all(
    pool.vmNames.map((vmName, i) => {
      const dockerRunCmd = brokerDockerRunCmd(i, clusterSize, pool.internalIps);
      const resetScript = [
        'docker stop camunda-broker 2>/dev/null || true',
        'docker rm -v camunda-broker 2>/dev/null || true',
        'docker volume prune -f',
        dockerRunCmd,
      ].join(' && ');
      return gcloudAsync(sshArgs(opts, vmName, resetScript), 120_000)
        .then((r) => ({ vmName, nodeId: i, ...r }));
    }),
  );

  for (const r of resetResults) {
    if (r.exitCode !== 0) {
      console.error(`[gcp]${opts.laneTag ?? ''} Failed to reset broker ${r.vmName}: ${r.stderr}`);
      return false;
    }
    console.log(`[gcp]${opts.laneTag ?? ''} Reset broker ${r.vmName} (node ${r.nodeId})`);
  }

  // Wait for all brokers to be healthy (3-broker needs SWIM sync time)
  const healthTimeout = clusterSize > 1 ? 300_000 : 180_000; // 5 min / 3 min
  const healthDeadline = Date.now() + healthTimeout;
  let resetAttempt = 0;
  while (Date.now() < healthDeadline) {
    resetAttempt++;
    const elapsed = Math.round((Date.now() - (healthDeadline - healthTimeout)) / 1000);
    if (resetAttempt % 5 === 1) { // Log every ~15s
      const phase = elapsed < 30 ? '(restarting container)' :
        clusterSize > 1 && elapsed < 120 ? '(SWIM cluster sync)' : '(waiting for ready)';
      console.log(`[gcp]${opts.laneTag ?? ''} Reset health poll ${phase} — ${elapsed}s / ${Math.round(healthTimeout / 1000)}s`);
      await logPoolHealth(opts, pool);
    }
    if (await checkPoolHealth(opts, pool)) {
      console.log(`[gcp]${opts.laneTag ?? ''} Broker pool reset and healthy (all ${clusterSize} nodes)`);
      return true;
    }
    await new Promise((r) => setTimeout(r, 3000));
  }

  const mins = Math.round(healthTimeout / 60_000);
  console.error(`[gcp]${opts.laneTag ?? ''} FAILED: Broker pool not healthy after reset (${mins} min) — dumping diagnostics:`);
  await logPoolHealth(opts, pool);
  for (const vm of pool.vmNames) {
    console.error(`[gcp]${opts.laneTag ?? ''} Docker logs for ${vm}:\n${await fetchBrokerLogs(opts, vm, 40)}`);
  }
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
  const brokerRestUrl = `http://${brokerPool.internalIps[0]}:8080`;
  const brokerGrpcUrl = `${brokerPool.internalIps[0]}:26500`;

  console.log(`\n${'='.repeat(70)}`);
  console.log(`  [${scenario.id}]  ${P} processes × ${WPP} workers = ${W} total (GCP)`);
  console.log(`  broker=${brokerPool.internalIps[0]}  lang=${sdkLanguage}  sdk=${sdkMode}  handler=${handlerType}`);
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

    await createVm(opts, vmName, GCP_DEFAULTS.workerMachineType, script, ['perf-worker']);
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
    console.log(`  [${scenario.id}] TIMEOUT waiting for workers — fetching startup logs...`);
    // Try to read worker startup logs from GCS (uploaded by ERR trap)
    for (let p = 0; p < P; p++) {
      const logPath = `${scenarioGcsPrefix}/logs/process-${p}-startup.log`;
      const tmpLog = `/tmp/worker-startup-${Date.now()}.log`;
      gsutil(['cp', `gs://${opts.bucket}/${logPath}`, tmpLog], 10_000);
      try {
        const log = fs.readFileSync(tmpLog, 'utf-8');
        console.error(`  [${scenario.id}] Startup log for process-${p}:\n${log.slice(-2000)}`);
        fs.unlinkSync(tmpLog);
      } catch {
        console.error(`  [${scenario.id}] No startup log for process-${p} (script may still be running)`);
        // Also try serial console output for extra context
        const serial = await gcloudAsync([
          'compute', 'instances', 'get-serial-port-output', workerVmNames[p],
          '--project', opts.project, '--zone', opts.zone,
        ], 15_000);
        if (serial.exitCode === 0 && serial.stdout.length > 0) {
          // Show last 40 lines of serial output
          const lines = serial.stdout.trim().split('\n');
          const tail = lines.slice(-40).join('\n');
          console.error(`  [${scenario.id}] Serial console tail for ${workerVmNames[p]}:\n${tail}`);
        }
      }
    }
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

export { provisionBrokerPool, teardownBrokerPool, resetBrokerPool, cleanupAllVms };
export type { GcpOptions, BrokerPool };
