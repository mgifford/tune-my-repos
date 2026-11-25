# Resource accounting summary

Generated: 2026-11-25T01:01:29.245Z

Events: 5. Projects: 2. Tasks: 2.

No single sustainability score is calculated. Units are Wh for energy, W for power, gCO2e for operational emissions, CPU-seconds for CPU time and bytes for memory. Missing values are “—”, not zero.

## Local computing

| Metric | Value | Coverage |
| --- | --- | --- |
| Wall clock | 9600 ms | — |
| CPU time | 9.51 CPU-seconds | — |
| Peak RSS | 212 MiB | — |
| Energy | 0.015667 Wh | partial |
| Operational emissions | 4.074e-5 gCO2e | partial |

Methods: codecarbon-process-energy-model. Boundaries: process-and-descendants.

| Activity | Events | CPU-seconds | Energy (Wh) | Coverage |
| --- | ---: | ---: | ---: | --- |
| test-suite | 1 | 9.51 | 0.015667 | partial |

## Remote AI inference

| Metric | Value |
| --- | --- |
| Requests | 0 |
| Complete estimates | 0 |
| Partial estimates | 0 |
| Unavailable estimates | 0 |
| Uncached input tokens | — |
| Cache creation tokens | — |
| Cache read tokens | — |
| Output tokens | — |
| Reasoning tokens (not added to output) | — |

## Maintenance and verification

| Metric | Value |
| --- | --- |
| Verified tasks | 0 |
| Unverified or in-progress tasks | 0 |
| Failed tasks | 0 |
| GitHub API requests | 1044 |
| Requests per evaluated repository | 7.35 |
| HTTP 304 rate | 0.0% |
| Cache hit rate | 0.0% |
| Repositories evaluated | 142 |
| Inventory scan complete | yes |
| Workflow runs | 1 |
| Workflow elapsed time | 177139 ms |
| Summed job execution time | 174452 ms |

## Measurement quality

| Quality class | Events |
| --- | ---: |
| Measured | 3 |
| Provider-reported | 1 |
| Derived | 0 |
| Estimated | 1 |
| Partial | 5 |
| Unavailable | 0 |

## Functional units

| Unit | Value | Denominator | Coverage | Note |
| --- | ---: | ---: | --- | --- |
| Wh per verified maintenance task | — | 0 | unavailable | No verified tasks in this ledger. |
| Wh per repository evaluated | — | 142 | unavailable | API evidence exists, but there is no local energy measurement for inventory activity; request counts are not converted into energy. |

Absolute totals above remain the primary record. A ratio is not shown when its denominator or measurement coverage is insufficient.

## Monitoring overhead

| Metric | Value |
| --- | --- |
| Monitoring events | 2 |
| Collection time | 0 ms |
| Collector CPU time | 0.107 CPU-seconds |
| Ledger size | 24411 bytes |
| Raw measurement size | 0 bytes |

## Limitations

- Local energy from CodeCarbon is modelled, not directly measured; on the Apple Silicon baseline CPU energy is load-based, RAM energy is modelled and GPU telemetry is unavailable.
- Remote inference energy is available only for models with a local per-token factor dataset. The current public CLEER release publishes per-session energy, not per-token coefficients, so request-level CLEER estimates are unavailable.
- CLEER and EcoLogits estimates are never added together or averaged into a new estimate.
- Operational carbon emissions use a regional annual average intensity and do not include embodied or construction emissions unless explicitly labelled.
- A partial energy estimate is not total inference or workflow energy. Coverage is shown next to every total.
- No single sustainability score is calculated, and no baseline energy is subtracted automatically.

Raw measurements and task records remain local and are not published by this report. See `docs/RESOURCE-PRIVACY.md`.
