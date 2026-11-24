# Resource evidence privacy review

This review covers the resource-accounting additions: the local ledger, raw
measurement files, task records, AI telemetry fixtures, sanitized rollup,
dashboard and exports.

The existing maintenance reporting security model is unchanged:

- The public Pages site still has no access control.
- Exact Dependabot alert counts remain private.
- The maintenance rollup is still written to the private data repository and
  fetched with a read-only token.
- The resource tooling does not read, publish or bypass those safeguards.

## Data inventory

| Data | Where it lives | Published? |
|---|---|---|
| Raw CodeCarbon CSV and `/usr/bin/time` output | `.resource-cache/raw/<measurement-id>/` | No. Gitignored. |
| Normalized event ledger | `.resource-cache/ledger/events.jsonl` | No. Gitignored. |
| Task ledger, labels, issue/PR refs, evidence paths | `.resource-cache/ledger/tasks.jsonl` | No. Gitignored. |
| Imported CLEER coverage/factor files | `.resource-cache/factors/` | No. Gitignored. |
| Generated resource reports | `reports/resources/` | No by default. Gitignored. |
| Committed synthetic fixtures | `fixtures/resource/` | Yes, but fabricated test data. |
| Sanitized public rollup | `reports/resources/resource-rollup.public.json` | Only if an operator explicitly publishes it; aggregate-only. |
| Static dashboard | `resources.html`, `resources.js`, `resources.css` | Public code, no data embedded. |

No resource data is sent to CodeCarbon's API, a geographic lookup, an AI
provider, or any other network service by this tooling. CodeCarbon is invoked
with `--offline --no-api`. The importer makes no network calls.

## What must never be published

The public rollup is built by allowlist projection and then scanned. The
following must not appear:

- API credentials, personal access tokens, cookies or authorization headers;
- raw prompts, responses, AI transcripts or provider request bodies;
- private repository names or visibility;
- absolute filesystem paths, home directories, usernames or hostnames;
- session identifiers or raw provider request ids;
- exact Dependabot alert counts or private maintenance findings;
- command lines or task labels that could contain any of the above;
- raw provider usage objects or verification evidence paths;
- unrestricted free-text notes from event quality records.

`policy/resource-redaction.cjs` fails closed on:

- forbidden key names (`private`, `command`, `prompt`, `session_id`, `notes`,
  `username`, `email`, `path`, `source_key`, etc.);
- path-shaped strings (`/Users/`, `/home/`, `.resource-cache`,
  `.claude/projects`, Windows drive paths, `file://`);
- secret-shaped strings (GitHub tokens, Anthropic/OpenAI-style keys, Slack
  tokens, AWS access key ids, private-key headers);
- repository-shaped strings such as `owner/repo`, except in the `model`,
  `requested_model`, `resolved_model` and `model_alias` fields, where provider
  model ids legitimately contain `/`.

The scanner is a final gate, not the primary mechanism. The primary mechanism
is the allowlist projection in `publicEvent()` and the aggregate-only rollup
builder. The scanner refuses to write a report if it finds a leak.

## Public projection details

For event-level public evidence (not currently published by the rollup):

- `project` becomes a 12-character SHA-256 reference.
- `task.id` becomes a 12-character SHA-256 reference.
- Task labels, issue/PR refs, commands, working directories, verification
  evidence and private objects are removed.
- The event id is shortened; the AI request id and session hash are removed.
- Token counts, model/provider names, energy, emissions, CPU/memory totals,
  measurement quality and hardware are retained.
- Free-text notes are dropped; only missing-field names and warning codes
  remain.

The aggregate rollup additionally contains no event rows at all: only totals,
activity labels, provider/model labels, methodology rows, quality counts and
functional units. `project_count` is a count, not a name.

Hashing a repository name is not encryption. It reduces accidental disclosure
and prevents direct listing, but a known candidate name can be tested against a
hash. For that reason the current public rollup does **not** publish per-project
hashes or per-project rows.

## AI telemetry privacy

- Provider usage tokens are recorded; prompt and response text are not.
- A session identifier is reduced to a SHA-256 hash. The raw value is not stored
  in the event at all.
- Raw provider usage objects are kept in the local `private.raw_usage` field for
  reproducibility and are never projected publicly.
- Request ids are local-only and dropped from public projections.
- Synthetic AI fixtures contain fake session ids and fake model names. They make
  no provider request.
- There is no AI integration at runtime in this phase.

## Local storage and permissions

- Directories are created with mode `0700`; files with mode `0600` where the
  platform supports it.
- Raw measurement directories are unique per measurement, preventing concurrent
  runs from overwriting one another.
- Ledger appends are serialized with a lock.
- CodeCarbon invocations are serialized with a separate lock, because
  concurrent trackers can conflict.
- Local files are never automatically uploaded, committed, or included in a
  Pages artifact.

## Publication workflow

The resource tooling does **not** add a workflow that publishes resource data.
Phase 4 may add one, but it must:

1. run `generate-resource-rollup.cjs` against a local ledger;
2. validate the rollup schema;
3. run the public scanner;
4. publish only the aggregate JSON/Markdown/CSV, never the ledger or tasks;
5. require the same review and CI gates as any other change.

The staged roll-out and review checklist are in
[RESOURCE-PUBLICATION-PLAN.md](RESOURCE-PUBLICATION-PLAN.md).

Do not commit `reports/resources/`. The directory is gitignored. The committed
sample is synthetic and lives in `fixtures/resource/`.

## Threat model

| Threat | Control |
|---|---|
| Accidental commit of a local ledger or raw CSV | `.gitignore`, separate cache directory, no report by default |
| A task label or command leaks into a public report | Allowlist projection; labels/commands are not copied; scanner |
| A private repository name leaks through a project field | Aggregate rollup has no project fields; event projection hashes; scanner |
| A token leaks through a CodeCarbon error message | Raw errors stay local; public projection drops notes/private; scanner |
| A prompt or transcript leaks | Never collected by this tooling; public projection drops AI request ids and session hashes |
| Concurrent measurements overwrite data | Unique measurement ids/raw dirs; locks |
| A tracker attributes all host energy to one repo | Process boundary recorded; overlap recorded; no whole-machine attribution |
| A synthetic fixture is mistaken for real evidence | Filenames, README, `synthetic: true` on the factor dataset, dashboard sample label |
| A partial estimate is read as a total | `mean_wh` null when partial; coverage shown next to every total |
| CLEER and EcoLogits are added | Separate rows; `total_across_datasets: null`; tests |
| The scanner is bypassed by a new field | Fail-closed scanner; tests inject paths, tokens, repo names and forbidden keys |

## Review checklist

Before publishing any resource report:

- [ ] The input is the local ledger or a committed synthetic fixture, not a
      private transcript or provider response.
- [ ] `node scripts/generate-resource-rollup.cjs` completed without a privacy
      error.
- [ ] `node scripts/validate-resource.cjs` passes on the JSON.
- [ ] The JSON contains no repository names, task labels, commands, paths,
      session ids, prompts or credentials.
- [ ] `project_count` and `task_count` are the only attribution counts.
- [ ] No exact alert count, private finding, water value or embodied-carbon
      value has been invented.
- [ ] The report states units, coverage and limitations.
- [ ] The existing private maintenance data workflow is untouched.

## Audit commands

```bash
# Generate a sample report into a temporary directory and inspect it
node scripts/generate-resource-rollup.cjs --sample --out /tmp/tmr-resource-audit --quiet
node scripts/validate-resource.cjs /tmp/tmr-resource-audit/resource-rollup.public.json

# Run the privacy tests
node --test test/resource-privacy.test.js test/resource-rollup.test.js test/resource-dashboard.test.js

# Check that raw storage is ignored
git check-ignore .resource-cache/ledger/events.jsonl reports/resources/resource-rollup.public.json
```

## Incident response

If a secret or private name is published:

1. Revoke/rotate the credential immediately.
2. Remove the published file and any artifact.
3. Inspect the local ledger and generated reports; delete the affected cache.
4. Add a regression test that reproduces the leak class.
5. Review whether the allowlist or scanner missed a field.

## Known limitations

- Hashes are pseudonymous, not anonymous.
- The scanner is regex-based; it cannot prove the absence of every possible
  sensitive string. The allowlist is the stronger control.
- Model ids are intentionally allowed to contain `/` and can resemble a
  repository name.
- A local operator can always publish the raw ledger manually. The tooling
  prevents accidental publication; it cannot prevent deliberate misuse.
- The older `maintenance-rollup.public.json` history remains public; the
  existing test continues to enforce that a current public copy is not
  committed.
