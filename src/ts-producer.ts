/**
 * TS Producer — deploys BPMN and pre-creates process instances using the TS SDK.
 *
 * Runs on the worker-0 VM before the benchmark starts.
 *
 * Environment variables:
 *   BROKER_REST_URL   — broker REST URL (e.g., http://10.x.x.x:8080)
 *   BPMN_PATH         — path to the BPMN file to deploy
 *   PRECREATE_COUNT   — number of process instances to pre-create
 *   PAYLOAD_SIZE_KB   — variable payload size in KB (default: 10)
 */

import { createCamundaClient, ProcessDefinitionKey } from '@camunda8/orchestration-cluster-api';

const BROKER_REST_URL = process.env.BROKER_REST_URL || 'http://localhost:8080';
const BPMN_PATH = process.env.BPMN_PATH || '';
const PRECREATE_COUNT = parseInt(process.env.PRECREATE_COUNT || '0', 10);
const PAYLOAD_SIZE_KB = parseInt(process.env.PAYLOAD_SIZE_KB || '10', 10);
const CONCURRENCY = 50;

async function main() {
  if (!BPMN_PATH) {
    console.error('[ts-producer] BPMN_PATH not set');
    process.exit(1);
  }

  console.log(`[ts-producer] broker=${BROKER_REST_URL} bpmn=${BPMN_PATH} precreate=${PRECREATE_COUNT}`);

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

  if (PRECREATE_COUNT <= 0) {
    console.log('[ts-producer] No pre-creation requested, done.');
    return;
  }

  // Build payload
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let payload = '';
  while (payload.length < PAYLOAD_SIZE_KB * 1024) {
    payload += alphabet[Math.floor(Math.random() * alphabet.length)];
  }

  // Pre-create instances with concurrency control
  let created = 0;
  let errors = 0;
  const inflight: Promise<void>[] = [];
  const t0 = Date.now();
  let lastLog = Date.now();

  console.log(`[ts-producer] Creating ${PRECREATE_COUNT} process instances...`);

  while (created + errors < PRECREATE_COUNT) {
    while (inflight.length < CONCURRENCY && created + errors + inflight.length < PRECREATE_COUNT) {
      const p = client
        .createProcessInstance({
          processDefinitionKey: ProcessDefinitionKey.assumeExists(processDefinitionKey),
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
      console.log(`[ts-producer] ${created + errors}/${PRECREATE_COUNT} (${created} ok, ${errors} err) ${elapsed}s, ~${rate}/s`);
      lastLog = Date.now();
    }
    await new Promise((r) => setTimeout(r, 5));
  }
  await Promise.allSettled(inflight);

  const durationS = (Date.now() - t0) / 1000;
  console.log(`[ts-producer] Done: ${created} created, ${errors} errors in ${durationS.toFixed(1)}s`);
}

main().catch((err) => {
  console.error('[ts-producer] Fatal:', err);
  process.exit(1);
});
