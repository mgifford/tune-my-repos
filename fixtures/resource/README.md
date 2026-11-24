# Synthetic resource fixtures

Every file in this directory is **fabricated test data**, not a measurement of
this machine, a repository, a provider, or a CLEER release. The values are
chosen to exercise unit conversion, missing data, provider token semantics and
privacy sanitization. They must never be presented as environmental evidence.

- `codecarbon-3.3.3-sample.csv` uses the real CodeCarbon 3.3.3 column names but
  synthetic values. Rows cover a normal run, a GPU-detected run, a measured
  zero and a row with missing energy.
- `ai-usage.synthetic.jsonl` contains provider-shaped usage records with fake
  model names, request ids and session ids.
- `cleer-factors.synthetic.json` is a per-token factor fixture. Its coefficients
  are invented for tests; the license field says so.
- `cleer-dashboard-models.synthetic.json` mimics the shape of the CLEER 1.1.0
  dashboard payload, with fake models and session figures.
- `resource-events.synthetic.jsonl` and `resource-tasks.synthetic.jsonl` are a
  small normalized ledger used by the report and dashboard tests.
- `resource-rollup.sample.json` is the sanitized rollup generated from that
  synthetic ledger.

The current public CLEER dataset does not publish per-token coefficients.
`cleer-factors.synthetic.json` exists only so the estimator interface can be
tested offline; it is not a substitute for a licensed CLEER release.
