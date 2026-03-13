/**
 * Matrix Configuration — defines all dimensions and valid combinations.
 *
 * The core question: for a fixed total worker count W, what's the optimal
 * split between P processes × (W/P) workers per process?
 */

// ─── Matrix Dimensions ──────────────────────────────────

export const TOTAL_WORKERS = [10, 20, 50] as const;
export const WORKERS_PER_PROCESS = [1, 2, 5, 10, 25, 50] as const;
export const SDK_MODES = ['rest', 'grpc-streaming', 'grpc-polling'] as const;
export const SDK_LANGUAGES = ['ts', 'python', 'csharp', 'java'] as const;
export const HANDLER_TYPES = ['cpu', 'http'] as const;
export const CLUSTERS = ['1broker', '3broker'] as const;

export type SdkMode = (typeof SDK_MODES)[number];
export type SdkLanguage = (typeof SDK_LANGUAGES)[number];
export type HandlerType = (typeof HANDLER_TYPES)[number];
export type ClusterConfig = (typeof CLUSTERS)[number];

/** Valid (language, mode) combinations — not all languages support gRPC. */
export const VALID_LANG_MODES: Record<SdkLanguage, readonly SdkMode[]> = {
  ts: ['rest', 'grpc-polling'],
  python: ['rest'],
  csharp: ['rest'],
  java: ['rest', 'grpc-streaming', 'grpc-polling'],
} as const;

// ─── Topology ────────────────────────────────────────────

export interface Topology {
  totalWorkers: number;
  workersPerProcess: number;
  processes: number; // = totalWorkers / workersPerProcess
}

export interface ScenarioConfig {
  id: string;
  topology: Topology;
  sdkLanguage: SdkLanguage;
  sdkMode: SdkMode;
  handlerType: HandlerType;
  cluster: ClusterConfig;
}

// ─── Defaults ────────────────────────────────────────────

export const DEFAULT_TARGET_PER_WORKER = 10_000;
export const DEFAULT_HANDLER_LATENCY_MS = 200; // for http handler
export const DEFAULT_ACTIVATE_BATCH = 32;
export const DEFAULT_SCENARIO_TIMEOUT_S = 300;
export const DEFAULT_PAYLOAD_SIZE_KB = 10;
export const DEFAULT_PRE_CREATE_COUNT = 50_000;
export const DEFAULT_PRODUCER_CONCURRENCY = 50;

// ─── GCP Defaults ────────────────────────────────────────

export const GCP_DEFAULTS = {
  orchestratorMachineType: 'e2-standard-4',
  brokerMachineType: 'e2-standard-8',
  workerMachineType: 'e2-standard-2',
  zone: 'us-central1-a',
  network: 'default',
  subnetwork: 'default',
  imageFamily: 'debian-12',
  imageProject: 'debian-cloud',
  // Container-Optimized OS — Docker pre-installed, saves 3-5 min per broker VM
  brokerImageFamily: 'cos-stable',
  brokerImageProject: 'cos-cloud',
  gcsBucket: 'camunda-perf-matrix',
} as const;

// ─── Topology generation ─────────────────────────────────

export function getValidTopologies(): Topology[] {
  const topologies: Topology[] = [];
  for (const W of TOTAL_WORKERS) {
    for (const WPP of WORKERS_PER_PROCESS) {
      if (WPP > W) continue; // can't have more workers per process than total
      if (W % WPP !== 0) continue; // must divide evenly
      topologies.push({
        totalWorkers: W,
        workersPerProcess: WPP,
        processes: W / WPP,
      });
    }
  }
  return topologies;
}

// ─── Full matrix generation ──────────────────────────────

export function generateMatrix(opts?: {
  totalWorkers?: number[];
  workersPerProcess?: number[];
  sdkLanguages?: SdkLanguage[];
  sdkModes?: SdkMode[];
  handlerTypes?: HandlerType[];
  clusters?: ClusterConfig[];
}): ScenarioConfig[] {
  const tw = opts?.totalWorkers ?? [...TOTAL_WORKERS];
  const wpp = opts?.workersPerProcess ?? [...WORKERS_PER_PROCESS];
  const languages = opts?.sdkLanguages ?? [...SDK_LANGUAGES];
  const modes = opts?.sdkModes ?? [...SDK_MODES];
  const handlers = opts?.handlerTypes ?? [...HANDLER_TYPES];
  const clusters = opts?.clusters ?? [...CLUSTERS];

  const scenarios: ScenarioConfig[] = [];

  for (const cluster of clusters) {
    for (const W of tw.sort((a, b) => a - b)) {
      for (const WPP of wpp.sort((a, b) => a - b)) {
        if (WPP > W || W % WPP !== 0) continue;
        const P = W / WPP;
        for (const lang of languages) {
          for (const mode of modes) {
            // Skip invalid (language, mode) combinations
            if (!VALID_LANG_MODES[lang].includes(mode)) continue;
            for (const handler of handlers) {
              const id = `${cluster}-${lang}-W${W}-P${P}x${WPP}-${mode}-${handler}`;
              scenarios.push({
                id,
                topology: { totalWorkers: W, workersPerProcess: WPP, processes: P },
                sdkLanguage: lang,
                sdkMode: mode,
                handlerType: handler,
                cluster,
              });
            }
          }
        }
      }
    }
  }

  return scenarios;
}

// ─── Scenario label ──────────────────────────────────────

export function scenarioLabel(s: ScenarioConfig): string {
  return s.id;
}

export function topologyLabel(t: Topology): string {
  return `W${t.totalWorkers}-P${t.processes}x${t.workersPerProcess}`;
}
