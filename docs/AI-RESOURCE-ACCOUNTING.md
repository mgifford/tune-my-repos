# AI resource accounting and CLEER handoff

This document covers the provider-neutral AI request telemetry and the
per-token energy estimator interface added in Phases 1–2. **No AI is invoked by
this repository's resource tooling.** The fixtures are synthetic, and the
current public CLEER release does not publish the per-token coefficients the
estimator needs, so request-level CLEER energy is deliberately reported as
unavailable rather than fabricated.

## Two separate boundaries

```text
Local orchestration and command execution
  /usr/bin/time + optional CodeCarbon
  boundary: process-and-descendants

Remote AI inference
  provider-reported tokens + CLEER/EcoLogits factor dataset
  boundary: accelerator-inference (or explicitly labelled facility/lifecycle)

GitHub Actions
  workflow/job metadata
  no CPU-time or electricity inference

GitHub API and hosted services
  request counts and cache outcomes
  no arbitrary conversion to energy
```

CodeCarbon does not measure a provider's accelerators. CLEER does not measure
the laptop, browser, Docker VM, or local scripts. The rollup keeps these
components separate and never adds them into a single energy number.

## Provider-neutral token categories

The event schema preserves six mutually meaningful categories:

| Field | Meaning |
|---|---|
| `input_total` | The provider's input-side total, after applying that provider's documented inclusion rules. |
| `uncached_input` | Newly processed input tokens, where the provider reports them. |
| `cache_creation` | Input tokens written to a prompt cache, where reported. |
| `cache_read` | Input tokens read from a prompt cache, where reported. |
| `output` | Generated output tokens, after applying the provider's inclusion rules. |
| `reasoning` | Reasoning/thinking tokens, kept separately even when included in output. |

`reasoning_included_in_output` records whether adding `reasoning` to `output`
would double count. `token_basis` is `provider-reported`, `estimated` or
`unavailable`. `provider_fields` preserves the raw provider usage object so a
later normalization change does not destroy the source.

### Anthropic Messages

Documented semantics used by the adapter:

- `input_tokens` counts tokens neither read from nor used to create a cache.
- `cache_creation_input_tokens` and `cache_read_input_tokens` are separate and
  additive.
- `output_tokens` includes extended-thinking tokens; Anthropic does not report
  thinking as a separate count.

Normalization:

```text
input_total   = input_tokens + cache_creation_input_tokens + cache_read_input_tokens
uncached_input = input_tokens
cache_creation = cache_creation_input_tokens
cache_read     = cache_read_input_tokens
output         = output_tokens
reasoning      = null
```

If the cache fields are absent while `input_tokens` is present, the adapter
treats the absent cache counts as zero and records
`anthropic-absent-cache-creation-treated-as-zero` /
`anthropic-absent-cache-read-treated-as-zero` in the event notes. This is a
provider-format assumption, not a token estimate.

### OpenAI Chat Completions

Documented semantics used by the adapter:

- `prompt_tokens` is the input total.
- `prompt_tokens_details.cached_tokens` is a subset of `prompt_tokens`.
- `completion_tokens` is the output total.
- `completion_tokens_details.reasoning_tokens` is a subset of
  `completion_tokens`.
- Cache creation is not reported by this usage object.

Normalization:

```text
input_total   = prompt_tokens
cache_read    = prompt_tokens_details.cached_tokens (absent -> 0, with a note)
uncached_input = prompt_tokens - cache_read
cache_creation = null
output        = completion_tokens
reasoning     = completion_tokens_details.reasoning_tokens
reasoning_included_in_output = true when reasoning is reported
```

Reasoning tokens are **not** added to output. A cached-token count larger than
`prompt_tokens` invalidates `uncached_input` rather than producing a negative
number.

### Generic clients

Only canonical fields supplied directly by the client are accepted. No category
is inferred from text length, `bytes / 4`, billing cost, or another provider's
formula. A record without usage stays `unavailable`.

## Model matching

The factor dataset is matched explicitly. The states are:

| State | Meaning |
|---|---|
| `exact` | The provider's resolved model id equals a dataset id. |
| `documented_alias` | A dataset alias matches, with a documented source. |
| `explicit_proxy` | The dataset itself declares this model a proxy for the requested model. |
| `ambiguous` | More than one documented match exists. No model is selected. |
| `unsupported` | The dataset has no factor for the model. |
| `unknown` | The provider did not return a model id. |

There is no silent substitution of a cheaper, older, or similarly named model.
An unsupported model preserves all raw usage, reports energy `unavailable`,
names the missing factor, and can be recalculated later when a dataset covers
it. Case or separator differences are treated as `ambiguous`, not as an excuse
to guess.

## Current CLEER release: what is actually published

Checked on 2026-11-24:

- Repository: <https://github.com/sustainableaigroup/CLEER>
- Dashboard data schema version: **1.1.0** (`data/v1/`)
- Methodology engine: **CLEER-Text-0926**
- Model coverage: **51 models** (35 closed, 16 open), 6 chat/agentic workloads.
- Data licence: **CC BY-NC 4.0** (`data/LICENSE`); software is Apache-2.0.
  Commercial use of the data requires separate written permission from
  Sustainable AI Group.
- The data schema explicitly says: **"Per-token energy intensities are not
  published."** It publishes per-session `energy_wh.mean/sd` and
  `carbon_gco2e.mean/sd`, plus component breakdowns and model mapping metadata.
- The token counts behind each session workload are also not published.
- The technical report (Section 7) describes producing energy per uncached
  input, cached input, and output token as a mean and standard deviation, with
  cache creation not separately reported. The public dashboard dataset does not
  expose those per-token values.

Consequences:

1. A request-level estimate cannot be computed from the public CLEER dashboard
   data. Dividing session energy by an assumed token count would invent the
   denominator and is prohibited.
2. The repository imports CLEER dashboard data as a **session-only** coverage
   dataset. It records model names, providers, mapping confidence, proxies,
   session energy and uncertainty, but every model is marked `unsupported` for
   per-token estimation.
3. Actual CLEER coefficients are **not bundled** in this repository. The
   licence is non-commercial and per-token factors are not in the public data
   release.
4. The SOMA AI Emission Factors (SAEF) dataset on Zenodo is a different
   methodology and a different project. It is not a CLEER release and is not
   used here. Do not conflate the two.

### What the importer does

```bash
node scripts/import-resource-evidence.cjs \
  --cleer-models=/path/to/CLEER/data/v1/models.json \
  --cleer-meta=/path/to/CLEER/data/v1/meta.json \
  --factors-out=.resource-cache/factors/cleer-dashboard-1.1.0.json
```

It writes a local `session-only` factor file with:

- dataset name, version, methodology version and boundary (`facility`);
- source checksum (SHA-256 of the CLEER `models.json`);
- licence and source URL;
- per-model confidence, proxies and per-session energy/carbon where present;
- an explicit note that per-token estimation is unavailable.

## Local factor dataset contract

Per-token datasets are local, versioned JSON validated by
`policy/resource-factor.schema.json`:

```json
{
  "schema_version": "1.0.0",
  "dataset_kind": "per-token",
  "dataset": "cleer",
  "dataset_version": "1.0.0",
  "methodology_version": "CLEER-Text-0926",
  "boundary": "accelerator-inference",
  "license": "…",
  "synthetic": false,
  "units": {
    "uncached_input": "Wh/token",
    "cached_input": "Wh/token",
    "cache_creation": "Wh/token",
    "output": "Wh/token"
  },
  "checksum": "sha256:…",
  "models": [
    {
      "id": "provider-model-id",
      "mapping": "exact",
      "confidence": 0.9,
      "aliases": [{ "id": "alias-id", "source": "documentation URL" }],
      "uncached_input": { "mean": 0.0000003, "sd": 0.00000006, "unit": "Wh/token", "basis": "estimated" },
      "cached_input":   { "mean": 0.0000001, "sd": 0.00000002, "unit": "Wh/token", "basis": "estimated" },
      "cache_creation": { "mean": null, "sd": null, "unit": "Wh/token", "basis": "unavailable" },
      "output":         { "mean": 0.0000012, "sd": 0.00000024, "unit": "Wh/token", "basis": "estimated" }
    }
  ]
}
```

Rules enforced by the loader:

- schema validation;
- checksum verification when `checksum` is present;
- per-token datasets require at least uncached-input and output means;
- units may be `Wh/token`, `J/token`, `kJ/token`, `MJ/token`, `kWh/token` or
  `MWh/token`, converted to Wh/token only after the unit is read;
- a synthetic dataset can be refused unless the caller explicitly allows it;
- the dataset version, checksum, licence and methodology are copied into every
  estimate.

The fixture `fixtures/resource/cleer-factors.synthetic.json` is fabricated test
data. It is not a CLEER release.

## Estimation

For a matched model:

```text
estimated_wh =
    uncached_input_tokens × uncached_input_wh_per_token
  + cache_read_tokens     × cached_input_wh_per_token
  + cache_creation_tokens × cache_creation_wh_per_token
  + output_tokens         × output_wh_per_token
```

`cache_creation` is the difficult category. The CLEER report does not publish a
separate cache-creation coefficient (cached input uses a price-ratio proxy).
The estimator's default policy is `unavailable`:

- a non-zero cache-creation token count with no coefficient is listed in
  `unestimated_categories`;
- the estimate becomes `partial`;
- `mean_wh` is `null` because the total inference energy is unknown;
- `estimated_wh` is the sum of only the estimated portions, explicitly labelled
  partial;
- cache creation is never reclassified as cache reads.

An optional `sensitivity_as_uncached_input` policy computes a separate
`sensitivity.cache_creation_wh` using the uncached-input coefficient and marks
`included_in_mean: false`. It is a labelled sensitivity scenario, not the
estimate.

### Uncertainty

When the dataset supplies per-token standard deviations:

```text
sd_component = tokens × sd_per_token
sd_total     = sqrt(sum(sd_component²))
lower        = max(0, mean - 1.96 × sd_total)
upper        = mean + 1.96 × sd_total
```

`interval_method` is `mean-plus-minus-1.96-sd`. This is a normal-approximation
range derived from the published SD, **not a confidence interval** and not a
guarantee. If any required SD is missing, the range is `null`.

### Aggregation

`aggregateInferenceEstimates()` groups by source, dataset version, methodology
and boundary.

- Same model: coefficients are treated as fully correlated, so the SD adds
  rather than shrinking with the number of requests. Thousands of requests do
  not eliminate systematic uncertainty in the model-level coefficient.
- Different models: uncertainty is combined in quadrature.
- CLEER and EcoLogits rows remain separate. There is no total across datasets.
- Partial estimates are counted and their estimated portion is reported
  separately; they are not added to the complete total.
- `total_across_datasets` is always `null`.

These are explicit assumptions, not a claim that the true correlation is known.

## EcoLogits adapter

`estimateWithAdapter('ecologits', …)` exists as an interface and currently
returns `unavailable` with a note that no local EcoLogits factor dataset is
implemented. It never adds its output to a CLEER estimate and never chooses the
lower of the two. A future adapter must preserve its own methodology,
boundary, dataset version and uncertainty.

## AI request telemetry fields

Each `ai-request` event records, where available:

- request id, provider, client, requested/resolved model, resolved model version, alias;
- task, repository, issue/PR, activity;
- start/end/duration, streaming mode;
- reasoning configuration (enabled, effort, budget), without inventing it;
- input total, uncached input, cache creation, cache read, output, reasoning,
  whether reasoning is included in output, token basis;
- tool invocations, tool-result bytes, retries, outcome;
- cost with source/confidence and currency;
- time to first token, output tokens per second, context utilization, modality,
  API region, service tier, batch status, cache lifetime, routing, where
  exposed;
- energy estimate with boundary, dataset, coverage, uncertainty and
  unsupported categories;
- quality completeness and missing fields;
- a local-only session hash, raw provider usage and provider-semantics version
  in `private`.

Unavailable fields stay `null`. Provider token definitions are preserved in
`tokens.provider_fields` and `private.raw_usage`.

## Synthetic fixtures

- `fixtures/resource/ai-usage.synthetic.jsonl` — Anthropic, OpenAI, missing
  cache details, and unsupported-model records.
- `fixtures/resource/cleer-factors.synthetic.json` — per-token factor shape and
  uncertainty, fabricated.
- `fixtures/resource/cleer-dashboard-models.synthetic.json` — mimics the CLEER
  1.1.0 dashboard shape and session-only limitation.
- `fixtures/resource/resource-events.synthetic.jsonl` — normalized events,
  including unsupported models and a monitoring event.

No live AI request is made to test any of this.

## Phase 3 handoff

Before request-level CLEER estimates can be published:

1. Obtain a licensed, machine-readable CLEER per-token factor release (or
   written permission for the needed non-commercial use).
2. Confirm the coefficient units and the boundary (accelerator only, versus
   accelerator + host + idle + cooling).
3. Add a model-id alias map backed by provider documentation; do not map
   display names by similarity.
4. Decide and document cache-creation handling. Do not silently map it to cache
   reads.
5. Record the dataset checksum and methodology version; keep historical token
   counts separate from new coefficients.
6. Re-run the estimator tests, including partial estimates, ambiguity,
   unsupported models, uncertainty and boundary separation.
7. Add an EcoLogits adapter only if a second methodology is actually needed;
   keep the two rows separate.

## Reproduction

```bash
# Synthetic telemetry and estimator tests
node --test test/resource-ai.test.js test/resource-factors.test.js

# Import synthetic AI usage with explicit permission for synthetic factors
node scripts/import-resource-evidence.cjs \
  --ai-usage=fixtures/resource/ai-usage.synthetic.jsonl \
  --factors=fixtures/resource/cleer-factors.synthetic.json \
  --allow-synthetic --task=ai-fixture

# Import the real CLEER dashboard coverage (no per-token estimate)
node scripts/import-resource-evidence.cjs \
  --cleer-models=/path/to/CLEER/data/v1/models.json \
  --cleer-meta=/path/to/CLEER/data/v1/meta.json
```

## Known blockers

- No machine-readable public CLEER per-token coefficient release was found at the checked release.
- CLEER data is CC BY-NC 4.0; redistribution/commercial use needs permission.
- CLEER publishes display names, not provider API model ids; an alias map is
  required.
- Cache-creation energy is not separately published.
- The CLEER session workloads use unpublished token counts, so session energy
  cannot be decomposed into request energy.
- No provider has been called, and no actual AI usage telemetry exists yet.
