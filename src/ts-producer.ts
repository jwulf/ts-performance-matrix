/**
 * TS Producer — deploys BPMN, pre-creates process instances, and optionally
 * runs a continuous producer during the benchmark.
 *
 * Runs on the leader (worker-0) VM.
 *
 * Environment variables:
 *   BROKER_REST_URL        — broker REST URL (e.g., http://10.x.x.x:8080)
 *   BPMN_PATH              — path to the BPMN file to deploy
 *   PRECREATE_COUNT        — number of process instances to pre-create (buffer)
 *   PAYLOAD_SIZE_KB        — variable payload size in KB (default: 10)
 *   CONTINUOUS             — if "1", keep creating after pre-creation until STOP_FILE appears
 *   READY_FILE             — write "1" here when pre-creation is done (optional)
 *   GO_FILE                — wait for this file before starting continuous mode (optional)
 *   STOP_FILE              — stop continuous production when this file appears
 *   PRODUCER_STATS_FILE    — write continuous producer stats JSON here on exit
 */

import * as fs from 'node:fs';
import { createCamundaClient, ProcessDefinitionKey } from '@camunda8/orchestration-cluster-api';

const BROKER_REST_URL = process.env.BROKER_REST_URL || 'http://localhost:8080';
const BPMN_PATH = process.env.BPMN_PATH || '';
const PRECREATE_COUNT = parseInt(process.env.PRECREATE_COUNT || '0', 10);
const PAYLOAD_SIZE_KB = parseInt(process.env.PAYLOAD_SIZE_KB || '10', 10);
const CONCURRENCY = 50;
const CONTINUOUS = process.env.CONTINUOUS === '1';
const READY_FILE = process.env.READY_FILE || '';
const GO_FILE = process.env.GO_FILE || '';
const STOP_FILE = process.env.STOP_FILE || '';
const PRODUCER_STATS_FILE = process.env.PRODUCER_STATS_FILE || '';

async function createBatch(
  client: ReturnType<typeof createCamundaClient>,
  processDefKey: string,
  payload: string,
  count: number,
  label: string,
): Promise<{ created: number; errors: number; durationS: number }> {
  let created = 0;
  let errors = 0;
  const inflight: Promise<void>[] = [];
  const t0 = Date.now();
  let lastLog = Date.now();

  console.log(`[ts-producer] ${label}: creating ${count} instances...`);

  while (created + errors < count) {
    while (inflight.length < CONCURRENCY && created + errors + inflight.length < count) {
      const p = client
        .createProcessInstance({
          processDefinitionKey: ProcessDefinitionKey.assumeExists(processDefKey),
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
    if (Date.now() - lastLog > 10_000) {
      const elapsed = ((Date.now() - t0) / 1000).toFixed(0);
      const rate = (created / ((Date.now() - t0) / 1000)).toFixed(0);
      console.log(`[ts-producer] ${label}: ${created + errors}/${count} (${created} ok, ${errors} err) ${elapsed}s, ~${rate}/s`);
      lastLog = Date.now();
    }
    await new Promise((r) => setTimeout(r, 5));
  }
  await Promise.allSettled(inflight);

  const durationS = (Date.now() - t0) / 1000;
  console.log(`[ts-producer] ${label}: done ${created} created, ${errors} errors in ${durationS.toFixed(1)}s`);
  return { created, errors, durationS };
}

async function continuousLoop(
  client: ReturnType<typeof createCamundaClient>,
  processDefKey: string,
  payload: string,
): Promise<void> {
  let created = 0;
  let errors = 0;
  const inflight: Promise<void>[] = [];
  const t0 = Date.now();
  let lastLog = Date.now();

  console.log(`[ts-producer] continuous: starting (concurrency=${CONCURRENCY})...`);

  while (!STOP_FILE || !fs.existsSync(STOP_FILE)) {
    while (inflight.length < CONCURRENCY) {
      const p = client
        .createProcessInstance({
          processDefinitionKey: ProcessDefinitionKey.assumeExists(processDefKey),
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
    if (Date.now() - lastLog > 10_000) {
      const elapsed = ((Date.now() - t0) / 1000).toFixed(0);
      const rate = (created / ((Date.now() - t0) / 1000)).toFixed(0);
      console.log(`[ts-producer] continuous: ${created} ok, ${errors} err, ${elapsed}s, ~${rate}/s`);
      lastLog = Date.now();
    }
    await new Promise((r) => setTimeout(r, 5));
  }
  await Promise.allSettled(inflight);

  const durationS = (Date.now() - t0) / 1000;
  const rate = durationS > 0 ? created / durationS : 0;
  console.log(`[ts-producer] continuous: stopped. ${created} created, ${errors} errors in ${durationS.toFixed(1)}s (~${rate.toFixed(0)}/s)`);

  // Write stats
  if (PRODUCER_STATS_FILE) {
    const stats = { created, errors, durationS, rate };
    fs.writeFileSync(PRODUCER_STATS_FILE, JSON.stringify(stats));
    console.log(`[ts-producer] continuous: stats written to ${PRODUCER_STATS_FILE}`);
  }
}

async function main() {
  if (!BPMN_PATH) {
    console.error('[ts-producer] BPMN_PATH not set');
    process.exit(1);
  }

  console.log(`[ts-producer] broker=${BROKER_REST_URL} bpmn=${BPMN_PATH} precreate=${PRECREATE_COUNT} continuous=${CONTINUOUS}`);

  const client = createCamundaClient({
    config: {
      CAMUNDA_REST_ADDRESS: BROKER_REST_URL,
      CAMUNDA_SDK_LOG_LEVEL: 'error',
      CAMUNDA_OAUTH_DISABLED: true,
    } as any,
  });

  // Deploy
  console.log('[ts-producer] Deploying process...');
  const deployment = await client.deployResourcesFromFiles([BPMN_PATH]);
  const { processDefinitionKey } = deployment.processes[0];
  console.log(`[ts-producer] Deployed: ${processDefinitionKey}`);

  // Wait for deployment propagation
  await new Promise<void>((resolve) => setTimeout(resolve, 10_000));

  // Build payload
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let payload = '';
  while (payload.length < PAYLOAD_SIZE_KB * 1024) {
    payload += alphabet[Math.floor(Math.random() * alphabet.length)];
  }

  // Phase 1: pre-create buffer
  if (PRECREATE_COUNT > 0) {
    await createBatch(client, processDefinitionKey, payload, PRECREATE_COUNT, 'pre-create');
  }

  // Signal ready (pre-creation done)
  if (READY_FILE) {
    fs.writeFileSync(READY_FILE, '1');
    console.log(`[ts-producer] Ready signal written to ${READY_FILE}`);
  }

  if (!CONTINUOUS) {
    console.log('[ts-producer] Done (no continuous mode).');
    return;
  }

  // Phase 2: wait for GO, then produce continuously
  if (GO_FILE) {
    console.log(`[ts-producer] Waiting for GO file: ${GO_FILE}`);
    while (!fs.existsSync(GO_FILE)) {
      await new Promise((r) => setTimeout(r, 100));
    }
    console.log('[ts-producer] GO received, starting continuous production...');
  }

  await continuousLoop(client, processDefinitionKey, payload);
}

main().catch((err) => {
  console.error('[ts-producer] Fatal:', err);
  process.exit(1);
});
