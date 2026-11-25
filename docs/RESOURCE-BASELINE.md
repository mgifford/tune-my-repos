# Local resource baseline (2026-11-24)

This is a point-in-time local baseline, not a validated sustainability claim
and not a portfolio-wide measurement. It records what this Apple M2 MacBook Air
actually did while running the deterministic test suite and the fixture
benchmarks. Raw measurements and the full ledger remain in the gitignored
`.resource-cache/`; the sanitized aggregate is in
`reports/resources/resource-rollup.public.json` when generated locally.

## Environment

| Item | Value |
|---|---|
| Machine | Apple M2 MacBook Air, 8 CPU threads, 16 GiB RAM |
| Operating system | macOS 27.2.1 (arm64) |
| Node.js | v22.20.0 |
| Python | 3.14.5 |
| CodeCarbon | 3.3.3 |
| CodeCarbon mode | `--offline --country-iso-code CAN --region quebec --no-api --measure-power-secs 1` |
| Git revision | `d2f8eebbba9d0c13e2ccfbd4bf8a0a70f7df2758` (working tree had the resource-accounting changes) |
| CPU method | load-based estimate (no RAPL, `powermetrics` not enabled) |
| RAM method | CodeCarbon ARM model, 3.0 W |
| GPU method | unavailable (`gpu_available: false`, not a measured zero) |
| Grid intensity | 2.6 gCO2e/kWh, Quebec 2024 annual average in CodeCarbon 3.3.3 |

## Test suite

The repository test suite contained **362 tests** at the time of this
measurement (the original 260 plus resource-accounting tests). All passed. A
later dashboard regression and inventory-instrumentation tests bring the current
total to **379**, also all passing. The numbers below are from the 362-test run.

```bash
node scripts/resource-run.cjs \
  --activity=test-suite --task=maintenance-baseline \
  --verify="npm test" --codecarbon -- npm test
```

| Measurement | Value |
|---|---:|
| Tests | 362 passed |
| Inner wall clock | 7,840 ms |
| CPU-seconds (user + system) | 8.95 |
| Peak RSS | 223,444,992 bytes (213.1 MiB) |
| CodeCarbon energy estimate | 0.012111 Wh |
| CodeCarbon operational emissions | 0.00003149 gCO2e |
| Energy coverage | partial (GPU unavailable; energy modelled) |
| Wrapper + CodeCarbon wall clock | 9.14 s |
| CodeCarbon/collection overhead | ~1.3 s (wrapper wall minus inner wall) |

A controlled failing command was also recorded as a failed attempt:

```bash
node scripts/resource-run.cjs --activity=test-suite --task=failed-attempt-demo \
  --codecarbon -- node -e "process.exit(1)"
```

| Measurement | Value |
|---|---:|
| Exit status | 1 |
| Inner wall clock | 20 ms |
| Outer wall clock | 0.78 s (CodeCarbon startup included) |
| CPU-seconds | 0.01 |
| Peak RSS | 37.4 MiB |
| CodeCarbon energy estimate | 0.000020 Wh |
| Operational emissions | 0.00000005 gCO2e |
| Task state | failed |
| Coverage | partial; short-duration warning |

The failed attempt remains in the total consumption and is **not** counted in
the Wh-per-verified-task ratio, because its task was never verified.

## Instrumented inventory runs

### Unauthenticated validation smoke test

One unauthenticated dry-run was made to validate the API counters, not to
establish a portfolio baseline. It was deliberately not repeated and was not
imported into the baseline ledger.

```bash
node scripts/generate-maintenance-rollup.cjs --dry-run \
  --resource-out=maintenance-inventory.resource.jsonl
```

| Counter | Value |
|---|---:|
| Repositories discovered | 141 |
| Repositories evaluated | 7 |
| Repositories skipped | 134 |
| API requests | 62 |
| HTTP 200 | 43 |
| HTTP 304 | 0 |
| Failed responses (includes expected 404s and rate-limit 403s) | 19 |
| Rate-limited responses | 2 |
| Cache hits / misses | 0 / 7 |
| Security checks | 29 |
| Response bytes | 2,699,912 |
| Wall clock | 18.7 s |
| Scan complete | **no** |

This is exactly the incomplete case the schema must not disguise: the
unauthenticated cap and rate limiting left 134 candidate repositories
unscanned. The resource event is marked `outcome: partial`,
`github_api.complete: false` and `incomplete-inventory-scan`. The observed
`62 / 7 = 8.86` requests per evaluated repository is not a stable portfolio
metric because the scan was truncated.

### Authenticated measurement

One authenticated dry-run was then made with the repository owner's GitHub
CLI token and `LIBRARY_ADVICE_REGISTRY=off` to avoid npm registry traffic. It
was imported into the baseline ledger. It is the current API-efficiency
measurement, not a recurring benchmark.

| Counter | Value |
|---|---:|
| Repositories discovered | 141 |
| Repositories evaluated | 141 |
| Repositories skipped | 0 |
| API requests | 1,037 |
| Requests per evaluated repository | 7.35 |
| HTTP 200 | 825 |
| HTTP 304 | 0 |
| Failed responses (includes expected 404s for absent security endpoints) | 212 |
| Rate-limited responses | 0 |
| Cache hits / misses | 0 / 141 |
| Security checks | 564 |
| Response bytes | 9,743,210 |
| Wall clock | 168.9 s |
| Scan complete | **yes** |

No 304s or cache hits were observed because this was a first authenticated run
with no previous public rollup to supply ETags and carry-forward data. A later
run with that state should produce 304s for unchanged open issue/PR lists; do
not repeat the run solely to benchmark that.

## Benchmark results

All runs used the benchmark facility and committed fixtures. Cold means the
first repetition after the harness started; the OS page cache was not flushed.
No statistical significance is claimed.

### Measurement floor and collection overhead

| Workload | Reps | Median wall | Min–max | CPU-seconds (median) | Peak RSS (median) | Median collection overhead | Energy |
|---|---:|---:|---:|---:|---:|---:|---|
| `noop` | 5 | 20 ms | 20–30 ms | 0.01 | 37.6 MiB | 7.3 ms | unavailable |
| `noop` + CodeCarbon | 3 | 20 ms | 20–20 ms | 0.01 | 37.6 MiB | 665.6 ms | 0.0000608 Wh total; 0.0000199 Wh median; partial |
| `test-suite` | 3 | 7,640 ms | 7,540–7,930 ms | 8.91 | 212.1 MiB | 9.3 ms | unavailable |
| `test-suite` + CodeCarbon | 2 | 7,725 ms | 7,610–7,840 ms | 8.89 | 211.9 MiB | 779.3 ms | 0.023623 Wh total; 0.011811 Wh median; partial |

CodeCarbon adds roughly **0.67–0.78 s of average measured overhead per short
run** in this configuration. That overhead is larger than the energy being
estimated for sub-second tasks. It is recorded separately and is the reason
CodeCarbon is optional and not enabled by default.

The `test-suite` and `test-suite + CodeCarbon` medians are close (7,640 ms vs
7,725 ms). This is not evidence that CodeCarbon is free or that either is
faster; the runs were not randomized or paired and the variability is large
relative to the difference.

### Local deterministic post-processing

These workloads use committed fixtures and make no GitHub API or AI requests.

| Workload | Reps | Median wall | Min–max | CPU-seconds (median) | Peak RSS (median) | Collection overhead (median) |
|---|---:|---:|---:|---:|---:|---:|
| `policy-evaluation` | 5 | 30 ms | 30–40 ms | 0.02 | 48.5 MiB | 3.5 ms |
| `inventory-processing` | 5 | 40 ms | 30–40 ms | 0.04 | 51.1 MiB | 4.8 ms |
| `resource-aggregation` | 5 | 60 ms | 60–60 ms | 0.07 | 57.0 MiB | 6.2 ms |
| `dashboard-render` | 5 | 50 ms | 50–50 ms | 0.05 | 53.8 MiB | 4.6 ms |

A **live GitHub inventory** was deliberately not benchmarked. Repeating it
would generate unbounded API traffic and would measure the network and GitHub
as much as local processing. `WORKLOADS['inventory-live']` refuses to run.
Full maintenance-inventory generation was therefore not benchmarked; only its
local policy, redaction and validation stages were measured.

## Aggregate report

The local ledger now contains 22 events (8 benchmark summary events, 2
test-suite events, 11 monitoring events and 1 GitHub API event) across 9 task
ids. The sanitized aggregate was:

| Metric | Value | Coverage |
|---|---:|---|
| Local wall clock | 47,720 ms | — |
| Local CPU time | 53.92 CPU-seconds | — |
| Peak RSS | 212.8 MiB | — |
| Local energy | 0.035814 Wh | partial |
| Operational emissions | 0.00009312 gCO2e | partial |
| Verified tasks | 1 | — |
| Failed tasks | 1 | — |
| Wh per verified task | 0.012111 Wh | partial |
| Wh per repository evaluated | — | unavailable (API evidence exists, but no local energy measurement for inventory; requests are not converted to energy) |
| Monitoring events | 11 | — |
| Monitoring collection time | 132 ms | — |
| Collector CPU time | 0.674 CPU-seconds | — |
| Ledger size | 114,341 bytes | — |
| Raw measurement size | 59,723 bytes at this snapshot (grows with each local measurement) | — |
| GitHub API requests | 1,037 | — |
| Requests per evaluated repository | 7.35 | — |
| Repositories evaluated | 141 | — |
| Inventory scan complete | yes | — |

The per-verified-task figure uses only the resource event associated with the
verified `maintenance-baseline` task, not benchmark or failed-attempt energy.
It is labelled partial because GPU energy is unavailable and the energy is
modelled. The failed attempt remains in the absolute test-suite activity total.

## Baseline integrity note

The first test run in this environment failed because a locally generated
`maintenance-rollup.public.json` (a gitignored artifact of an earlier inventory
smoke test) existed in the working tree; `test/maintenance-auth.test.js`
correctly requires that file not to exist. It was moved outside the
repository and the suite then passed. This was an existing
local artifact, not a code failure, and no repository file was deleted.

## What this baseline does not establish

- It does not measure the whole laptop; it measures the tracked process tree.
- CPU energy is load-based; RAM energy is modelled; GPU energy is unavailable.
- It does not include embodied, construction or water impacts.
- It is one machine, one operating system and one day.
- It does not show a statistically significant difference between any two
  variants.
- GitHub API counters are included. GitHub Actions run/job metadata is not included in this local baseline; it is collected only by an opted-in Actions run.
- It does not include remote AI inference; no AI request was made.
- It is not a compliance or sustainability claim.

## Reproduction

```bash
# Full suite
npm test

# Baseline run (successful)
CODECARBON_BIN="$HOME/.venvs/codecarbon/bin/codecarbon" \
  node scripts/resource-run.cjs \
    --activity=test-suite --task=maintenance-baseline \
    --verify="npm test" --codecarbon -- npm test

# Controlled failure
CODECARBON_BIN="$HOME/.venvs/codecarbon/bin/codecarbon" \
  node scripts/resource-run.cjs \
    --activity=test-suite --task=failed-attempt-demo \
    --codecarbon -- node -e "process.exit(1)"

# Benchmarks
node scripts/resource-benchmark.cjs --workload=noop --repetitions=5
node scripts/resource-benchmark.cjs --workload=noop --repetitions=3 --codecarbon
node scripts/resource-benchmark.cjs --workload=test-suite --repetitions=3
node scripts/resource-benchmark.cjs --workload=test-suite --repetitions=2 --codecarbon
node scripts/resource-benchmark.cjs --workload=policy-evaluation --repetitions=5
node scripts/resource-benchmark.cjs --workload=inventory-processing --repetitions=5
node scripts/resource-benchmark.cjs --workload=resource-aggregation --repetitions=5
node scripts/resource-benchmark.cjs --workload=dashboard-render --repetitions=5

# Aggregate
node scripts/resource-task.cjs verify maintenance-baseline \
  --evidence-kind=artifact \
  --evidence=reports/resources/RESOURCE-SUMMARY.md
node scripts/generate-resource-rollup.cjs
```
