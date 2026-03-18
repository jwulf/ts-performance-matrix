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
import { GCP_DEFAULTS, DEFAULT_PRODUCER_RATE } from './config.js';
import type { ScenarioResult, ProcessResult, ServerMetrics, ServerResourceUsage } from './types.js';
import { jainFairness } from './types.js';

// ─── Active VM tracking (for SIGINT cleanup) ────────────

const activeVms = new Map<string, GcpOptions>();

// Stored on first VM creation so cleanupAllVms can do a prefix-based sweep
// to catch VMs that were never tracked (e.g., createVm interrupted mid-creation).
let runDefaultOpts: GcpOptions | null = null;
let runVmTagPrefix: string | null = null;

function trackVm(opts: GcpOptions, vmName: string): void {
  activeVms.set(vmName, opts);
  if (!runDefaultOpts) {
    runDefaultOpts = opts;
    // Extract the run tag from the VM name (e.g., "pb-94770-l0-..." → "94770")
    const match = vmName.match(/^p[bw]-(\d+)-/);
    if (match) runVmTagPrefix = match[1];
  }
}

function untrackVms(vmNames: string[]): void {
  for (const n of vmNames) activeVms.delete(n);
}

/** Delete all tracked VMs, then sweep for any untracked orphans by run prefix. */
function cleanupAllVms(): void {
  // Phase 1: delete tracked VMs
  if (activeVms.size > 0) {
    // Group by project+zone so we can batch
    const groups = new Map<string, { opts: GcpOptions; names: string[] }>();
    for (const [name, opts] of activeVms) {
      const key = `${opts.project}/${opts.zone}`;
      const g = groups.get(key) || { opts, names: [] };
      g.names.push(name);
      groups.set(key, g);
    }
    for (const { opts, names } of groups.values()) {
      // gcloud can handle ~100 VMs per call; batch if more
      const batchSize = 50;
      for (let i = 0; i < names.length; i += batchSize) {
        const batch = names.slice(i, i + batchSize);
        console.log(`[gcp] cleanup: deleting ${batch.length} tracked VMs (batch ${Math.floor(i / batchSize) + 1})...`);
        const r = gcloud([
          'compute', 'instances', 'delete', ...batch,
          '--project', opts.project,
          '--zone', opts.zone,
          '--quiet',
        ], 300_000);
        if (r.exitCode !== 0) {
          console.error(`[gcp] cleanup batch failed: ${r.stderr?.trim() || r.stdout?.trim() || `exit ${r.exitCode}`}`);
        }
      }
    }
    activeVms.clear();
  }

  // Phase 2: prefix-based sweep to catch untracked orphans
  // (e.g., VMs created between GCP API call and trackVm, or partially-failed deletions
  // that untracked on the old code path)
  if (runVmTagPrefix && runDefaultOpts) {
    const opts = runDefaultOpts;
    const filter = `name~'^p[bw]-${runVmTagPrefix}-'`;
    const list = gcloud([
      'compute', 'instances', 'list',
      '--project', opts.project,
      '--zones', opts.zone,
      '--filter', filter,
      '--format=value(name)',
    ], 60_000);
    const orphans = list.stdout.trim().split('\n').filter(Boolean);
    if (orphans.length > 0) {
      console.log(`[gcp] cleanup: found ${orphans.length} untracked orphan VM(s) by prefix sweep: ${orphans.join(', ')}`);
      const r = gcloud([
        'compute', 'instances', 'delete', ...orphans,
        '--project', opts.project,
        '--zone', opts.zone,
        '--quiet',
      ], 300_000);
      if (r.exitCode !== 0) {
        console.error(`[gcp] orphan sweep failed: ${r.stderr?.trim() || r.stdout?.trim() || `exit ${r.exitCode}`}`);
      }
    }
  }

  console.log('[gcp] cleanup complete.');
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

/** Capture comprehensive diagnostics from a broker VM for debugging startup failures. */
async function dumpBrokerDiagnostics(opts: GcpOptions, vmName: string, context: string): Promise<void> {
  console.error(`[gcp]${opts.laneTag ?? ''} ── Diagnostics for ${vmName} (${context}) ──`);

  // 1. Serial console output (startup script logs, visible even if SSH fails)
  const serial = gcloud([
    'compute', 'instances', 'get-serial-port-output', vmName,
    '--project', opts.project,
    '--zone', opts.zone,
  ], 30_000);
  if (serial.exitCode === 0) {
    const lines = serial.stdout.trim().split('\n');
    const tail = lines.slice(-60).join('\n');
    console.error(`[gcp]${opts.laneTag ?? ''} Serial console tail (${vmName}):\n${tail}`);
  } else {
    console.error(`[gcp]${opts.laneTag ?? ''} Serial console unavailable for ${vmName}: ${serial.stderr?.trim()}`);
  }

  // 2. Docker daemon status + image list + pull/container state
  const diagCmd = [
    'echo "=== systemctl status docker ==="',
    'systemctl status docker --no-pager -l 2>&1 || true',
    'echo "=== docker images ==="',
    'docker images 2>&1 || true',
    'echo "=== docker ps -a ==="',
    'docker ps -a 2>&1 || true',
    'echo "=== docker system info (storage) ==="',
    'docker system df 2>&1 || true',
    'echo "=== disk usage ==="',
    'df -h / 2>&1 || true',
    'echo "=== journalctl docker (last 30) ==="',
    'journalctl -u docker --no-pager -n 30 2>&1 || true',
  ].join(' && ');
  const diag = await gcloudAsync(sshArgs(opts, vmName, diagCmd), 30_000);
  if (diag.exitCode === 0 || diag.stdout) {
    console.error(`[gcp]${opts.laneTag ?? ''} Docker diagnostics (${vmName}):\n${diag.stdout}`);
  } else {
    console.error(`[gcp]${opts.laneTag ?? ''} Docker diagnostics failed for ${vmName}: ${diag.stderr?.trim()}`);
  }

  // 3. Broker container logs (if container exists)
  const logs = await fetchBrokerLogs(opts, vmName, 40);
  if (!logs.startsWith('(failed')) {
    console.error(`[gcp]${opts.laneTag ?? ''} Broker container logs (${vmName}):\n${logs}`);
  }

  console.error(`[gcp]${opts.laneTag ?? ''} ── End diagnostics for ${vmName} ──`);
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
      fs.rmSync(tarPath, { force: true });
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
      fs.rmSync(`/tmp/perf-matrix-csharp-${opts.runId}`, { recursive: true, force: true });
      fs.rmSync(tarPath, { force: true });
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
    aggregatorUrl: string;
    totalProcesses: number;
  },
): string {
  const envBlock = `WORKER_PROCESS_ID=${workerId} \\
SDK_MODE=${config.sdkMode} \\
HANDLER_TYPE=${config.handlerType} \\
HANDLER_LATENCY_MS=20 \\
NUM_WORKERS=${config.numWorkers} \\
TARGET_PER_WORKER=${config.targetPerWorker} \\
ACTIVATE_BATCH=32 \\
PAYLOAD_SIZE_KB=10 \\
SCENARIO_TIMEOUT_S=${config.scenarioTimeout} \\
BROKER_REST_URL=${config.brokerRestUrl} \\
BROKER_GRPC_URL=${config.brokerGrpcUrl} \\
AGGREGATOR_URL=${config.aggregatorUrl} \\
RESULT_FILE=/opt/worker/result.json`;

  // --- Producer configuration (leader only) ---
  const producerReadyFile = '/opt/worker/producer-ready';
  const producerGoFile = '/opt/worker/producer-go';
  const producerStopFile = '/opt/worker/producer-stop';
  const producerStatsFile = '/opt/worker/producer-stats.json';
  const precreateStatsFile = '/opt/worker/precreate-stats.json';
  const producerEnv = `BROKER_REST_URL=${config.brokerRestUrl} BPMN_PATH=/opt/worker/test-job-process.bpmn PRECREATE_COUNT=${config.preCreateCount} PAYLOAD_SIZE_KB=10 CONTINUOUS=1 READY_FILE=${producerReadyFile} GO_FILE=${producerGoFile} STOP_FILE=${producerStopFile} PRODUCER_STATS_FILE=${producerStatsFile} PRECREATE_STATS_FILE=${precreateStatsFile}`;

  // Leader: launch producer as background process, then wait for pre-creation to finish
  let leaderSetup = '';
  let leaderStartContinuous = '';
  let leaderStopProducer = '';
  if (config.isLeader) {
    const bpmnDownload = `gsutil cp gs://${opts.bucket}/${opts.runId}/test-job-process.bpmn /opt/worker/test-job-process.bpmn`;

    let producerCmd = '';
    switch (config.sdkLanguage) {
      case 'ts':
        producerCmd = `${producerEnv} npx tsx src/ts-producer.ts`;
        break;
      case 'python':
        producerCmd = `${producerEnv} /opt/worker/venv/bin/python3 /opt/worker/python-producer.py`;
        break;
      case 'csharp':
        producerCmd = `${producerEnv} ./CsharpWorker --produce`;
        break;
      case 'java':
        producerCmd = `${producerEnv} java -Djava.security.egd=file:/dev/./urandom -jar java-worker.jar --produce`;
        break;
    }

    const pythonProducerDownload = config.sdkLanguage === 'python'
      ? `gsutil cp gs://${opts.bucket}/${opts.runId}/python-producer.py /opt/worker/python-producer.py\n`
      : '';

    leaderSetup = `
# ─── Leader: deploy + pre-create + continuous producer ───
${bpmnDownload}

# Download and launch aggregator
gsutil cp gs://${opts.bucket}/${opts.runId}/aggregator.py /opt/worker/aggregator.py
PRECREATE_COUNT=${config.preCreateCount} PRODUCER_RATE=${DEFAULT_PRODUCER_RATE} TOTAL_PROCESSES=${config.totalProcesses} python3 /opt/worker/aggregator.py &
AGGREGATOR_PID=$!
echo "[leader] Aggregator launched (PID=$AGGREGATOR_PID)"
sleep 1

${pythonProducerDownload}${producerCmd} &
PRODUCER_PID=$!
echo "[leader] Producer launched (PID=$PRODUCER_PID), waiting for pre-creation..."
while [ ! -f ${producerReadyFile} ]; do sleep 0.5; done
echo "[leader] Pre-creation done"
`;

    leaderStartContinuous = `
# Signal producer to start continuous creation
echo "1" > ${producerGoFile}
echo "[leader] Continuous producer started"
`;

    leaderStopProducer = `
# Stop continuous producer
touch ${producerStopFile}
wait $PRODUCER_PID 2>/dev/null || true
echo "[leader] Producer stopped"
# Upload producer stats
gsutil cp ${producerStatsFile} \\
  gs://${opts.bucket}/${opts.runId}/scenarios/${scenarioId}/producer-stats.json 2>/dev/null || true
gsutil cp ${precreateStatsFile} \\
  gs://${opts.bucket}/${opts.runId}/scenarios/${scenarioId}/precreate-stats.json 2>/dev/null || true
`;
  }

  // Startup log preamble — capture all output and upload to GCS on failure
  const logPreamble = `#!/bin/bash
exec > >(tee -a /var/log/worker-startup.log) 2>&1
set -euo pipefail
trap 'echo "[FATAL] Startup script failed at line $LINENO (exit $?)"; gsutil cp /var/log/worker-startup.log gs://${opts.bucket}/${opts.runId}/scenarios/${scenarioId}/logs/${workerId}-startup.log 2>/dev/null || true' ERR
echo "=== Worker startup: ${workerId} at $(date) ==="
`;

  const barrierReady = `${leaderSetup}
# Signal ready
echo "1" | gsutil cp - gs://${opts.bucket}/${opts.runId}/scenarios/${scenarioId}/ready/${workerId}

# Wait for go signal
while ! gsutil -q stat gs://${opts.bucket}/${opts.runId}/scenarios/${scenarioId}/go 2>/dev/null; do
  sleep 0.5
done
${leaderStartContinuous}`;

  const uploadResult = `${leaderStopProducer}
# Upload result
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
java -Djava.security.egd=file:/dev/./urandom -jar java-worker.jar

${uploadResult}
`;
  }
}

// ─── VM lifecycle ────────────────────────────────────────

/** Check whether a VM exists (regardless of its status). */
async function vmExists(opts: GcpOptions, vmName: string): Promise<boolean> {
  // Wait a few seconds for eventual consistency — the VM may still be provisioning
  await new Promise((r) => setTimeout(r, 5_000));
  const r = await gcloudAsync([
    'compute', 'instances', 'describe', vmName,
    '--project', opts.project,
    '--zone', opts.zone,
    '--format=value(status)',
  ], 30_000);
  return r.exitCode === 0;
}

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

  const r = await gcloudAsync(args, 300_000);
  // gcloud writes informational "Created [url]" to stderr, not stdout.
  // If our timeout fires after gcloud printed "Created" but before it exited,
  // we get exitCode -1 with the success message in stderr — treat as success.
  const createdInOutput = r.stderr?.includes('Created [') || r.stdout?.includes('Created [');
  if (r.exitCode !== 0 && !createdInOutput) {
    // Timeout may have killed gcloud before it printed "Created [", but the GCP API call
    // could already have been submitted. Poll to check if the VM actually exists.
    console.warn(`[gcp] createVm ${vmName} exited ${r.exitCode} with no "Created" confirmation — checking if VM exists...`);
    const exists = await vmExists(opts, vmName);
    if (!exists) {
      const detail = r.stderr?.trim() || r.stdout?.trim() || `(no output, exit code ${r.exitCode})`;
      console.error(`[gcp] VM ${vmName} does not exist after create attempt: ${detail}`);
      return false;
    }
    console.warn(`[gcp] VM ${vmName} exists despite gcloud timeout — treating as success`);
  } else if (r.exitCode !== 0 && createdInOutput) {
    console.warn(`[gcp] VM ${vmName} created (gcloud timed out waiting for readiness — this is OK)`);
  } else {
    console.log(`[gcp] Created VM: ${vmName}`);
  }
  trackVm(opts, vmName);
  return true;
}

async function deleteVms(opts: GcpOptions, vmNames: string[]): Promise<void> {
  if (vmNames.length === 0) return;
  const r = await gcloudAsync([
    'compute', 'instances', 'delete', ...vmNames,
    '--project', opts.project,
    '--zone', opts.zone,
    '--quiet',
  ], 300_000);
  if (r.exitCode !== 0) {
    const detail = r.stderr?.trim() || r.stdout?.trim() || `exit ${r.exitCode}`;
    console.error(`[gcp] Warning: deleteVms may have partially failed (${vmNames.length} VMs): ${detail}`);
    // Do NOT untrack on failure — leave them in activeVms so cleanupAllVms() can retry.
    // gcloud returns non-zero if ANY VM fails, even if most succeeded.
  } else {
    untrackVms(vmNames);
    console.log(`[gcp] Deleted ${vmNames.length} VMs`);
  }
}

async function getVmInternalIp(opts: GcpOptions, vmName: string): Promise<string> {
  // Retry up to 5 times — gcloud can return empty output under API throttling
  for (let attempt = 1; attempt <= 5; attempt++) {
    const r = await gcloudAsync([
      'compute', 'instances', 'describe', vmName,
      '--project', opts.project,
      '--zone', opts.zone,
      '--format', 'get(networkInterfaces[0].networkIP)',
    ]);
    const ip = r.stdout.trim();
    if (ip && /^\d+\.\d+\.\d+\.\d+$/.test(ip)) return ip;
    console.warn(`[gcp]${opts.laneTag ?? ''} getVmInternalIp(${vmName}): attempt ${attempt}/5 returned "${ip}" (exit ${r.exitCode}) — retrying in ${attempt * 5}s...`);
    await new Promise((resolve) => setTimeout(resolve, attempt * 5_000));
  }
  console.error(`[gcp]${opts.laneTag ?? ''} getVmInternalIp(${vmName}): all 5 attempts failed — returning empty`);
  return '';
}

// ─── Broker pool management ──────────────────────────────

async function provisionBrokerPool(opts: GcpOptions, cluster: ClusterConfig): Promise<BrokerPool | null> {
  const clusterSize = cluster === '3broker' ? 3 : 1;
  const totalPhases = clusterSize > 1 ? 4 : 3; // multi: create, pull, start, health; single: create, pull, health
  const provisionStart = Date.now();
  const vmNames: string[] = [];

  // ── PHASE 1: Create VMs ──
  const phase1Start = Date.now();
  console.log(`[gcp]${opts.laneTag ?? ''} [PHASE 1/${totalPhases}] Creating ${clusterSize} broker VM(s)...`);
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
  const createResults = await Promise.all(createPromises);
  const phase1Elapsed = Math.round((Date.now() - phase1Start) / 1000);
  if (createResults.some((ok) => !ok)) {
    const failed = vmNames.filter((_, i) => !createResults[i]);
    console.error(`[gcp]${opts.laneTag ?? ''} [PHASE 1/${totalPhases}] FAILED after ${phase1Elapsed}s — VM creation failed for: ${failed.join(', ')}`);
    const created = vmNames.filter((_, i) => createResults[i]);
    if (created.length > 0) await deleteVms(opts, created);
    return null;
  }
  console.log(`[gcp]${opts.laneTag ?? ''} [PHASE 1/${totalPhases}] VMs created in ${phase1Elapsed}s`);

  // Collect IPs for all nodes (in parallel)
  const internalIps = await Promise.all(vmNames.map((vm) => getVmInternalIp(opts, vm)));
  console.log(`[gcp]${opts.laneTag ?? ''} Broker IPs: ${vmNames.map((n, i) => `${n}=${internalIps[i]}`).join(', ')}`);

  // Fail fast if any IP is empty (gcloud throttling / API failure)
  const emptyIps = vmNames.filter((_, i) => !internalIps[i]);
  if (emptyIps.length > 0) {
    console.error(`[gcp]${opts.laneTag ?? ''} FAILED — could not resolve IPs for: ${emptyIps.join(', ')}`);
    await deleteVms(opts, vmNames);
    return null;
  }

  const pool: BrokerPool = { cluster, vmNames, internalIps };

  // Multi-broker: startup script only pulled image (COS has Docker pre-installed).
  // Now SSH in to start each container with initialContactPoints (all IPs known).
  if (clusterSize > 1) {
    // ── PHASE 2: Docker pull ──
    const phase2Start = Date.now();
    console.log(`[gcp]${opts.laneTag ?? ''} [PHASE 2/${totalPhases}] Waiting for Docker pull on ${clusterSize} nodes...`);
    // Wait for Docker to be ready on all nodes (pull can take a while)
    const pullDeadline = Date.now() + 600_000; // 10 min for pull
    let pullComplete = false;
    const nodeReady = new Array(clusterSize).fill(false);
    let pullPollCount = 0;
    while (Date.now() < pullDeadline) {
      pullPollCount++;
      const checks = await Promise.all(
        vmNames.map((vm) =>
          gcloudAsync(sshArgs(opts, vm, 'docker image inspect camunda/camunda:' + (process.env.CAMUNDA_VERSION || '8.9-SNAPSHOT') + ' >/dev/null 2>&1'), 30_000),
        ),
      );
      checks.forEach((r, i) => {
        if (r.exitCode === 0 && !nodeReady[i]) {
          nodeReady[i] = true;
          const elapsed = Math.round((Date.now() - phase2Start) / 1000);
          console.log(`[gcp]${opts.laneTag ?? ''} [PHASE 2/${totalPhases}] Node ${i} (${vmNames[i]}) pull complete at ${elapsed}s`);
        }
      });
      if (nodeReady.every(Boolean)) { pullComplete = true; break; }
      if (pullPollCount % 6 === 0) { // Log status every ~60s
        const elapsed = Math.round((Date.now() - phase2Start) / 1000);
        const ready = nodeReady.filter(Boolean).length;
        const pending = vmNames.filter((_, i) => !nodeReady[i]).join(', ');
        console.log(`[gcp]${opts.laneTag ?? ''} [PHASE 2/${totalPhases}] Pull progress: ${ready}/${clusterSize} ready, waiting on: ${pending} — ${elapsed}s`);
      }
      await new Promise((r) => setTimeout(r, 10_000));
    }
    if (!pullComplete) {
      const phase2Elapsed = Math.round((Date.now() - phase2Start) / 1000);
      const pending = vmNames.filter((_, i) => !nodeReady[i]).join(', ');
      console.error(`[gcp]${opts.laneTag ?? ''} [PHASE 2/${totalPhases}] FAILED after ${phase2Elapsed}s — Docker pull timed out. Stuck nodes: ${pending}`);
      const stuckVms = vmNames.filter((_, i) => !nodeReady[i]);
      for (const vm of stuckVms) {
        await dumpBrokerDiagnostics(opts, vm, 'Docker pull timeout');
      }
      await deleteVms(opts, vmNames);
      return null;
    }
    const phase2Elapsed = Math.round((Date.now() - phase2Start) / 1000);
    console.log(`[gcp]${opts.laneTag ?? ''} [PHASE 2/${totalPhases}] Docker pull complete in ${phase2Elapsed}s`);

    // ── PHASE 3: Start containers ──
    const phase3Start = Date.now();
    console.log(`[gcp]${opts.laneTag ?? ''} [PHASE 3/${totalPhases}] Starting broker containers with contact points...`);
    for (let i = 0; i < clusterSize; i++) {
      const cmd = brokerDockerRunCmd(i, clusterSize, internalIps);
      const r = await gcloudAsync(sshArgs(opts, vmNames[i], cmd), 60_000);
      if (r.exitCode !== 0) {
        const phase3Elapsed = Math.round((Date.now() - phase3Start) / 1000);
        console.error(`[gcp]${opts.laneTag ?? ''} [PHASE 3/${totalPhases}] FAILED after ${phase3Elapsed}s — broker ${vmNames[i]}: ${r.stderr}`);
        await dumpBrokerDiagnostics(opts, vmNames[i], 'container start failure');
        await deleteVms(opts, vmNames);
        return null;
      }
      console.log(`[gcp]${opts.laneTag ?? ''} Started broker ${vmNames[i]} (node ${i}) with contact points`);
    }
    const phase3Elapsed = Math.round((Date.now() - phase3Start) / 1000);
    console.log(`[gcp]${opts.laneTag ?? ''} [PHASE 3/${totalPhases}] Containers started in ${phase3Elapsed}s`);
  } else {
    // ── PHASE 2 (single-broker): Docker pull wait ──
    // The startup script does `docker pull` then `docker run` inline.
    // Poll for image presence so pull time doesn't eat into health budget.
    const pullStart = Date.now();
    console.log(`[gcp]${opts.laneTag ?? ''} [PHASE 2/${totalPhases}] Waiting for Docker pull on 1 node...`);
    const pullDeadline = Date.now() + 600_000; // 10 min
    let pullDone = false;
    let pullPollCount = 0;
    while (Date.now() < pullDeadline) {
      pullPollCount++;
      const r = await gcloudAsync(sshArgs(opts, vmNames[0], 'docker image inspect camunda/camunda:' + (process.env.CAMUNDA_VERSION || '8.9-SNAPSHOT') + ' >/dev/null 2>&1'), 30_000);
      if (r.exitCode === 0) {
        pullDone = true;
        const elapsed = Math.round((Date.now() - pullStart) / 1000);
        console.log(`[gcp]${opts.laneTag ?? ''} [PHASE 2/${totalPhases}] Node 0 (${vmNames[0]}) pull complete at ${elapsed}s`);
        break;
      }
      if (pullPollCount % 6 === 0) {
        const elapsed = Math.round((Date.now() - pullStart) / 1000);
        console.log(`[gcp]${opts.laneTag ?? ''} [PHASE 2/${totalPhases}] Pull progress: waiting on ${vmNames[0]} — ${elapsed}s`);
      }
      await new Promise((r) => setTimeout(r, 10_000));
    }
    if (!pullDone) {
      const pullElapsed = Math.round((Date.now() - pullStart) / 1000);
      console.error(`[gcp]${opts.laneTag ?? ''} [PHASE 2/${totalPhases}] FAILED after ${pullElapsed}s — Docker pull timed out on ${vmNames[0]}`);
      await dumpBrokerDiagnostics(opts, vmNames[0], 'Docker pull timeout');
      await deleteVms(opts, vmNames);
      return null;
    }
    const pullElapsed = Math.round((Date.now() - pullStart) / 1000);
    console.log(`[gcp]${opts.laneTag ?? ''} [PHASE 2/${totalPhases}] Docker pull complete in ${pullElapsed}s`);
  }

  // ── PHASE (final): Health check ──
  const healthPhase = totalPhases;
  const healthPhaseStart = Date.now();
  // Timeout is shorter with COS (no Docker install), but JVM still needs time
  const healthTimeout = clusterSize > 1 ? 600_000 : 300_000; // 10 min / 5 min (pull is now separate)
  const healthDeadline = Date.now() + healthTimeout;
  console.log(`[gcp]${opts.laneTag ?? ''} [PHASE ${healthPhase}/${totalPhases}] Waiting for broker health (timeout ${Math.round(healthTimeout / 60_000)} min)...`);
  let brokerReady = false;
  let healthAttempt = 0;
  while (Date.now() < healthDeadline) {
    healthAttempt++;
    const elapsed = Math.round((Date.now() - healthPhaseStart) / 1000);
    if (healthAttempt % 6 === 1) { // Log every ~30s
      const subphase = clusterSize === 1
        ? (elapsed < 120 ? '(JVM starting)' : '(waiting for ready)')
        : (elapsed < 120 ? '(JVM starting + SWIM sync)' : '(waiting for ready)');
      console.log(`[gcp]${opts.laneTag ?? ''} [PHASE ${healthPhase}/${totalPhases}] health poll ${subphase} — ${elapsed}s / ${Math.round(healthTimeout / 1000)}s`);
      await logPoolHealth(opts, pool);
    }
    if (await checkPoolHealth(opts, pool)) {
      brokerReady = true;
      break;
    }
    await new Promise((r) => setTimeout(r, 5000));
  }

  if (!brokerReady) {
    const healthElapsed = Math.round((Date.now() - healthPhaseStart) / 1000);
    const totalElapsed = Math.round((Date.now() - provisionStart) / 1000);
    console.error(`[gcp]${opts.laneTag ?? ''} [PHASE ${healthPhase}/${totalPhases}] FAILED after ${healthElapsed}s — broker not healthy (total provisioning: ${totalElapsed}s)`);
    await logPoolHealth(opts, pool);
    for (const vm of vmNames) {
      console.error(`[gcp]${opts.laneTag ?? ''} Docker logs for ${vm}:\n${await fetchBrokerLogs(opts, vm, 40)}`);
    }
    console.error(`[gcp]${opts.laneTag ?? ''} Cleaning up failed broker VMs...`);
    await deleteVms(opts, vmNames);
    return null;
  }
  const healthElapsed = Math.round((Date.now() - healthPhaseStart) / 1000);
  const totalElapsed = Math.round((Date.now() - provisionStart) / 1000);
  console.log(`[gcp]${opts.laneTag ?? ''} [PHASE ${healthPhase}/${totalPhases}] Brokers healthy in ${healthElapsed}s`);
  console.log(`[gcp]${opts.laneTag ?? ''} Broker pool ready (${clusterSize} nodes) — total provisioning: ${totalElapsed}s`);
  return pool;
}

async function teardownBrokerPool(opts: GcpOptions, pool: BrokerPool): Promise<void> {
  await deleteVms(opts, pool.vmNames);
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
      // Force-kill (no graceful shutdown) to avoid snapshot corruption from partial writes.
      // Then nuke all Docker state: containers, volumes, build cache — so the next
      // `docker run` starts with zero Zeebe/RocksDB/Raft state, identical to first boot.
      const resetScript = [
        'docker kill camunda-broker 2>/dev/null || true',
        'docker rm -f -v camunda-broker 2>/dev/null || true',
        'docker volume rm -f $(docker volume ls -q) 2>/dev/null || true',
        'docker system prune -f --volumes 2>/dev/null || true',
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

// ─── Prometheus metrics scraping ─────────────────────────

interface MetricsSnapshot {
  counters: Record<string, number>;
  histCounts: Record<string, number>;
  histSums: Record<string, number>;
  gauges: Record<string, number>;
}

const PROM_COUNTERS = [
  'zeebe_received_request_count_total',
  'zeebe_dropped_request_count_total',
  'zeebe_deferred_append_count_total',
  'zeebe_broker_jobs_pushed_count_total',
  'zeebe_broker_jobs_push_fail_count_total',
  'zeebe_stream_processor_records_total',
];

const PROM_HISTOGRAMS = [
  'zeebe_job_activation_time_seconds',
  'zeebe_job_life_time_seconds',
  'zeebe_process_instance_execution_time_seconds',
];

// Gauges: summed across all label variants per metric
const PROM_GAUGES = [
  'process_cpu_usage',
  'system_cpu_usage',
  'jvm_threads_live_threads',
];

// Gauges where all label variants should be summed into one value
const PROM_GAUGE_SUM = [
  'jvm_memory_used_bytes',
];

function parsePrometheusText(text: string): MetricsSnapshot {
  const snap: MetricsSnapshot = { counters: {}, histCounts: {}, histSums: {}, gauges: {} };
  for (const line of text.split('\n')) {
    if (line.startsWith('#') || !line.trim()) continue;
    for (const metric of PROM_COUNTERS) {
      if (line.startsWith(metric)) {
        const val = parseFloat(line.split(/\s+/).pop() || '0');
        snap.counters[metric] = (snap.counters[metric] || 0) + val;
      }
    }
    for (const metric of PROM_HISTOGRAMS) {
      if (line.startsWith(`${metric}_count`)) {
        const val = parseFloat(line.split(/\s+/).pop() || '0');
        snap.histCounts[metric] = (snap.histCounts[metric] || 0) + val;
      }
      if (line.startsWith(`${metric}_sum`)) {
        const val = parseFloat(line.split(/\s+/).pop() || '0');
        snap.histSums[metric] = (snap.histSums[metric] || 0) + val;
      }
    }
    for (const metric of PROM_GAUGES) {
      if (line.startsWith(metric + ' ') || line.startsWith(metric + '{')) {
        const val = parseFloat(line.split(/\s+/).pop() || '0');
        snap.gauges[metric] = (snap.gauges[metric] || 0) + val;
      }
    }
    for (const metric of PROM_GAUGE_SUM) {
      if (line.startsWith(metric + '{')) {
        const val = parseFloat(line.split(/\s+/).pop() || '0');
        snap.gauges[metric] = (snap.gauges[metric] || 0) + val;
      }
    }
  }
  return snap;
}

/** Scrape Prometheus from all brokers in the pool via SSH, summing across nodes. */
async function scrapeMetricsGcp(opts: GcpOptions, pool: BrokerPool): Promise<MetricsSnapshot> {
  const combined: MetricsSnapshot = { counters: {}, histCounts: {}, histSums: {}, gauges: {} };

  const scrapeOne = async (vm: string, ip: string): Promise<{ stdout: string; exitCode: number }> => {
    for (let attempt = 0; attempt < 3; attempt++) {
      const r = isRunningOnGcpVm()
        ? await spawnAsync('curl', ['-sf', '--connect-timeout', '5', '--max-time', '30',
            `http://${ip}:9600/actuator/prometheus`], 40_000)
        : await gcloudAsync(sshArgs(opts, vm,
            'curl -sf --max-time 30 http://localhost:9600/actuator/prometheus'), 60_000);
      if (r.exitCode === 0 && r.stdout.length > 0) return r;
      if (attempt < 2) await new Promise(res => setTimeout(res, 2000));
    }
    return { stdout: '', exitCode: -1 };
  };

  const results = await Promise.all(
    pool.vmNames.map((vm, i) => scrapeOne(vm, pool.internalIps[i])),
  );

  for (const r of results) {
    if (r.exitCode !== 0) continue;
    const snap = parsePrometheusText(r.stdout || '');
    for (const [k, v] of Object.entries(snap.counters)) combined.counters[k] = (combined.counters[k] || 0) + v;
    for (const [k, v] of Object.entries(snap.histCounts)) combined.histCounts[k] = (combined.histCounts[k] || 0) + v;
    for (const [k, v] of Object.entries(snap.histSums)) combined.histSums[k] = (combined.histSums[k] || 0) + v;
    for (const [k, v] of Object.entries(snap.gauges)) combined.gauges[k] = (combined.gauges[k] || 0) + v;
  }

  return combined;
}

// ─── Gauge sampling during test run ──────────────────────

interface GaugeSample {
  timestampMs: number;
  processCpu: number;       // sum of process_cpu_usage across brokers
  systemCpu: number;        // sum of system_cpu_usage across brokers
  memoryUsedBytes: number;  // sum of jvm_memory_used_bytes across brokers
  liveThreads: number;      // sum of jvm_threads_live_threads across brokers
}

/**
 * Periodically scrape JVM gauge metrics from brokers until aborted.
 * Returns collected samples for post-run analysis.
 */
async function sampleGaugesDuring(
  opts: GcpOptions,
  pool: BrokerPool,
  intervalMs: number,
  abortSignal: AbortSignal,
): Promise<GaugeSample[]> {
  const samples: GaugeSample[] = [];
  while (!abortSignal.aborted) {
    try {
      const snap = await scrapeMetricsGcp(opts, pool);
      samples.push({
        timestampMs: Date.now(),
        processCpu: snap.gauges['process_cpu_usage'] || 0,
        systemCpu: snap.gauges['system_cpu_usage'] || 0,
        memoryUsedBytes: snap.gauges['jvm_memory_used_bytes'] || 0,
        liveThreads: snap.gauges['jvm_threads_live_threads'] || 0,
      });
    } catch {
      // Scrape failed — skip this sample
    }
    // Wait for interval or abort
    await new Promise<void>((resolve) => {
      if (abortSignal.aborted) return resolve();
      const timer = setTimeout(resolve, intervalMs);
      abortSignal.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
    });
  }
  return samples;
}

function computeResourceUsage(samples: GaugeSample[], brokerCount: number): ServerResourceUsage | null {
  if (samples.length === 0) return null;
  const avg = (vals: number[]) => vals.reduce((a, b) => a + b, 0) / vals.length;
  const peak = (vals: number[]) => Math.max(...vals);

  // CPU values are summed across brokers — divide by broker count for per-broker avg
  const cpuPerBroker = samples.map((s) => s.processCpu / brokerCount);
  const sysCpuPerBroker = samples.map((s) => s.systemCpu / brokerCount);
  const memMb = samples.map((s) => s.memoryUsedBytes / (1024 * 1024));
  const threads = samples.map((s) => s.liveThreads);

  return {
    samples: samples.length,
    cpuAvg: avg(cpuPerBroker),
    cpuPeak: peak(cpuPerBroker),
    systemCpuAvg: avg(sysCpuPerBroker),
    systemCpuPeak: peak(sysCpuPerBroker),
    memoryUsedAvgMb: avg(memMb),
    memoryUsedPeakMb: peak(memMb),
    liveThreadsAvg: avg(threads),
    liveThreadsPeak: peak(threads),
  };
}

function computeMetricsDelta(before: MetricsSnapshot, after: MetricsSnapshot): ServerMetrics | null {
  const d = (metric: string) => (after.counters[metric] || 0) - (before.counters[metric] || 0);
  const hc = (metric: string) => (after.histCounts[metric] || 0) - (before.histCounts[metric] || 0);
  const hs = (metric: string) => (after.histSums[metric] || 0) - (before.histSums[metric] || 0);
  const avgMs = (metric: string) => {
    const count = hc(metric);
    const sum = hs(metric);
    // Negative delta means partial scrape failure (e.g. one broker missing from after-scrape)
    if (count <= 0 || sum < 0) return null;
    const ms = (sum / count) * 1000;
    // Sanity: if average exceeds 1 hour, the data is corrupt (stale accumulation, partial scrape, etc.)
    if (ms > 3_600_000) return null;
    return ms;
  };

  const result: ServerMetrics = {
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

  // Negative counter delta means the after-scrape failed — discard
  if (result.receivedRequests < 0 || result.recordsProcessed < 0) {
    console.warn('  [metrics] After-scrape appears invalid (negative deltas), discarding');
    return null;
  }
  return result;
}

// ─── GCS coordination ────────────────────────────────────

async function gcsWaitForFiles(bucket: string, prefix: string, expectedCount: number, timeoutMs: number): Promise<boolean> {
  const startTime = Date.now();
  const deadline = startTime + timeoutMs;
  let lastLoggedCount = -1;
  let pollCount = 0;
  while (Date.now() < deadline) {
    pollCount++;
    const r = await spawnAsync('gsutil', ['ls', `gs://${bucket}/${prefix}`], 15_000);
    const files = (r.stdout || '').trim().split('\n').filter((l) => l.trim().length > 0);
    if (files.length >= expectedCount) return true;
    const elapsed = Math.round((Date.now() - startTime) / 1000);
    if (files.length !== lastLoggedCount || pollCount % 15 === 1) { // Log on change or every ~30s
      console.log(`    ↳ GCS barrier: ${files.length}/${expectedCount} files (${elapsed}s elapsed)`);
      lastLoggedCount = files.length;
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
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

function gcsWriteJson(bucket: string, filePath: string, data: unknown): void {
  const tmpFile = `/tmp/gcs-write-${Date.now()}.json`;
  try {
    fs.writeFileSync(tmpFile, JSON.stringify(data, null, 2));
    gsutil(['cp', tmpFile, `gs://${bucket}/${filePath}`], 15_000);
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

  // Upload aggregator script (leader will download and run it)
  const aggregatorPath = path.resolve(import.meta.dirname, 'aggregator.py');
  gsutil(['cp', aggregatorPath, `gs://${opts.bucket}/${opts.runId}/aggregator.py`]);

  let preCreate = { created: 0, errors: 0, durationS: 0 };

  // Provision worker VMs — leader first so we can get its IP for the aggregator URL
  const workerVmNames: string[] = [];
  const leaderVmName = `pw-${vmTag(opts.runId)}-${scenario.id.toLowerCase().replace(/[^a-z0-9-]/g, '-')}-0`;

  // Create leader VM (p=0)
  const leaderScript = workerStartupScript(opts, scenario.id, 'process-0', {
    sdkLanguage, sdkMode, handlerType,
    numWorkers: WPP,
    targetPerWorker: opts.targetPerWorker,
    scenarioTimeout: opts.scenarioTimeout,
    brokerRestUrl, brokerGrpcUrl,
    preCreateCount: opts.preCreateCount,
    isLeader: true,
    aggregatorUrl: 'http://localhost:3333',
    totalProcesses: P,
  });

  const leaderOk = await createVm(opts, leaderVmName, GCP_DEFAULTS.workerMachineType, leaderScript, ['perf-worker']);
  if (!leaderOk) {
    console.error(`  [${scenario.id}] Leader VM creation failed — aborting scenario`);
    await deleteVms(opts, [leaderVmName]);
    return errorResult(scenario, `Leader VM creation failed: ${leaderVmName}`);
  }
  workerVmNames.push(leaderVmName);

  // Get leader IP for aggregator URL
  const leaderIp = await getVmInternalIp(opts, leaderVmName);
  if (!leaderIp) {
    console.error(`  [${scenario.id}] Could not get leader IP — aborting scenario`);
    await deleteVms(opts, workerVmNames);
    return errorResult(scenario, `Could not get leader IP for aggregator`);
  }
  const aggregatorUrl = `http://${leaderIp}:3333`;
  console.log(`  [${scenario.id}] Leader ${leaderVmName} IP=${leaderIp}, aggregator=${aggregatorUrl}`);

  // Create follower VMs (p=1..P-1)
  for (let p = 1; p < P; p++) {
    const workerId = `process-${p}`;
    const vmName = `pw-${vmTag(opts.runId)}-${scenario.id.toLowerCase().replace(/[^a-z0-9-]/g, '-')}-${p}`;
    const script = workerStartupScript(opts, scenario.id, workerId, {
      sdkLanguage, sdkMode, handlerType,
      numWorkers: WPP,
      targetPerWorker: opts.targetPerWorker,
      scenarioTimeout: opts.scenarioTimeout,
      brokerRestUrl, brokerGrpcUrl,
      preCreateCount: 0,
      isLeader: false,
      aggregatorUrl,
      totalProcesses: P,
    });

    const vmOk = await createVm(opts, vmName, GCP_DEFAULTS.workerMachineType, script, ['perf-worker']);
    if (!vmOk) {
      console.error(`  [${scenario.id}] Worker VM creation failed — aborting scenario`);
      // Include the failing VM name: createVm may have timed out after the VM was actually created
      await deleteVms(opts, [...workerVmNames, vmName]);
      return errorResult(scenario, `Worker VM creation failed: ${vmName}`);
    }
    workerVmNames.push(vmName);
  }

  // Wait for all workers to be ready
  console.log(`  [${scenario.id}] Waiting for ${P} workers to be ready...`);
  const workersReady = await gcsWaitForFiles(
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
    await deleteVms(opts, workerVmNames);
    return errorResult(scenario, 'Workers failed to become ready');
  }

  // Scrape metrics before GO
  const metricsBefore = await scrapeMetricsGcp(opts, brokerPool);

  // Signal GO
  console.log(`  [${scenario.id}] All workers ready, sending GO...`);
  gcsWriteFlag(opts.bucket, `${scenarioGcsPrefix}/go`);
  const t0 = Date.now();

  // Start gauge sampling in parallel with the test run (every 30s)
  const gaugeAbort = new AbortController();
  const gaugeSamplingPromise = sampleGaugesDuring(opts, brokerPool, 30_000, gaugeAbort.signal);

  // Wait for results
  const resultsReady = await gcsWaitForFiles(
    opts.bucket,
    `${scenarioGcsPrefix}/results/`,
    P,
    (opts.scenarioTimeout + 60) * 1000,
  );

  // Stop gauge sampling
  gaugeAbort.abort();
  const gaugeSamples = await gaugeSamplingPromise;
  console.log(`  [${scenario.id}] Collected ${gaugeSamples.length} gauge samples`);

  const wallClockS = (Date.now() - t0) / 1000;
  const isTimeout = !resultsReady;

  // Collect results
  const processResults: ProcessResult[] = [];
  const processWallClocks: number[] = [];
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
        ...(data.memoryUsage ? { memoryUsage: data.memoryUsage } : {}),
        ...(data.errorTypes ? { errorTypes: data.errorTypes } : {}),
      });
      if (typeof data.wallClockS === 'number' && data.wallClockS > 0) {
        processWallClocks.push(data.wallClockS);
      }
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

  // Scrape metrics after results collected
  const metricsAfter = await scrapeMetricsGcp(opts, brokerPool);

  // Read pre-creation stats (uploaded by leader VM)
  try {
    const pcStats = gcsReadJson(opts.bucket, `${scenarioGcsPrefix}/precreate-stats.json`);
    preCreate = {
      created: pcStats.created || 0,
      errors: pcStats.errors || 0,
      durationS: pcStats.durationS || 0,
    };
    console.log(`  [${scenario.id}] Pre-create: ${preCreate.created} created, ${preCreate.errors} errors in ${preCreate.durationS.toFixed(1)}s`);
  } catch {
    console.log(`  [${scenario.id}] No pre-create stats found`);
  }

  // Read continuous producer stats (uploaded by leader VM)
  let continuousProducer: { created: number; errors: number; durationS: number; rate: number } | null = null;
  try {
    const stats = gcsReadJson(opts.bucket, `${scenarioGcsPrefix}/producer-stats.json`);
    continuousProducer = {
      created: stats.created || 0,
      errors: stats.errors || 0,
      durationS: stats.durationS || 0,
      rate: stats.rate || 0,
    };
    console.log(`  [${scenario.id}] Continuous producer: ${continuousProducer.created} created at ~${continuousProducer.rate.toFixed(0)}/s`);
  } catch {
    console.log(`  [${scenario.id}] No continuous producer stats found`);
  }

  // Cleanup worker VMs
  await deleteVms(opts, workerVmNames);

  // Aggregate
  const totalCompleted = processResults.reduce((s, p) => s + p.completed, 0);
  const totalErrors = processResults.reduce((s, p) => s + p.errors, 0);
  // Use max worker wallClockS for throughput (avoids GCS barrier/upload overhead inflating the denominator)
  const maxProcessWallClockS = processWallClocks.length > 0 ? Math.max(...processWallClocks) : wallClockS;
  const aggregateThroughput = maxProcessWallClockS > 0 ? totalCompleted / maxProcessWallClockS : 0;
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
    serverMetrics: computeMetricsDelta(metricsBefore, metricsAfter),
    serverResourceUsage: computeResourceUsage(gaugeSamples, brokerPool.vmNames.length),
    status: isTimeout ? 'timeout' : 'ok',
    preCreate,
    continuousProducer,
  };

  console.log(`  [${scenario.id}] => ${aggregateThroughput.toFixed(1)}/s, ${totalErrors} errors, ${wallClockS.toFixed(1)}s, Jain=${fairness.toFixed(3)}`);

  // Upload aggregated summary to GCS for post-run analysis
  try {
    gcsWriteJson(opts.bucket, `${scenarioGcsPrefix}/results/scenario-summary.json`, result);
  } catch (e) {
    console.warn(`  [${scenario.id}] Failed to upload scenario summary to GCS:`, e);
  }

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
    processResults: [], serverMetrics: null, serverResourceUsage: null,
    status: 'error', errorMessage: message,
    preCreate: { created: 0, errors: 0, durationS: 0 },
    continuousProducer: null,
  };
}

// ─── Exports for orchestrator ────────────────────────────

export { provisionBrokerPool, teardownBrokerPool, resetBrokerPool, cleanupAllVms };
export type { GcpOptions, BrokerPool };
