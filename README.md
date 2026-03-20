# ts-performance-matrix

Performance envelope tool for Camunda 8 SDK worker scaling. Answers: **"For N total workers, what's the optimal split between processes and workers-per-process?"**

**[View the hosted analysis dashboard →](https://jwulf.github.io/ts-performance-matrix)**

Tests every valid combination of (TotalWorkers, WorkersPerProcess) across SDK languages, SDK modes, handler types, and cluster sizes — either locally with Docker or at scale on Google Cloud.

## Matrix dimensions

| Dimension | Values |
|-----------|--------|
| SDK language | `ts`, `python`, `csharp`, `java` |
| Total workers (W) | 10, 20, 50, 100 |
| Workers per process (WPP) | 1, 2, 5, 10, 25, 50 |
| SDK mode | `rest`, `rest-threaded`, `grpc-streaming`, `grpc-polling` |
| Handler type | `cpu` (20ms busy-loop), `http` (HTTP call with 20ms handler latency) |
| Cluster | 1 broker, 3 brokers |

**SDK modes:**
- `rest` — async HTTP polling (default for all languages)
- `rest-threaded` — CPU handler work offloaded to `worker_threads` (TS) or thread pool (Python), keeping the event loop/async runtime free for polling
- `grpc-streaming` — gRPC streaming activation (TS, Java)
- `grpc-polling` — gRPC long-polling activation (TS, Java)

Not all languages support all modes:

| Language | Modes |
|----------|-------|
| TypeScript | `rest`, `rest-threaded`, `grpc-streaming`, `grpc-polling` |
| Python | `rest`, `rest-threaded` |
| C# | `rest` |
| Java | `rest`, `grpc-streaming`, `grpc-polling` |

Only valid combinations where W is divisible by WPP are generated (20 topologies × 10 language-mode combos × 2 handlers × 2 clusters). Full matrix: **800 scenarios**.

## Prerequisites

### All modes

- **Node.js 22+** and **npm** — required for the matrix orchestrator and TypeScript worker
- **Docker Desktop** (local mode only) — runs the Camunda broker(s)

### Polyglot workers (install the toolchains for languages you want to test)

| Language | Toolchain | Version |
|----------|-----------|---------|
| TypeScript | Node.js + npm | 22+ (installed above) |
| Python | Python + [uv](https://docs.astral.sh/uv/) | Python 3.10+, uv latest |
| C# | [.NET SDK](https://dotnet.microsoft.com/download) | 8.0+ |
| Java | JDK + [Maven](https://maven.apache.org/) | JDK 21+, Maven 3.8+ |

## Installing dependencies

```bash
# TypeScript (orchestrator + TS worker) — always required
npm install

# Python worker
uv sync

# C# worker (builds a self-contained binary)
dotnet publish src/workers/csharp-worker/CsharpWorker.csproj \
  -c Release -r linux-x64 --self-contained

# Java worker (builds an uber-jar)
mvn -f src/workers/java-worker/pom.xml clean package -q
```

You only need to build the workers for languages you plan to test. The `--languages` CLI flag (see below) controls which languages are included in a run.

## Quick start (local mode)

Local mode runs everything on your machine — Docker for the broker, child processes for workers.

```bash
npm install

# Preview scenarios without executing
npm run matrix:dry

# Small smoke test (~4 scenarios, ~5 min)
npm run matrix:quick

# Full local run (~800 scenarios)
npm run matrix:local
```

Requires Docker Desktop running. Results land in `results/local/`.

> **Note:** Local mode currently runs only TypeScript workers. GCP mode supports all four languages.

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
  └── Worker VM(s)         e2-standard-2, Debian 12, runs language-specific worker
        ↕ GCS
      Results bucket        barrier protocol + result JSON files
```

Each scenario gets a clean broker restart and fresh ephemeral worker VMs. Workers coordinate via GCS (ready signals → GO flag → result upload). All four language runtimes are installed on GCP worker VMs from their respective package managers (npm, pip, dotnet, JDK).

### GCP prerequisites

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
# Full matrix (~800 scenarios, sequential)
node --import tsx/esm src/run-matrix.ts \
  --project $GCP_PROJECT \
  --zone us-central1-a \
  --bucket camunda-perf-matrix

# Parallel execution with 4 lanes (~4x faster, needs ~500 vCPU quota)
node --import tsx/esm src/run-matrix.ts \
  --project $GCP_PROJECT \
  --zone us-central1-a \
  --bucket camunda-perf-matrix \
  --lanes 4

# Subset run (TypeScript only, REST mode)
node --import tsx/esm src/run-matrix.ts \
  --project $GCP_PROJECT \
  --zone us-central1-a \
  --bucket camunda-perf-matrix \
  --languages ts \
  --workers 10 \
  --wpp 1,2,5,10 \
  --modes rest \
  --clusters 1broker

# Resume after interruption (skips scenarios with existing result files)
node --import tsx/esm src/run-matrix.ts \
  --project $GCP_PROJECT \
  --zone us-central1-a \
  --bucket camunda-perf-matrix \
  --resume
```

> **Important:** Use `node --import tsx/esm` instead of `npx tsx`. The `tsx` wrapper spawns a child process that swallows SIGINT/SIGTERM, preventing the Ctrl-C cleanup handler from running. With `node --import tsx/esm`, signals are delivered directly to the Node.js process, allowing it to cleanly delete all provisioned VMs before exiting.

Results are written to `results/gcp/` with per-scenario JSON files and a summary report.

### Running from a GCP control plane VM

Instead of running from your laptop, you can run the orchestrator from a GCP VM. This avoids sleep/disconnect issues and keeps the control plane in the same network as workers.

#### 1. Create the control plane VM

```bash
gcloud compute instances create perf-matrix-control \
  --project $GCP_PROJECT \
  --zone us-central1-a \
  --machine-type e2-standard-4 \
  --image-family ubuntu-2510-amd64 \
  --image-project ubuntu-os-cloud \
  --boot-disk-size 50GB \
  --scopes cloud-platform
```

The `--scopes cloud-platform` grants the VM's default service account permission to create/delete worker VMs and read/write GCS. If you prefer least-privilege, use the dedicated service account from step 4 above:

```bash
gcloud compute instances create perf-matrix-control \
  --project $GCP_PROJECT \
  --zone us-central1-a \
  --machine-type e2-standard-4 \
  --image-family ubuntu-2510-amd64 \
  --image-project ubuntu-os-cloud \
  --boot-disk-size 50GB \
  --service-account perf-matrix@${GCP_PROJECT}.iam.gserviceaccount.com \
  --scopes cloud-platform
```

#### 2. Install dependencies on the VM

```bash
gcloud compute ssh perf-matrix-control --zone us-central1-a

git clone <repo-url> && cd ts-performance-matrix
sudo bash scripts/setup-control-plane.sh
```

This installs Node.js 22, Python 3 + uv, .NET SDK 8.0, and JDK 21.

#### 3. Install and run

```bash
npm install

node --import tsx/esm src/run-matrix.ts \
  --project $GCP_PROJECT \
  --workers 10 --wpp 1 --handlers cpu \
  --clusters 1broker --precreate 1000
```

> **Tip:** Since the control plane is Linux, the TS worker package tarball will contain linux-native binaries — no platform fix-up needed on workers.

#### Networking

If the control plane VM is in a non-default VPC, pass `--network` and `--subnetwork` so worker VMs are created in the same network:

```bash
node --import tsx/esm src/run-matrix.ts \
  --project $GCP_PROJECT \
  --network my-vpc --subnetwork my-subnet \
  --workers 10 --wpp 1 --handlers cpu --clusters 1broker
```

## CLI reference

```
node --import tsx/esm src/run-matrix.ts [options]

MODES
  --local               Run locally (Docker + child processes)
  --project <id>        Run on GCP (requires project ID)

GCP OPTIONS
  --zone <zone>         GCE zone (default: us-central1-a)
  --bucket <name>       GCS bucket for coordination (default: camunda-perf-matrix)
  --network <name>      VPC network for VMs (default: GCP project default)
  --subnetwork <name>   Subnetwork for VMs (default: GCP project default)

MATRIX FILTERS (comma-separated)
  --languages ts,python SDK languages (default: ts,python,csharp,java)
  --workers 10,20       Total worker counts (default: 10,20,50)
  --wpp 1,2,5,10        Workers per process (default: 1,2,5,10,25,50)
  --modes rest           SDK modes (default: rest,rest-threaded,grpc-streaming,grpc-polling)
  --handlers cpu,http   Handler types (default: cpu,http)
  --clusters 1broker    Cluster configs (default: 1broker,3broker)

SCENARIO PARAMETERS
  --target 10000        Target completions per worker (default: 10000)
  --timeout 300         Scenario timeout in seconds (default: 300)
  --precreate 100000    Pre-create instance count (default: 100000)

CONTROL
  --lanes <n>           Parallel lanes, GCP only (default: 1)
  --resume              Skip scenarios with existing result files
  --dry-run             Print scenario list without executing
  --help                Show help
```

## How a scenario executes

1. **Broker restart** — clean broker(s) with H2 in-memory DB, no auth, Prometheus metrics enabled
2. **Deploy** — upload `test-job-process.bpmn` (Start → ServiceTask `test-job` → End)
3. **Pre-create** — create 100,000 process instances with 10KB payload as an initial buffer
4. **Spawn workers** — P processes, each running WPP workers sharing one SDK client
5. **Barrier** — all processes signal READY, coordinator sends GO simultaneously
6. **Continuous producer** — alongside the workers, a continuous producer keeps creating new process instances (concurrency 50) to prevent job starvation at high worker counts. Stops when the workers finish. Stats (created, errors, rate) are collected separately.
7. **Execute** — each worker completes `target` jobs. Handler is either CPU-bound (20ms sleep) or HTTP-bound (call to an HTTP server that has a 20ms delay). Server resource usage (CPU, memory, threads) is sampled via Prometheus gauges every 30s during execution.
8. **Collect** — per-worker throughput, completions, errors. Compute aggregate throughput, Jain's fairness index, server-side Prometheus deltas, server resource usage (avg/peak), and continuous producer stats.
9. **Report** — JSON result per scenario + markdown summary grouped by total workers

## Output

```
results/
  local/                        # or gcp/
    1broker-ts-W10-P10x1-rest-cpu.json
    1broker-python-W10-P5x2-rest-cpu.json
    ...
    summary.json                # machine-readable summary
    REPORT.md                   # markdown tables with rankings
```

Each scenario JSON contains:
- Configuration (topology, mode, handler, cluster)
- Aggregate metrics (throughput, errors, wall clock, Jain fairness)
- Per-process breakdown (completions, throughput, per-worker arrays)
- Server-side Prometheus metrics (received/dropped requests, job activation latency, PI execution time)
- Server resource usage — JVM gauge sampling (CPU avg/peak, memory avg/peak MB, live threads avg/peak)
- Continuous producer stats (created count, errors, duration, creation rate)

## Cost estimate (GCP)

| Component | Spec | Cost/hr |
|-----------|------|---------|
| Orchestrator VM | e2-standard-4 (4 vCPU, 16GB) | ~$0.13 |
| Broker VM | e2-standard-8 (8 vCPU, 32GB) | ~$0.27 |
| Worker VM | e2-standard-2 (2 vCPU, 8GB) | ~$0.07 |
| GCS | Negligible for coordination files | ~$0 |

Each scenario takes ~45 min end-to-end (VM provisioning, pre-create 150K instances, benchmark, teardown). Observed throughput is ~1.3 scenarios/lane/hour.

**8 lanes** (~800 scenarios): ~75 hours wall-clock, ~$1,000
Worker VMs are ephemeral (created/destroyed per scenario). The dominant cost is worker VMs — high-process-count scenarios (W=100, WPP=1 → 100 VMs) are disproportionately expensive.

## Project structure

```
src/
  config.ts             Matrix dimensions, topology generation, defaults
  types.ts              Result types, Jain fairness index
  run-matrix.ts         CLI entry point, orchestration, report generation
  local-runner.ts       Local execution (Docker + child processes)
  gcp-runner.ts         GCP execution (Compute Engine VMs + GCS coordination)
  worker-process.ts     TypeScript worker — runs inside each process/VM
  http-sim-server.ts    Shared Node.js HTTP sim server for http handler workloads
  ts-producer.ts        TypeScript producer — deploys BPMN + pre-creates instances
  aggregator.py         Python aggregator for collecting results
  analysis/
    server.ts           Local analysis server (fetches from GCS, caches in /tmp)
    data-loader.ts      Data fetching and caching logic
    backfill-memory.ts  Backfill memory stats into cached run data
    backfill-errors.ts  Backfill error categories into cached run data
    public/             Static frontend (served locally or via GitHub Pages)
      app.js            Client-side analysis UI (filtering, sorting, tables)
      data-adapter.js   Adapter for local server vs GitHub Pages data fetching
      index.html        Dashboard HTML
      style.css         Dashboard styles
  workers/
    python-worker.py            Python worker (camunda-orchestration-sdk)
    python-producer.py          Python producer — deploys + pre-creates via SDK
    csharp-worker/
      CsharpWorker.csproj       C# project (Camunda.Orchestration.Sdk)
      Program.cs                C# worker + producer (--produce flag)
    java-worker/
      pom.xml                   Maven project (camunda-client-java)
      mvnw                      Maven wrapper (JDK 21 required)
      src/main/java/Worker.java Java worker + producer (--produce flag)
scripts/
  setup-control-plane.sh        Installs all toolchains on a GCP control plane VM
  build-run-index.ts            Regenerates results/runs/index.json from committed run files
docker/
  docker-compose.1broker.yaml   Single broker for local mode
  docker-compose.3broker.yaml   3-broker cluster for local mode
fixtures/
  test-job-process.bpmn         Start → test-job ServiceTask → End
pyproject.toml                  Python dependencies (managed by uv)
results/
  gcp/                          Raw GCP scenario results (gitignored)
  runs/                         Committed run data for the hosted dashboard
    index.json                  Run index (consumed by GitHub Pages adapter)
    run-*.json                  Aggregated scenario data per run
    run-*.meta.json             Run metadata (optional)
```

## Analysis dashboard

The analysis dashboard visualises run data with filtering, sorting, grouping, and A/B comparison across any matrix dimensions.

### Hosted version (GitHub Pages)

The dashboard is published at **https://jwulf.github.io/ts-performance-matrix** and reads committed run data from `results/runs/` in the repo.

### Local server

The local server can fetch run data directly from GCS (cached in `/tmp/analysis-cache/`), giving access to runs that haven't been committed yet:

```bash
npx tsx src/analysis/server.ts
```

Open http://localhost:3000. The local server supports live GCS fetching, SSE progress streaming, and backfill operations.

### Publishing run data for the hosted version

The hosted dashboard reads from `results/runs/` in the repo. To publish a run:

```bash
# 1. Copy cached run data into the repo
cp /tmp/analysis-cache/run-TIMESTAMP.json results/runs/
cp /tmp/analysis-cache/run-TIMESTAMP.meta.json results/runs/  # if exists

# 2. Regenerate the index
npx tsx scripts/build-run-index.ts

# 3. Commit and push
git add results/runs/
git commit -m "chore: add run data for run-TIMESTAMP"
git push
```

A CI workflow (`update-run-index.yml`) also auto-regenerates the index when run files are pushed.

## SDK packages

| Language | Package | Registry |
|----------|---------|----------|
| TypeScript | `@camunda8/orchestration-cluster-api` | npm |
| TypeScript (gRPC) | `@camunda8/sdk` | npm |
| Python | `camunda-orchestration-sdk` | PyPI |
| C# | `Camunda.Orchestration.Sdk` | NuGet |
| Java | `io.camunda:camunda-client-java` | Maven Central |
