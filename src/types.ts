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
  memoryUsage?: { peakRssMb: number; avgRssMb: number; samples: number };
  errorTypes?: Record<string, number>;
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

export interface ServerResourceUsage {
  samples: number;
  cpuAvg: number;            // process_cpu_usage avg per broker (0.0–1.0)
  cpuPeak: number;           // process_cpu_usage peak per broker
  systemCpuAvg: number;      // system_cpu_usage avg per broker (0.0–1.0)
  systemCpuPeak: number;     // system_cpu_usage peak per broker
  memoryUsedAvgMb: number;   // jvm_memory_used_bytes avg total across brokers (MB)
  memoryUsedPeakMb: number;  // jvm_memory_used_bytes peak total across brokers (MB)
  liveThreadsAvg: number;    // jvm_threads_live_threads avg total across brokers
  liveThreadsPeak: number;   // jvm_threads_live_threads peak total across brokers
  diskUsedAvgGb: number;     // disk used avg across brokers (GB)
  diskUsedPeakGb: number;    // disk used peak across brokers (GB)
  diskTotalGb: number;       // disk total per broker (GB, from first sample)
  diskUsedPctPeak: number;   // peak disk used percentage across brokers
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
  serverResourceUsage: ServerResourceUsage | null;

  // Status
  status: 'ok' | 'timeout' | 'error';
  errorMessage?: string;

  // Pre-creation stats
  preCreate: {
    created: number;
    errors: number;
    durationS: number;
  };

  // Continuous producer stats (null if not enabled)
  continuousProducer: {
    created: number;
    errors: number;
    durationS: number;
    rate: number;
  } | null;
}

// ─── Jain's fairness index ───────────────────────────────

export function jainFairness(values: number[]): number {
  if (values.length <= 1) return 1;
  const sum = values.reduce((a, b) => a + b, 0);
  const sumSq = values.reduce((a, b) => a + b * b, 0);
  return sumSq > 0 ? (sum * sum) / (values.length * sumSq) : 1;
}
