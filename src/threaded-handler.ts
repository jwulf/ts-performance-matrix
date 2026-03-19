/**
 * Handler module for the ThreadedJobWorker in the performance matrix.
 *
 * Runs in a worker thread. Reads configuration from environment variables
 * (inherited from the parent process). Reports completions and errors to
 * a metrics HTTP endpoint on the main thread.
 *
 * Compatible with the SDK's ThreadedJobHandler signature:
 *   (job, client) => Promise<JobActionReceipt>
 */

const HANDLER_TYPE = process.env.HANDLER_TYPE || 'cpu';
const HANDLER_LATENCY_MS = parseInt(process.env.HANDLER_LATENCY_MS || '20', 10);
const HTTP_SIM_PORT = parseInt(process.env.HTTP_SIM_PORT || '0', 10);
const METRICS_PORT = parseInt(process.env.METRICS_PORT || '0', 10);

/** Blocking CPU work — exactly what we want on a dedicated thread. */
function cpuWork(durationMs: number) {
  if (durationMs <= 0) return;
  const end = Date.now() + durationMs;
  let x = 0;
  while (Date.now() < end) {
    x += Math.sin(x + 1);
  }
}

export default async function handler(job: any, _client: any) {
  try {
    // Simulate work
    if (HANDLER_TYPE === 'cpu' && HANDLER_LATENCY_MS > 0) {
      cpuWork(HANDLER_LATENCY_MS);
    } else if (HANDLER_TYPE === 'http' && HTTP_SIM_PORT > 0) {
      await fetch(`http://127.0.0.1:${HTTP_SIM_PORT}/work`);
    }

    const receipt = await job.complete({ done: true });

    // Report success to main-thread metrics endpoint (fire-and-forget)
    if (METRICS_PORT > 0) {
      fetch(`http://127.0.0.1:${METRICS_PORT}/complete`, { method: 'POST' }).catch(() => {});
    }

    return receipt;
  } catch (err) {
    // Report error to main-thread metrics endpoint (fire-and-forget)
    if (METRICS_PORT > 0) {
      fetch(`http://127.0.0.1:${METRICS_PORT}/error`, { method: 'POST' }).catch(() => {});
    }
    throw err;
  }
}
