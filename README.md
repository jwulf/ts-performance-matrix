# ts-performance-matrix

Performance envelope tool for Camunda 8 SDK worker scaling. Answers: **"For N total workers, what's the optimal split between processes and workers-per-process?"**

Tests every valid combination of (TotalWorkers, WorkersPerProcess) across SDK modes, handler types, and cluster sizes — either locally with Docker or at scale on Google Cloud.

## Matrix dimensions

| Dimension | Values |
|-----------|--------|
| Total workers (W) | 10, 20, 50 |
| Workers per process (WPP) | 1, 2, 5, 10, 25, 50 |
| SDK mode | `rest-balanced`, `grpc-poll` |
| Handler type | `cpu` (sync), `http` (200ms async) |
| Cluster | 1 broker, 3 brokers |

Only valid combinations where W is divisible by WPP are generated (14 topologies). Full matrix: **112 scenarios**.

## Quick start (local mode)

Local mode runs everything on your machine — Docker for the broker, child processes for workers.

```bash
npm install

# Preview scenarios without executing
npm run matrix:dry

# Small smoke test (4 scenarios, ~5 min)
npm run matrix:quick

# Full local run (112 scenarios, ~9 hours)
npm run matrix:local
```

Requires Docker Desktop running. Results land in `results/local/`.

## GCP mode

GCP mode runs brokers and workers on dedicated VMs for true process isolation and reproducible results.

### Architecture

```
Your machine (or coordinator VM)
  │
  │  GCE API calls
  │
  ├── Broker VM(s)         e2-standard-8, COS, runs camunda/camunda container
  │     ↕ internal network
  └── Worker VM(s)         e2-standard-2, Debian 12, runs tsx worker-process.ts
        ↕ GCS
      Results bucket        barrier protocol + result JSON files
```

Each scenario gets a clean broker restart and fresh ephemeral worker VMs. Workers coordinate via GCS (ready signals → GO flag → result upload).

### Prerequisites

1. **Google Cloud SDK** (`gcloud` and `gsutil` CLI tools)
2. **A GCP project** with billing enabled
3. **APIs enabled:**
   ```bash
   gcloud services enable compute.googleapis.com storage.googleapis.com
   ```
4. **Authentication:**
   ```bash
   gcloud auth login
   gcloud auth application-default login
   ```

### One-time GCP setup

#### 1. Create a GCS bucket for coordination

```bash
export GCP_PROJECT=your-project-id
export GCP_REGION=us-central1

gcloud storage buckets create gs://camunda-perf-matrix \
  --project=$GCP_PROJECT \
  --location=$GCP_REGION \
  --uniform-bucket-level-access
```

#### 2. Request CPU quota increase

The default Compute Engine CPU quota is 24 per region. You need more for parallel worker VMs.

| Run style | Peak vCPUs needed | Recommended quota |
|-----------|-------------------|-------------------|
| Sequential (1 lane) | ~120 | 150 |
| 4 lanes | ~480 | 500 |
| 8 lanes | ~900 | 1000 |

Request an increase at: **IAM & Admin → Quotas → Compute Engine API → CPUs (region)**

Or via CLI:
```bash
# Check current quota
gcloud compute regions describe $GCP_REGION \
  --project=$GCP_PROJECT \
  --format="table(quotas.filter(metric='CPUS').extract(limit,usage))"
```

#### 3. Firewall rules

Worker VMs need to reach broker VMs on the internal network. If using the default network, the default-allow-internal rule covers this. If using a custom VPC:

```bash
gcloud compute firewall-rules create perf-matrix-internal \
  --project=$GCP_PROJECT \
  --network=default \
  --allow=tcp:8080,tcp:26500,tcp:26501,tcp:26502,tcp:9600 \
  --source-tags=perf-worker \
  --target-tags=camunda-broker \
  --description="Allow worker VMs to reach Camunda broker ports"
```

#### 4. Service account (optional, recommended)

For least-privilege, create a dedicated service account:

```bash
gcloud iam service-accounts create perf-matrix \
  --project=$GCP_PROJECT \
  --display-name="Performance Matrix Runner"

# Grant permissions
gcloud projects add-iam-policy-binding $GCP_PROJECT \
  --member="serviceAccount:perf-matrix@${GCP_PROJECT}.iam.gserviceaccount.com" \
  --role="roles/compute.instanceAdmin.v1"

gcloud projects add-iam-policy-binding $GCP_PROJECT \
  --member="serviceAccount:perf-matrix@${GCP_PROJECT}.iam.gserviceaccount.com" \
  --role="roles/storage.objectAdmin"
```

### Running on GCP

```bash
# Full matrix (112 scenarios, sequential)
npx tsx src/run-matrix.ts \
  --project $GCP_PROJECT \
  --zone us-central1-a \
  --bucket camunda-perf-matrix

# Subset run
npx tsx src/run-matrix.ts \
  --project $GCP_PROJECT \
  --zone us-central1-a \
  --bucket camunda-perf-matrix \
  --workers 10 \
  --wpp 1,2,5,10 \
  --modes rest-balanced \
  --clusters 1broker

# Resume after interruption (skips scenarios with existing result files)
npx tsx src/run-matrix.ts \
  --project $GCP_PROJECT \
  --zone us-central1-a \
  --bucket camunda-perf-matrix \
  --resume
```

Results are written to `results/gcp/` with per-scenario JSON files and a summary report.

## CLI reference

```
npx tsx src/run-matrix.ts [options]

MODES
  --local               Run locally (Docker + child processes)
  --project <id>        Run on GCP (requires project ID)

GCP OPTIONS
  --zone <zone>         GCE zone (default: us-central1-a)
  --bucket <name>       GCS bucket for coordination (default: camunda-perf-matrix)

MATRIX FILTERS (comma-separated)
  --workers 10,20       Total worker counts (default: 10,20,50)
  --wpp 1,2,5,10        Workers per process (default: 1,2,5,10,25,50)
  --modes rest-balanced  SDK modes (default: rest-balanced,grpc-poll)
  --handlers cpu,http   Handler types (default: cpu,http)
  --clusters 1broker    Cluster configs (default: 1broker,3broker)

SCENARIO PARAMETERS
  --target 10000        Target completions per worker (default: 10000)
  --timeout 300         Scenario timeout in seconds (default: 300)
  --precreate 50000     Pre-create instance count (default: 50000)

CONTROL
  --resume              Skip scenarios with existing result files
  --dry-run             Print scenario list without executing
  --help                Show help
```

## How a scenario executes

1. **Broker restart** — clean broker(s) with H2 in-memory DB, no auth, Prometheus metrics enabled
2. **Deploy** — upload `test-job-process.bpmn` (Start → ServiceTask `test-job` → End)
3. **Pre-create** — create 50,000 process instances with 10KB payload (backpressure-managed)
4. **Spawn workers** — P processes, each running WPP workers sharing one SDK client
5. **Barrier** — all processes signal READY, coordinator sends GO simultaneously
6. **Execute** — each worker completes `target` jobs. Handler is either CPU-bound (sync return) or HTTP-simulated (200ms async delay)
7. **Collect** — per-worker throughput, completions, errors. Compute aggregate throughput, Jain's fairness index, server-side Prometheus deltas
8. **Report** — JSON result per scenario + markdown summary grouped by total workers

## Output

```
results/
  local/                        # or gcp/
    1broker-W10-P10x1-rest-balanced-cpu.json
    1broker-W10-P5x2-rest-balanced-cpu.json
    ...
    summary.json                # machine-readable summary
    REPORT.md                   # markdown tables with rankings
```

Each scenario JSON contains:
- Configuration (topology, mode, handler, cluster)
- Aggregate metrics (throughput, errors, wall clock, Jain fairness)
- Per-process breakdown (completions, throughput, per-worker arrays)
- Server-side Prometheus metrics (received/dropped requests, job activation latency, PI execution time)

## Cost estimate (GCP)

| Component | Spec | Cost/hr |
|-----------|------|---------|
| Broker VM | e2-standard-8 (8 vCPU, 32GB) | ~$0.27 |
| Worker VM | e2-standard-2 (2 vCPU, 8GB) | ~$0.07 |
| GCS | Negligible for coordination files | ~$0 |

**Sequential run** (112 scenarios × ~5 min): ~9 hours, ~$15  
Worker VMs are ephemeral (created/destroyed per scenario), so cost scales with scenario count, not with peak parallelism.

## Project structure

```
src/
  config.ts             Matrix dimensions, topology generation, defaults
  types.ts              Result types, Jain fairness index
  worker-process.ts     Runs inside each process/VM — creates WPP workers
  local-runner.ts       Local execution (Docker + child processes)
  gcp-runner.ts         GCP execution (Compute Engine VMs + GCS coordination)
  run-matrix.ts         CLI entry point, orchestration, report generation
docker/
  docker-compose.1broker.yaml   Single broker for local mode
  docker-compose.3broker.yaml   3-broker cluster for local mode
fixtures/
  test-job-process.bpmn         Start → test-job ServiceTask → End
results/                        Generated output (gitignored)
```
