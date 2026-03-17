# Matrix Run Analysis Tool

Our matrix runs produce a lot of data, and we need to mine this data for meaningful insights.

## Requirements

We want a web interface (lightweight web server + frontend) that:

- Scans a results directory for matrix run results subdirectories
- Lets the user select a run from a dropdown
- Once in a run, the user can select checkboxes from all dimensions (SDKs, modes, scenarios, etc.) and get filtered tables. "Select All / Select None" buttons. Dimensions are constrained to values present in the dataset. Defaults to everything selected.
- Supports comparison tables: a second view where every dimension has a multi-select dropdown, plus ordering and grouping controls
- Metric columns are also selectable via checkboxes (server Prometheus metrics avg/max, client error count/distribution, throughput, client memory avg/max, etc.)
- Output format tabs: rendered HTML table, Markdown, and fixed-width codeblock for Slack

## Architecture

```
src/analysis/
├── server.ts          — HTTP server (Node stdlib http module)
├── data-loader.ts     — Fetch/cache scenario-summary.json from GCS or local
├── public/
│   ├── index.html     — SPA shell
│   ├── app.js         — Client-side logic (vanilla JS)
│   └── style.css      — Styling
```

**Zero new dependencies** — Node `http` + `child_process` for gsutil. Vanilla HTML/JS/CSS frontend.

## Data Flow

1. Server starts → serves static files + JSON API
2. `GET /api/runs` → shells out `gsutil ls gs://camunda-perf-matrix/` → parses run IDs (deduplicates across lanes)
3. `GET /api/runs/:runId` → for each lane, lists `scenarios/*/results/scenario-summary.json`, downloads them in parallel, returns merged `ScenarioResult[]`
4. Client does all filtering, grouping, sorting, and rendering in-browser (dataset is small — <200 scenarios per run)

## Backend

| File | Responsibility |
|---|---|
| `server.ts` | HTTP server on port 4000. Routes: `/api/runs`, `/api/runs/:runId`, static files from `public/` |
| `data-loader.ts` | `listRuns()` — parse GCS bucket listing into run metadata. `loadRun(runId)` — download all scenario-summary.json, cache in `/tmp/analysis-cache/`. Returns `ScenarioResult[]` |

## Frontend

### Explorer Tab (default)
- **Dimension filter panel** (left sidebar): Checkbox group per dimension with Select All / Select None:
  - Cluster: `1broker`, `3broker`
  - Language: `ts`, `python`, `csharp`, `java`
  - Mode: `rest`, `rest-threaded`, `grpc-streaming`, `grpc-polling`
  - Handler: `cpu`, `http`
  - Total Workers: `10`, `20`, `50`, `100`
  - Workers/Process: `1`, `2`, `5`, `10`, `25`, `50`
- **Metric column toggles** (above table): Checkboxes for visible columns
- **Data table**: Filtered results, each row = one scenario
- Defaults: everything selected

### Comparison Tab
- **Dimension dropdowns** (multi-select): one per dimension
- **Grouping**: dropdown to select primary grouping dimension
- **Ordering**: dropdown to sort by any metric column (asc/desc)
- **Metric columns**: same checkbox group as Explorer
- **Data table**: comparison grid

### Output Format Tabs
Below the table, three tabs:
- **HTML** (default) — rendered table
- **Markdown** — pipe-delimited table in copyable textarea
- **Slack** — fixed-width monospace block with padded columns

## Available Metrics

From `ScenarioResult` (scenario-summary.json):

| Metric | Source Field |
|---|---|
| Throughput (ops/s) | `aggregateThroughput` |
| Total Completed | `totalCompleted` |
| Total Errors | `totalErrors` |
| Wall Clock (s) | `wallClockS` |
| Jain Fairness | `jainFairness` |
| Server CPU Avg | `serverResourceUsage.cpuAvg` |
| Server CPU Peak | `serverResourceUsage.cpuPeak` |
| Server Mem Avg (MB) | `serverResourceUsage.memoryUsedAvgMb` |
| Server Mem Peak (MB) | `serverResourceUsage.memoryUsedPeakMb` |
| Server Threads Avg | `serverResourceUsage.liveThreadsAvg` |
| Server Threads Peak | `serverResourceUsage.liveThreadsPeak` |
| Client Mem Avg (MB) | Aggregated from `processResults[*]` per-process files |
| Client Mem Peak (MB) | Aggregated from `processResults[*]` per-process files |
| Error Rate (%) | Computed: `errors / (completed + errors) * 100` |
| Pre-create Count | `preCreate.created` |
| Status | `status` |

## Implementation Steps

1. `data-loader.ts` — GCS integration + `/tmp` caching
2. `server.ts` — HTTP server, API routes, static file serving
3. `public/style.css` — Layout and table styling
4. `public/index.html` — HTML shell
5. `public/app.js` — Run loading, filtering, rendering, format export
6. `package.json` script — `"analysis": "node --import tsx/esm src/analysis/server.ts"`