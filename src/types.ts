/**
 * Result types for scenario execution.
 */

export interface WorkerResult {
  workerId: string;
  processId: string;
  completed: number;
  errors: number;
  wallClockS: number;
  throughput: number;
}

export interface ProcessResult {
  processId: string;
  vmName: string;
  workersInProcess: number;
  completed: number;
  errors: number;
  throughput: number;
  perWorkerThroughputs: number[];
  perWorkerCompleted: number[];
  perWorkerErrors: number[];
}

export interface ServerMetrics {
  receivedRequests: number;
  droppedRequests: number;
  deferredAppends: number;
  jobsPushed: number;
  jobsPushFailed: number;
  recordsProcessed: number;
  backpressureLimit: number;
  backpressureInflight: number;
  jobActivationAvgMs: number | null;
  jobLifetimeAvgMs: number | null;
  piExecutionAvgMs: number | null;
}

export interface ScenarioResult {
  // Configuration
  scenarioId: string;
  totalWorkers: number;
  workersPerProcess: number;
  processes: number;
  sdkLanguage: string;
  sdkMode: string;
  handlerType: string;
  cluster: string;

  // Aggregate metrics
  totalCompleted: number;
  totalErrors: number;
  wallClockS: number;
  aggregateThroughput: number;
  jainFairness: number;

  // Per-process breakdown
  processResults: ProcessResult[];

  // Server-side metrics
  serverMetrics: ServerMetrics | null;

  // Status
  status: 'ok' | 'timeout' | 'error';
  errorMessage?: string;

  // Pre-creation stats
  preCreate: {
    created: number;
    errors: number;
    durationS: number;
  };
}

// ─── Jain's fairness index ───────────────────────────────

export function jainFairness(values: number[]): number {
  if (values.length <= 1) return 1;
  const sum = values.reduce((a, b) => a + b, 0);
  const sumSq = values.reduce((a, b) => a + b * b, 0);
  return sumSq > 0 ? (sum * sum) / (values.length * sumSq) : 1;
}
