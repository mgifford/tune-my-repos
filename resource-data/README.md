# Published resource data

This directory contains the **sanitized, aggregate-only** resource report
published by the monthly [resource cycle](../.github/workflows/resource-cycle.yml).

- `resource-rollup.public.json` — machine-readable aggregate
- `RESOURCE-SUMMARY.md` — human-readable summary
- `resource-summary.csv` — flat summary

The report contains no repository names, task labels, commands, filesystem
paths, session ids, prompts, transcripts, credentials, exact alert counts or
private maintenance findings. Raw measurements, the event ledger and task
records stay local or in the private data repository.

The monthly workflow combines:

- GitHub API and GitHub Actions evidence from the inventory run;
- sanitized local CodeCarbon energy evidence exported from the local ledger.

Local energy is modelled on this machine (CPU load-based, RAM modelled, GPU
unavailable) and is marked `partial`. API request counts are not converted into
energy. See [RESOURCE-METHODOLOGY.md](../docs/RESOURCE-METHODOLOGY.md),
[CODECARBON.md](../docs/CODECARBON.md) and
[RESOURCE-PUBLICATION-PLAN.md](../docs/RESOURCE-PUBLICATION-PLAN.md).

Do not edit these files by hand. They are refreshed by the monthly workflow and
published through a reviewed pull request.
