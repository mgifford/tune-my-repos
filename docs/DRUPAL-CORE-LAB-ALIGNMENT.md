# Drupal Core Lab resource-schema alignment

Tune My Repos reuses the **data structures and terminology** of Drupal Core
Lab's resource accounting without copying that project's collectors or
dashboard. The local Drupal Core Lab checkout inspected for this work was at
commit `7b396b4` ("Start Chrome for FunctionalJavascript test runs"),
specifically:

```text
tools/resource/events.schema.json
tools/resource/events.mjs
tools/resource/ledger.mjs
tools/resource/aggregate.mjs
tools/resource/adapters/
tools/resource/public.mjs
scripts/resource.mjs
scripts/resource-task.mjs
scripts/session-usage.mjs
docs/RESOURCE-MONITORING.md
docs/RESOURCE-PRIVACY.md
```

Drupal Core Lab's schema is version `1.0.0`, JSON Schema 2020-12. Its core event
shape is:

```text
schema_version, event_id, event_type, recorded_at, occurred_at, duration_ms,
project, issue, variant, task, activity, tool, model, provider, environment,
outcome, validation, commit, patch, source, measurements, quality,
source_key, supersedes, revision, private
```

## What is reused

| DCL field | TMR use |
|---|---|
| `schema_version` | Same `1.0.0` versioning pattern. |
| `event_id` | Deterministic SHA-256 over the measured content, not the import time. |
| `event_type` | Same values, plus `github-api` for API counters. |
| `recorded_at` / `occurred_at` | Same UTC ISO-8601 semantics. |
| `project` | Repository (`owner/name`) or `local/<name>`; never an absolute path. |
| `issue` / `variant` | Same optional attribution. |
| `task` | Same `id`, `label`, `execution_id`, `kind`, `state`, `expected_deliverable`, `verified`. |
| `activity` | DCL categories retained; TMR adds repository-maintenance categories. |
| `tool` / `model` / `provider` | Same. |
| `environment` | Same `os`, `node`, `runner`, `ddev`, `docker`, plus hardware extensions. |
| `outcome` / `validation` | Same. |
| `commit` / `patch` | Same. |
| `source` | Same `adapter`, `method`, `confidence`, `reference`, with the same confidence enum. |
| `measurements` | Same token, cost, tool, context, latency, CPU, memory, I/O, network and GitHub blocks. |
| `quality` | Same completeness / missing / notes, plus warning codes. |
| `private` | Same local-only convention. |
| `source_key` / `supersedes` / `revision` | Same mutable-snapshot supersession pattern. |

## What Tune My Repos adds

DCL deliberately does not convert tokens or CPU-seconds into energy, and its
schema has no energy block. Tune My Repos adds:

- `measurements.energy`: boundary, method, measured/estimated/mean values,
  standard deviation, range, interval method, coverage, components, preserved
  source values, hardware, dataset identity, category coverage, correlation
  assumption and notes.
- `measurements.emissions`: operational boundary, gCO2e, intensity, source,
  region, methodology, coverage and components.
- `measurements.measurement`: unique measurement id, tool/version, exit status,
  wall-clock layers, overhead, sampling interval, lock wait, overlap, cache
  state and repetitions.
- `measurements.benchmark`: workload, repetition, cache state, baseline,
  per-run rows and statistics.
- `measurements.github_api`: API/cache/304/repository counters.
- `ai`: request-level provider telemetry (request id, requested/resolved model,
  streaming, reasoning config, retries, tools, TTFT, throughput, modality,
  region, tier, batch, cache lifetime, routing).
- Top-level `measurement_id`.
- Task states `completed_unverified`, `failed`, `abandoned` and a separate
  task-record schema with verification evidence and attempt counts.

## Export bridge

`toDrupalCoreLabEvent(event)` in `scripts/lib/resource/event.cjs`:

1. maps TMR-only activities to the nearest DCL activity
   (`repository-inventory` → `infrastructure`, `test-suite` → `validation`,
   `dependabot-repair` → `patch-development`, etc.);
2. maps `completed_unverified` → `completed_claimed`;
3. removes TMR-only `measurements` blocks so the event matches DCL's stricter
   `additionalProperties: false` shape;
4. retains the energy, emissions, measurement, AI and GitHub API evidence in
   `private.tmr_resource`, which DCL's schema allows and its public allowlist
   never exports.

This is deliberately lossless on the local side and lossy only where DCL has no
field for the value. It is not a claim that every TMR event validates against
DCL's schema without the export step; the export is the compatibility boundary.

## Minimum common evidence format

The interoperable subset both projects can produce is:

```text
project, revision/commit, task id/kind/state, activity, tool,
environment, measurement period, source method/confidence,
CPU-seconds, memory, energy with boundary and uncertainty,
operational emissions with intensity source, AI token categories,
cost with currency, verification state, completeness, methodology version,
dataset version and checksum
```

Tune My Repos' public rollup is aggregate-only. It carries a hashed
`project_ref` in per-event projections, not repository names. A future
cross-project import should accept the DCL event shape and map its
`measurements` tokens/CPU/GitHub data into a TMR evidence event, while leaving
DCL's lack of energy as `unavailable` rather than inferring it.

## Differences caused by workload

| Concern | Drupal Core Lab | Tune My Repos |
|---|---|---|
| Primary unit of work | Drupal issue/patch/accessibility evaluation | Repository maintenance inventory, dependency classification, tests |
| Local environment | DDEV/Docker/PHP/Composer | Node.js, macOS Apple Silicon, optional CodeCarbon |
| Energy | Not estimated | CodeCarbon estimate where available, explicitly modelled |
| AI | Claude Code session/request transcripts | Provider-neutral request records, synthetic fixtures, no live AI yet |
| GitHub Actions | Workflow/job duration | Same, plus intended API/cache counters |
| Public output | Sanitized resource dashboard | Aggregate-only resource rollup and static dashboard |
| Verification | `completed_verified` with evidence | Same, plus failed/abandoned/in-progress states |

## Versioning

- Both projects use schema version `1.0.0`.
- TMR's additions are additive within `1.0.0` only while the schema remains
  backward compatible; a breaking change requires a new version and a
  migration note.
- Factor datasets carry their own `schema_version`, dataset version,
  methodology version and checksum.
- Historical token counts are never rewritten when coefficients change. Energy
  estimates are recalculated as a new estimate with the dataset identity
  preserved.
