# Run Data

Committed run JSON files are served by the analysis tool.

Each file is a `ScenarioResult[]` array named `run-{timestamp}.json`.

To commit a run from the GCS cache:

```bash
cp /tmp/analysis-cache/run-XXXXX.json results/runs/
```

The analysis tool (`npm run analysis`) checks this directory first,
then `/tmp/analysis-cache/`, then GCS. People without `gsutil` access
will only see runs committed here (and any they have cached locally).
