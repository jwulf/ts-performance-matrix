#!/usr/bin/env tsx
/**
 * Smoketest — quickly validates that every (language, mode, handler) combination
 * can activate and complete at least a few jobs against a local Docker broker.
 *
 * Catches deployment issues (missing files in tar, broken workers, daemon thread
 * hangs, etc.) before a costly GCP run.
 *
 * Usage:
 *   npx tsx src/smoketest.ts
 *
 * Prerequisites:
 *   - Docker running
 *   - npm install done
 *   - Python venv with camunda-orchestration-sdk (auto-created if missing)
 *   - Java (JDK 21+) for Java workers
 *   - .NET SDK for C# workers
 */

import * as childProcess from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { VALID_LANG_MODES, HANDLER_TYPES, type SdkLanguage, type SdkMode, type HandlerType } from './config.js';
import { restartContainer, deployProcess, preCreateInstances } from './local-runner.js';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');
const DOCKER_DIR = path.join(REPO_ROOT, 'docker');
const COMPOSE_1BROKER = path.join(DOCKER_DIR, 'docker-compose.1broker.yaml');

// Smoketest parameters — intentionally tiny
const TARGET_PER_WORKER = 5;
const SCENARIO_TIMEOUT_S = 60;
const PRE_CREATE_COUNT = 20; // enough for 2 handlers × 5 target
const HANDLER_LATENCY_MS = 5;

interface SmoketestCase {
  language: SdkLanguage;
  mode: SdkMode;
  handler: HandlerType;
}

interface SmoketestResult {
  case: SmoketestCase;
  status: 'pass' | 'fail';
  completed: number;
  errors: number;
  wallClockS: number;
  error?: string;
}

// ─── Language-specific spawn commands ────────────────────

const JAVA_WORKER_DIR = path.join(REPO_ROOT, 'src', 'workers', 'java-worker');
const CSHARP_WORKER_DIR = path.join(REPO_ROOT, 'src', 'workers', 'csharp-worker');
const PYTHON_WORKER = path.join(REPO_ROOT, 'src', 'workers', 'python-worker.py');
const TS_WORKER = path.join(REPO_ROOT, 'src', 'worker-process.ts');
const PYTHON_VENV = path.join(REPO_ROOT, '.venv');

function spawnWorker(
  tc: SmoketestCase,
  env: Record<string, string>,
): { child: childProcess.ChildProcess; label: string } {
  const label = `${tc.language}-${tc.mode}-${tc.handler}`;

  switch (tc.language) {
    case 'ts':
      return {
        label,
        child: childProcess.spawn('npx', ['tsx', TS_WORKER], {
          env, stdio: ['ignore', 'pipe', 'pipe'], cwd: REPO_ROOT,
        }),
      };
    case 'python': {
      const pythonBin = path.join(PYTHON_VENV, 'bin', 'python3');
      return {
        label,
        child: childProcess.spawn(pythonBin, [PYTHON_WORKER], {
          env, stdio: ['ignore', 'pipe', 'pipe'], cwd: REPO_ROOT,
        }),
      };
    }
    case 'java': {
      const jarPath = path.join(JAVA_WORKER_DIR, 'target', 'java-worker-1.0-SNAPSHOT.jar');
      return {
        label,
        child: childProcess.spawn('java', ['-jar', jarPath], {
          env, stdio: ['ignore', 'pipe', 'pipe'], cwd: JAVA_WORKER_DIR,
        }),
      };
    }
    case 'csharp':
      return {
        label,
        child: childProcess.spawn('dotnet', ['run', '--project', CSHARP_WORKER_DIR, '-c', 'Release'], {
          env, stdio: ['ignore', 'pipe', 'pipe'], cwd: REPO_ROOT,
        }),
      };
  }
}

// ─── Prerequisite checks ─────────────────────────────────

function ensurePythonVenv(): boolean {
  const pip = path.join(PYTHON_VENV, 'bin', 'pip');
  if (!fs.existsSync(pip)) {
    console.log('  [prereq] Creating Python venv...');
    const r = childProcess.spawnSync('python3', ['-m', 'venv', PYTHON_VENV], {
      stdio: 'inherit', timeout: 30_000,
    });
    if (r.status !== 0) {
      console.error('  [prereq] Failed to create Python venv');
      return false;
    }
  }
  // Install deps first (stable versions), then SDK with --no-deps to match GCP pattern.
  // This avoids the SDK pulling an incompatible transitive dep version.
  console.log('  [prereq] Installing Python deps + SDK...');
  const deps = childProcess.spawnSync(
    path.join(PYTHON_VENV, 'bin', 'pip'),
    ['install', '--quiet', 'httpx>=0.27,<1', 'attrs', 'pydantic', 'python-dateutil', 'loguru', 'python-dotenv', 'typing-extensions'],
    { stdio: 'inherit', timeout: 60_000 },
  );
  if (deps.status !== 0) return false;
  const sdk = childProcess.spawnSync(
    path.join(PYTHON_VENV, 'bin', 'pip'),
    ['install', '--pre', '--no-deps', '--quiet', 'camunda-orchestration-sdk'],
    { stdio: 'inherit', timeout: 60_000 },
  );
  return sdk.status === 0;
}

function ensureJavaJar(): boolean {
  const jarPath = path.join(JAVA_WORKER_DIR, 'target', 'java-worker-1.0-SNAPSHOT.jar');
  if (fs.existsSync(jarPath)) return true;
  console.log('  [prereq] Building Java worker...');
  const mvnw = path.join(JAVA_WORKER_DIR, 'mvnw');
  const r = childProcess.spawnSync(mvnw, ['-f', path.join(JAVA_WORKER_DIR, 'pom.xml'), 'package', '-q', '-DskipTests'], {
    stdio: 'inherit', timeout: 120_000,
  });
  return r.status === 0;
}

function ensureCsharpBuild(): boolean {
  console.log('  [prereq] Building C# worker...');
  const r = childProcess.spawnSync('dotnet', ['build', CSHARP_WORKER_DIR, '-c', 'Release', '--nologo', '-v', 'q'], {
    stdio: 'inherit', timeout: 120_000,
  });
  return r.status === 0;
}

// ─── Run a single test case ──────────────────────────────

async function runCase(tc: SmoketestCase): Promise<SmoketestResult> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'smoketest-'));
  const resultFile = path.join(tmpDir, 'result.json');
  const readyFile = path.join(tmpDir, 'ready');
  const goFile = path.join(tmpDir, 'go');

  // Signal GO immediately (no barrier needed for single-process smoketest)
  fs.writeFileSync(goFile, '1');

  const env: Record<string, string> = {
    ...process.env as Record<string, string>,
    WORKER_PROCESS_ID: 'smoke-0',
    SDK_MODE: tc.mode,
    HANDLER_TYPE: tc.handler,
    HANDLER_LATENCY_MS: String(HANDLER_LATENCY_MS),
    NUM_WORKERS: '1',
    TARGET_PER_WORKER: String(TARGET_PER_WORKER),
    ACTIVATE_BATCH: '10',
    PAYLOAD_SIZE_KB: '1',
    SCENARIO_TIMEOUT_S: String(SCENARIO_TIMEOUT_S),
    BROKER_REST_URL: 'http://localhost:8080',
    BROKER_GRPC_URL: 'localhost:26500',
    RESULT_FILE: resultFile,
    READY_FILE: readyFile,
    GO_FILE: goFile,
  };

  const t0 = Date.now();
  const { child, label } = spawnWorker(tc, env);

  // Capture stderr for diagnostics
  let stderr = '';
  child.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });
  child.stdout?.on('data', () => {}); // drain

  const exitCode = await Promise.race([
    new Promise<number | null>((resolve) => {
      child.on('exit', (code) => resolve(code));
      child.on('error', () => resolve(-1));
    }),
    new Promise<number | null>((resolve) =>
      setTimeout(() => {
        child.kill('SIGKILL');
        resolve(null);
      }, SCENARIO_TIMEOUT_S * 1000),
    ),
  ]);

  const wallClockS = (Date.now() - t0) / 1000;

  if (exitCode === null) {
    return { case: tc, status: 'fail', completed: 0, errors: 0, wallClockS, error: 'TIMEOUT' };
  }

  // Read result file
  try {
    const data = JSON.parse(fs.readFileSync(resultFile, 'utf-8'));
    const completed = data.totalCompleted || 0;
    const errors = data.totalErrors || 0;
    const pass = completed >= TARGET_PER_WORKER;
    return {
      case: tc,
      status: pass ? 'pass' : 'fail',
      completed, errors, wallClockS,
      ...(pass ? {} : { error: `Only ${completed}/${TARGET_PER_WORKER} completed. stderr: ${stderr.slice(-500)}` }),
    };
  } catch {
    return {
      case: tc, status: 'fail', completed: 0, errors: 0, wallClockS,
      error: `No result file (exit=${exitCode}). stderr: ${stderr.slice(-500)}`,
    };
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

// ─── Main ────────────────────────────────────────────────

async function main() {
  console.log('╔══════════════════════════════════════════════════════╗');
  console.log('║          Performance Matrix — Smoketest             ║');
  console.log('╚══════════════════════════════════════════════════════╝\n');

  // Build all test cases: (language, mode) × handler
  const cases: SmoketestCase[] = [];
  for (const [lang, modes] of Object.entries(VALID_LANG_MODES)) {
    for (const mode of modes) {
      for (const handler of HANDLER_TYPES) {
        cases.push({ language: lang as SdkLanguage, mode: mode as SdkMode, handler });
      }
    }
  }

  console.log(`Test cases: ${cases.length} combinations\n`);
  for (const tc of cases) {
    console.log(`  ${tc.language}-${tc.mode}-${tc.handler}`);
  }

  // ── Prerequisites ──
  console.log('\n── Prerequisites ──\n');

  const langSet = new Set(cases.map((c) => c.language));

  if (langSet.has('python') && !ensurePythonVenv()) {
    console.error('FATAL: Python venv setup failed');
    process.exit(1);
  }
  if (langSet.has('java') && !ensureJavaJar()) {
    console.error('FATAL: Java worker build failed');
    process.exit(1);
  }
  if (langSet.has('csharp') && !ensureCsharpBuild()) {
    console.error('FATAL: C# worker build failed');
    process.exit(1);
  }

  // ── Start broker ──
  console.log('\n── Starting broker ──\n');

  if (!restartContainer(COMPOSE_1BROKER)) {
    console.error('FATAL: Could not start broker');
    process.exit(1);
  }

  // ── Deploy + pre-create ──
  console.log('\n── Deploying test process ──\n');
  const processDefKey = await deployProcess();
  console.log(`  Process deployed: ${processDefKey}`);

  console.log(`\n── Pre-creating ${PRE_CREATE_COUNT} instances ──\n`);
  const preCreate = await preCreateInstances(processDefKey, PRE_CREATE_COUNT);

  if (preCreate.created < PRE_CREATE_COUNT * 0.5) {
    console.error(`FATAL: Pre-creation mostly failed (${preCreate.created}/${PRE_CREATE_COUNT})`);
    process.exit(1);
  }

  // ── Run test cases ──
  console.log('\n── Running smoketest cases ──\n');

  const results: SmoketestResult[] = [];
  let passed = 0;
  let failed = 0;

  // Run sequentially — we're testing correctness, not throughput.
  // Pre-create more instances between groups to keep the pool fed.
  let instancesAvailable = preCreate.created;

  for (let i = 0; i < cases.length; i++) {
    const tc = cases[i];
    const label = `${tc.language}-${tc.mode}-${tc.handler}`;

    // Ensure we have enough instances for this case
    if (instancesAvailable < TARGET_PER_WORKER + 5) {
      console.log(`  [refill] Creating more instances...`);
      const refill = await preCreateInstances(processDefKey, PRE_CREATE_COUNT);
      instancesAvailable += refill.created;
    }

    process.stdout.write(`  [${i + 1}/${cases.length}] ${label.padEnd(35)} `);
    const result = await runCase(tc);
    results.push(result);
    instancesAvailable -= result.completed;

    if (result.status === 'pass') {
      passed++;
      console.log(`✓ PASS  (${result.completed} jobs, ${result.wallClockS.toFixed(1)}s)`);
    } else {
      failed++;
      console.log(`✗ FAIL  ${result.error}`);
    }
  }

  // ── Summary ──
  console.log('\n══════════════════════════════════════════════════════');
  console.log(`  Results: ${passed} passed, ${failed} failed, ${cases.length} total`);
  console.log('══════════════════════════════════════════════════════\n');

  if (failed > 0) {
    console.log('Failed cases:');
    for (const r of results.filter((r) => r.status === 'fail')) {
      console.log(`  ✗ ${r.case.language}-${r.case.mode}-${r.case.handler}: ${r.error}`);
    }
    console.log();
  }

  // Shut down broker
  console.log('Stopping broker...');
  childProcess.spawnSync('docker', ['compose', '-f', COMPOSE_1BROKER, 'down', '--timeout', '10', '--volumes', '--remove-orphans'], {
    stdio: 'inherit',
  });

  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
