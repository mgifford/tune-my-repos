# Resource publication plan

The resource dashboard is useful only if its data can be refreshed without
weakening the maintenance reporting security model. The plan is deliberately
staged: collect locally first, publish aggregate-only evidence second, and only
then consider a public Pages view.

## Status (2026-11-24)

- Stage 1 completed: local measurements, sanitized rollup, schema validation and
  privacy scan.
- Stage 2 completed twice:
  - first local measurement, private data commit `2f2a48d`;
  - first monthly workflow run `45511468266`, private data commit `6f94069`.
- The monthly `.github/workflows/resource-cycle.yml` run completed successfully
  in 3m 1s: 142/142 repositories evaluated, 1,044 API requests, 7.35
  requests/evaluated repository, 0 rate limits, workflow elapsed 174,947 ms,
  summed job execution 172,277 ms.
- Stage 3 is not started. The remaining decision is whether to publish an
  API/Actions-only aggregate (local CodeCarbon energy will show as unavailable)
  or add a sanitized local energy evidence file to the monthly aggregation
  first.
- No 304s/cache hits were observed because the workflow still has no previous
  rollup/ETag state in its temporary ledger. Do not repeat runs solely to
  benchmark that.

## Goals

- Show local computing, GitHub API efficiency, GitHub Actions elapsed time and
  (eventually) remote inference energy alongside the maintenance dashboard.
- Publish only sanitized aggregates that cannot identify a repository, task,
  person, command, workload or private finding.
- Keep raw measurements, task labels, evidence paths, AI prompts/transcripts and
  private repository names local.
- Keep the publication deterministic, reviewable and reversible.
- Avoid continuous monitoring overhead. Resource measurement is occasional;
  maintenance scanning remains daily.

## What is published, and what is not

| Data | Local source | Published? |
|---|---|---|
| Raw CodeCarbon CSV, `/usr/bin/time` output | `.resource-cache/raw/` | Never |
| Event ledger | `.resource-cache/ledger/events.jsonl` | Never |
| Task ledger, labels, issue/PR refs, evidence paths | `.resource-cache/ledger/tasks.jsonl` | Never |
| Inventory resource evidence (`github-api` counters, Actions metadata) | `maintenance-inventory.resource.jsonl` workflow artifact | Only through the aggregate rollup |
| Sanitized aggregate rollup | `reports/resources/resource-rollup.public.json` | Yes, after validation and scanning |
| Markdown/CSV summaries generated from the rollup | `reports/resources/` | Yes, if published |
| Static dashboard code | `resources.html` / `.js` / `.css` | Yes |

The aggregate rollup contains no `project`, `task_id`, command, path, session
id, prompt, transcript or per-repository finding. `project_count` and
`task_count` are counts only. Model/provider names and token categories are
aggregate fields; they do not identify a private repository.

## Pipeline

```text
local command / inventory generator / occasional CodeCarbon run
                         |
                         v
              local event and task records
                         |
                         v
       sanitized aggregate rollup (allowlist projection)
                         |
                         v
          schema validation + fail-closed privacy scan
                         |
             +-----------+------------+
             |                        |
             v                        v
   private data repository      public Pages view
   (first stage, review)        (later, after clean cycles)
```

### Stage 1: collect

- Local resource events come from `resource-run.cjs` and
  `import-resource-evidence.cjs`.
- Inventory API counters come from the instrumented generator with
  `--resource-out`.
- Actions metadata is opt-in (`RESOURCE_COLLECT_ACTIONS=1`) because it adds two
  API requests and is only meaningful for an occasional run.
- CodeCarbon remains optional and is never enabled in the daily inventory job.

### Stage 2: aggregate

- `generate-resource-rollup.cjs` reads the local ledger and task records.
- It validates every event/task, deduplicates, aggregates, and applies the
  public allowlist projection.
- It does not include raw event rows in the public output.

### Stage 3: validate and scan

Two independent gates must pass before any write:

1. `policy/resource-rollup.schema.json` validation.
2. `policy/resource-redaction.cjs` scan for forbidden keys, paths, credentials
   and repository-shaped strings.

A failure stops publication. There is no "publish anyway" path.

### Stage 4: publish

- **Stage 4a (recommended first):** publish the aggregate JSON/Markdown/CSV to
  the private data repository alongside the existing maintenance rollup. This
  proves the refresh path without exposing anything new.
- **Stage 4b (later):** publish the same aggregate files to GitHub Pages via a
  small pull request that passes the existing `npm test` required check. The
  resource rollup has no repository names, so it does not need the signed-in
  maintenance view. Start with the synthetic sample and one reviewed real
  report before scheduling it.

Do not publish the raw ledger or the inventory evidence file. Do not add a
second public copy of the maintenance rollup.

## Publishing the sanitized Pages aggregate

The public Pages page currently defaults to the committed synthetic sample. To
publish the real aggregate:

1. **Complete a second clean private cycle.** The monthly
   `resource-cycle.yml` workflow runs on the first of each month and publishes
   only to the private data repository.
2. **Generate the aggregate from the evidence set you intend to publish.** A
   CI-generated report contains GitHub API/Actions evidence only; local
   CodeCarbon energy is `unavailable` unless a local measurement was imported
   into the ledger before aggregation. Do not present the CI report as if it
   included laptop energy.
3. **Add the sanitized files at a tracked public path.** GitHub Pages cannot
   read the private data repository, so the aggregate must be committed to this
   public repository (for example `resource-rollup.public.json` at the root) or
   copied in by a workflow that has private-repository access and opens a PR.
4. **Switch the dashboard default.** Change `resources.html`/`resources.js`
   from the sample fixture to the tracked aggregate. Keep the sample as a
   fallback option.
5. **Open a PR with the aggregate + default change.** The PR must pass:
   - `npm test`;
   - the site check (it will fail if the default points at a missing file);
   - the resource schema validation and privacy scan;
   - human review.
6. **Merge.** Pages deploys from `main`; verify the live page and its 10 tables.
7. **Rollback** by reverting the public aggregate/default commit. The private
   ledger and report remain intact.

Never publish the raw ledger, task records, raw CSVs, exact alert counts,
repository names, prompts, transcripts or evidence paths.

## Cadence

- **Maintenance inventory:** unchanged daily schedule.
- **API counters:** collected on every inventory run at negligible cost
  (in-process counters; no extra requests).
- **Actions run/job metadata:** manual `workflow_dispatch` with
  `collect_resource_evidence: true`, monthly or quarterly. This adds two API
  requests and one small artifact.
- **CodeCarbon local measurement:** monthly or quarterly, or before/after a
  specific change. Not in the daily inventory job and not during the GitHub
  inventory benchmark.
- **Resource report refresh:** after an occasional measurement, not on every
  maintenance run.

## Review and rollback

Before publishing:

- [ ] `npm test` passes.
- [ ] The resource report validates against its schema.
- [ ] The privacy scanner reports zero problems.
- [ ] The report states units, coverage, uncertainty and limitations.
- [ ] No repository names, task labels, commands, paths, session ids, prompts,
      transcripts, credentials or exact alert counts are present.
- [ ] The diff contains only the aggregate report and, if needed, dashboard
      code — not the ledger, raw CSVs or task records.

Rollback is a normal revert of the published aggregate file/commit. The local
ledger is unaffected and can regenerate the report. If a credential or private
name is ever published, follow the incident response in
[RESOURCE-PRIVACY.md](RESOURCE-PRIVACY.md).

## Why not publish automatically now

- The resource report has only one real local baseline, not a time series.
- The current CLEER public data does not provide per-token coefficients, so
  remote AI energy is mostly unavailable.
- The inventory instrumentation is new and needs one or two reviewed runs.
- GitHub Actions and API evidence is deliberately occasional; a daily public
  series would imply continuous monitoring that is neither needed nor measured.
- The existing maintenance publication path already has a private-data
  safeguard; the resource path should prove itself against the same standard
  before becoming public.
