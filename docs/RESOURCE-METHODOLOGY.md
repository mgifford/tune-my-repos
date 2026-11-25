# Resource accounting methodology

Tune My Repos records the computational and environmental resources used to
maintain a portfolio of open-source repositories. The purpose is to understand
and progressively reduce the resources required for maintenance **without
lowering accessibility, security, governance or verification requirements**.

The monitoring, policy evaluation, aggregation and reporting infrastructure is
deterministic. No AI model classifies, aggregates, explains or renders resource
evidence. AI inference is not used merely to measure resource consumption.

## What was added

```text
local command ── resource-run.cjs ──► process event ─┐
CodeCarbon CSV ─ import-resource-evidence.cjs ──────┤
AI usage JSONL ─ import-resource-evidence.cjs ──────┼──► local JSONL ledger
task records ── resource-task.cjs ──────────────────┘         │
                                                              ▼
                                             deterministic aggregation
                                             generate-resource-rollup.cjs
                                                              │
                                      ┌───────────────────────┴──────────────────┐
                                      ▼                                          ▼
                          resource-rollup.public.json                 RESOURCE-SUMMARY.md
                          resource-summary.csv                        resources.html (static)
```

The evidence model and terminology are aligned with Drupal Core Lab's resource
accounting (`project`, `task`, `activity`, `tool`, `environment`, `outcome`,
`validation`, `source`, `measurements`, `quality`). Tune My Repos adds energy,
emissions, measurement, benchmark, GitHub API and AI blocks. The export bridge
in `scripts/lib/resource/event.cjs` produces a DCL-shaped event and stores the
TMR-only energy evidence in DCL's `private` object, so no data is lost. See
[DRUPAL-CORE-LAB-ALIGNMENT.md](DRUPAL-CORE-LAB-ALIGNMENT.md).

## Units and nulls

| Quantity | Normalized unit | Source unit is preserved? |
|---|---|---|
| Energy | Wh | Yes, in `energy.source_values` (e.g. kWh) |
| Power | W | Yes, in `energy.source_values` |
| Operational emissions | gCO2e | Yes, in `emissions.source_values` (e.g. kg) |
| CPU time | CPU-seconds | Yes, from `/usr/bin/time` user + system |
| Elapsed time | milliseconds | Yes, outer and inner wall clock |
| Memory | bytes | Yes, peak RSS |
| Network transfer | bytes | Not measured locally |
| Financial cost | USD, currency identified | Provider-reported vs estimated is separate |
| AI consumption | provider-defined token categories | Raw provider fields are retained |

Rules:

- Missing values are `null`, never `0`.
- A measured zero stays `0`.
- A zero that means "hardware not detected" (GPU) becomes `null` with
  `gpu_available: false`.
- Unit conversion happens only after the source unit is established from the
  tool's field contract.
- A source value and its normalized value are both stored.

## Accounting boundaries

The schema's `energy.boundary` enum distinguishes:

- `tracked-process`
- `process-and-descendants`
- `cpu-package`
- `cpu-and-gpu`
- `whole-system`
- `virtual-machine`
- `container`
- `external-infrastructure`
- `accelerator-inference`
- `unavailable`

CodeCarbon's local boundary is `process-and-descendants`. CLEER's per-token
boundary is `accelerator-inference`; the CLEER dashboard's session energy
includes accelerator, host, idle and cooling, so the imported session-only
dataset uses `facility`. These are never summed as if they were the same
boundary.

No whole-machine energy is attributed to one repository when several
repositories are active. Local energy from CodeCarbon is not added to remote
inference energy.

## Task attribution and verification

Stable task ids identify maintenance activities, for example:

```text
repository-inventory
incremental-inventory
dependency-classification
security-alert-review
dependabot-repair
documentation-maintenance
accessibility-regression
repository-configuration
ai-assisted-investigation
test-suite
benchmark
```

A task record contains the project, revision, issue/PR, activity, expected
deliverable, start/completion, verification state, associated resource event
ids, verification evidence and attempt counts. States are:

```text
planned, in_progress, completed_verified, completed_unverified,
failed, abandoned, blocked, unknown
```

A successful command is not a successful maintenance outcome. Only
`resource-task.cjs verify` marks `completed_verified`. Failed attempts and
retries remain part of the resources consumed. A later measurement attached to a
verified task does not silently unverify it, but it does add an attempt.

## Measurement quality

Every event has a `source.confidence`:

```text
measured, provider-reported, derived, estimated, unavailable
```

and a `quality.completeness`:

```text
complete, partial, estimated, unavailable
```

CodeCarbon energy is `estimated` even when `/usr/bin/time` CPU and RSS are
measured. CLEER/EcoLogits energy is `estimated`. Provider token counts are
`provider-reported`. A request-level estimate with missing token categories is
`partial`, and its `mean_wh` is `null`; only `estimated_wh` is populated, with a
note that it is not total inference energy.

## Functional units

The rollup reports absolute totals and, where defensible, ratios such as:

- Wh per verified maintenance task;
- Wh per repository evaluated.

A ratio is withheld (`value_wh: null`) when the denominator is zero or the
measurement coverage is unavailable. A ratio with partial coverage is labelled
`partial`, not presented as a complete measurement. Failed and abandoned work
stays in the totals. Fundamentally different maintenance tasks are not compared
as if they had equal complexity.

No single sustainability score is calculated. There is no weighted sum of
energy, carbon, water, cost and tokens.

## Uncertainty

- CodeCarbon energy uncertainty is not published in its CSV. It is a model
  output, not a measurement with an error bar.
- CLEER per-request estimates preserve published means and standard deviations.
  The range is `mean ± 1.96 × SD` when an SD is available, labelled
  `mean-plus-minus-1.96-sd`, not a confidence interval.
- Same-model coefficients are treated as fully correlated when requests are
  aggregated; adding requests does not divide the systematic uncertainty by
  `sqrt(n)`.
- Different models are combined in quadrature.
- CLEER and EcoLogits estimates are never added or averaged.

## Carbon accounting

Operational emissions are:

```text
gCO2e = energy_kWh × carbon_intensity_gCO2e_per_kWh
```

The local CodeCarbon event records:

- carbon-intensity source (`CodeCarbon 3.3.3 regional annual average`);
- country and region;
- the applicable dataset year (2024 Quebec value in the installed data);
- the methodology (`energy × regional intensity`);
- the energy boundary (`operational-electricity`);
- uncertainty/coverage (`partial`: annual average, no marginal or time matching).

The laptop's electricity mix is not assumed to represent a remote AI provider.
Data-centre overhead is not applied twice. Accelerator, facility and lifecycle
emissions remain distinguishable; CodeCarbon's local result includes no
embodied or construction emissions, and the rollup says so.

No water-consumption or embodied-carbon values are invented. CodeCarbon's
`water_consumed=0` with `wue=0` is treated as unavailable, not measured zero.

## Benchmark method

`scripts/resource-benchmark.cjs` supports 1–20 repetitions and a separate
baseline workload. It records:

- repetitions, hardware, OS, Node.js, CodeCarbon version and Git revision;
- workload parameters and sampling interval;
- wall clock, CPU-seconds, peak RSS;
- energy and emissions where available;
- measurement coverage and monitoring overhead;
- median, minimum, maximum, sample standard deviation and interquartile range;
- cold first run vs warm later runs.

Cold means "first repetition after this harness started"; the OS page cache is
not flushed. Idle/baseline energy is reported separately and never subtracted
automatically. A reduction is not claimed as statistically significant without
a paired design and uncertainty analysis.

Live GitHub inventory is deliberately **not** benchmarked. The inventory
workloads use committed fixtures so repeated measurement does not generate
unbounded API traffic. `WORKLOADS['inventory-live']` refuses to run.

## GitHub API and Actions

The event schema has `measurements.github_api` counters (requests, 200/304,
failures, rate limits, cache hits/misses, repositories discovered/evaluated/
skipped/carried forward, security checks, response bytes, freshness, scan
completeness) and `measurements.github` workflow/job metadata. The inventory
generator now emits these counters when run with `--resource-out`; the
workflow uploads the file only for an opted-in measurement run. Run/job API
collection is opt-in (`RESOURCE_COLLECT_ACTIONS=1`) because it adds two
requests and is only meaningful occasionally. API request counts are never
converted to energy with an arbitrary factor. Workflow elapsed time is not CPU
time or electricity.

## Measurement cadence

- **Every inventory run:** in-process GitHub API counters. These add no API
  requests.
- **Monthly:** `.github/workflows/resource-cycle.yml` runs on the first of the
  month, collects API/Actions evidence and publishes the sanitized aggregate
  privately. It does not use CodeCarbon.
- **Monthly or quarterly (local):** optional CodeCarbon measurement on this
  machine, imported manually before aggregation.
- **Before or after a specific change:** an optional CodeCarbon run is fine
  when a comparison is actually needed.
- **Never:** CodeCarbon in the daily inventory job, or inside the GitHub
  inventory benchmark. The inventory benchmark measures API requests and
  Actions elapsed time, not laptop energy, and adding CodeCarbon there would
  measure the wrong boundary and add substantial overhead.
- **Not continuous:** resource reports are refreshed after an occasional
  measurement, not on every maintenance scan.

## Monthly local energy evidence

The monthly workflow combines two evidence sources:

- GitHub API/Actions evidence generated in the workflow;
- one or more sanitized local `process` events exported from the local ledger.

Prepare the local evidence monthly:

```bash
CODECARBON_BIN="$HOME/.venvs/codecarbon/bin/codecarbon" \
  node scripts/resource-run.cjs \
    --activity=test-suite --task=monthly-local-baseline \
    --codecarbon -- npm test
node scripts/export-local-resource-evidence.cjs \
  --out=local-resource-evidence.jsonl --activity=test-suite --latest=1
```

Commit that file to the **private** data repository. The exporter replaces the
project/task identity with a generic one, removes the private object, command,
paths and task labels, and keeps only energy/CPU/memory evidence. The monthly
workflow imports it with `--max-age-days=45`, so a stale local measurement
fails the cycle instead of silently presenting old energy as current.

## GitHub API and Actions counters

The inventory generator records what it actually requested:

```text
requests, status_200, status_304, failed, rate_limited,
cache_hits, cache_misses, repositories_discovered,
repositories_evaluated, repositories_skipped, carried_forward,
security_checks, response_bytes, freshness, complete
```

- A 304 is a cache hit only for the conditional open-issue/PR probe.
- `complete` is false when the per-run repository cap is reached, a candidate
  is not evaluated, or a rate-limit response occurred. An incomplete scan is
  never reported as a completed portfolio inventory.
- `security_checks` counts the repository metadata, Dependabot alert, branch
  protection and ruleset reads that the existing policy requires.
- API request counts are not converted into energy or carbon.

Write the local evidence file:

```bash
node scripts/generate-maintenance-rollup.cjs \
  --resource-out=maintenance-inventory.resource.jsonl
node scripts/import-resource-evidence.cjs \
  --events=maintenance-inventory.resource.jsonl
```

In the workflow, the same flag is passed on every run. The file is uploaded as
a private artifact only when a manual dispatch sets
`collect_resource_evidence: true`; that opt-in is intended for monthly or
quarterly measurement, not daily operation.

Actions metadata is recorded from environment variables on every run. The
run/jobs API is queried only when `RESOURCE_COLLECT_ACTIONS=1`; it adds two
requests and records workflow elapsed time separately from summed job execution
time. For a run that is still in progress, those durations are lower bounds.
Billable minutes, artifact retention and cache bytes are not exposed by this
API surface and stay `null`.

## Repository layout

```text
policy/resource-evidence.schema.json   event schema, version 1.0.0
policy/resource-task.schema.json       task record schema, version 1.0.0
policy/resource-factor.schema.json     local AI factor dataset schema
policy/resource-rollup.schema.json     public aggregate schema
policy/resource-redaction.cjs          fail-closed public-data scanner
policy/resource-view.cjs               accessible dashboard renderer

scripts/resource-run.cjs               optional CodeCarbon command wrapper
scripts/resource-task.cjs              task start/update/verify/list
scripts/resource-benchmark.cjs         controlled benchmark facility
scripts/import-resource-evidence.cjs    CodeCarbon CSV, AI usage, CLEER coverage
scripts/generate-resource-rollup.cjs    sanitized JSON/Markdown/CSV reports
scripts/validate-resource.cjs           schema validator CLI

scripts/lib/resource/                   units, measurement, events, ledger,
                                        tasks, factors, AI, rollup, benchmark
fixtures/resource/                      synthetic fixtures and sample rollup
docs/                                   methodology, CodeCarbon, AI, privacy
resources.html / .js / .css             static public dashboard
```

## Reproduction

```bash
# 1. Baseline tests
npm test

# 2. Measure the test suite locally, optionally with CodeCarbon
node scripts/resource-run.cjs --activity=test-suite --task=maintenance-baseline -- npm test
CODECARBON_BIN="$HOME/.venvs/codecarbon/bin/codecarbon" \
  node scripts/resource-run.cjs --activity=test-suite --task=maintenance-baseline \
    --codecarbon -- npm test

# 3. Benchmark without and with CodeCarbon
node scripts/resource-benchmark.cjs --workload=test-suite --repetitions=3
node scripts/resource-benchmark.cjs --workload=noop --repetitions=5 --codecarbon

# 4. Generate sanitized reports
node scripts/generate-resource-rollup.cjs

# 5. Validate every fixture/schema
node scripts/validate-resource.cjs \
  fixtures/resource/resource-events.synthetic.jsonl \
  fixtures/resource/resource-tasks.synthetic.jsonl \
  fixtures/resource/resource-rollup.sample.json \
  fixtures/resource/cleer-factors.synthetic.json
```

Raw measurements, ledgers and generated reports are gitignored. See
[RESOURCE-PRIVACY.md](RESOURCE-PRIVACY.md).

## Known limitations

- The local baseline is one Apple M2 machine; it is not a portfolio-wide
  baseline.
- CodeCarbon CPU energy is load-based; RAM energy is modelled; GPU telemetry is
  unavailable.
- An 11-second test suite is too short for stable energy comparison.
- CLEER's public release does not publish per-token coefficients.
- Provider token categories differ; rollup token totals are not directly
  comparable across providers without reading the provider breakdown.
- GitHub API and Actions instrumentation is designed but not yet implemented.
- The dashboard publishes aggregate evidence, not per-repository findings.
- No statistical significance or compliance claim is made.
