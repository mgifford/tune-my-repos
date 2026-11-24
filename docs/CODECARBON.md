# CodeCarbon 3.3.3 audit and Apple Silicon limitations

This document records what CodeCarbon 3.3.3 actually wrote in the local
`emissions.csv`, which units each field uses, why the console showed such small
emissions, and what the tool does and does not measure on an Apple M2 MacBook
Air. It is an audit of a smoke test, not a validated sustainability baseline.

## Source data

The two rows below are the unmodified values from the local `emissions.csv`
produced by:

```bash
codecarbon monitor --no-api -- npm test
codecarbon monitor --no-api -- node scripts/generate-maintenance-rollup.cjs
```

| Field | Test run | Inventory run | Unit (verified) |
|---|---:|---:|---|
| `duration` | 14.766016 | 17.377665 | seconds |
| `emissions` | 5.12188244100074e-08 | 3.797415529956654e-08 | kgCO2eq |
| `emissions_rate` | 3.468696177186414e-09 | 2.1852276798807176e-09 | kgCO2eq/second |
| `cpu_power` | 5.342742947356753 | 4.18685435554665 | W |
| `gpu_power` | 0.0 | 0.0 | W (placeholder; no GPU detected) |
| `ram_power` | 3.0 | 3.0 | W |
| `cpu_energy` | 1.0314580870006308e-05 | 2.017876950153322e-06 | kWh |
| `gpu_energy` | 0.0 | 0.0 | kWh (placeholder; no GPU detected) |
| `ram_energy` | 9.384966979996535e-06 | 1.2587567395833808e-05 | kWh |
| `energy_consumed` | 1.9699547850002843e-05 | 1.4605444345987129e-05 | kWh |
| `water_consumed` | 0.0 | 0.0 | litres (WUE is 0; not modelled) |
| `country_name` | Canada | Canada | — |
| `country_iso_code` | CAN | CAN | ISO 3166-1 alpha-3 |
| `region` | quebec | quebec | — |
| `os` | macOS-27.2.1-arm64-arm-64bit-Mach-O | same | — |
| `python_version` | 3.14.5 | same | — |
| `codecarbon_version` | 3.3.3 | same | — |
| `cpu_count` | 8 | 8 | threads |
| `cpu_model` | Apple M2 | Apple M2 | — |
| `gpu_count` | 0 | 0 | devices |
| `ram_total_size` | 16.0 | 16.0 | GiB |
| `tracking_mode` | process | process | — |
| `pue` | 1.0 | 1.0 | multiplier |
| `wue` | 0.0 | 0.0 | L/kWh |
| `on_cloud` | N | N | — |
| `experiment_id` | 5b0fa12a-3dd7-45bb-9766-cc326314d9f1 | same | not unique |
| `run_id` | 51fbc18a-… | 143a362b-… | unique per run |

Other fields in the same CSV:

| Field | Observed value | Interpretation |
|---|---|---|
| `project_name` | empty | The CLI was not given `--project-name`; it is not an identifier. |
| `timestamp` | `2026-11-24T15:11:43` | Local naive time; the CSV carries no UTC offset. |
| `tracking_mode` | `process` | Process plus descendants, not whole machine. |
| `cpu_utilization_percent` | 76.09 / 63.34 | Host-wide `psutil` utilization, not the tracked process's share. |
| `gpu_utilization_percent` | 0 | No GPU device; a placeholder, not a measured utilization. |
| `ram_utilization_percent` | 83.02 / 82.27 | Host-wide memory utilization. |
| `ram_used_gb` | 4.80 / 5.03 | Host-wide memory used. |
| `cloud_provider`, `cloud_region` | empty | Not a cloud instance. |
| `on_cloud` | `N` | Local private infrastructure path. |
| `pue` | 1.0 | No data-centre overhead multiplier. |
| `wue` | 0.0 | Water model disabled; water is unavailable, not zero. |
| `longitude`, `latitude` | `-73.5887`, `45.5075` | Geographic lookup result in the original online run; empty in the offline wrapper run. |

## Normalized values

Both rows were converted only after reading the field units from the installed
CodeCarbon 3.3.3 source (`output_methods/emissions_data.py` and
`output_methods/file.py`):

```text
Wh      = kWh × 1000
gCO2e   = kgCO2eq × 1000
g/s     = kg/s × 1000
```

| Measurement | Test run | Inventory run |
|---|---:|---:|
| Duration | 14.766 s | 17.378 s |
| Energy | 0.0196995 Wh | 0.0146054 Wh |
| CPU energy | 0.0103146 Wh | 0.00201788 Wh |
| RAM energy | 0.00938497 Wh | 0.0125876 Wh |
| GPU energy | unavailable (reported 0) | unavailable (reported 0) |
| Emissions | 0.0000512188 gCO2e | 0.0000379742 gCO2e |
| Emissions rate | 0.0000034687 g/s | 0.0000021852 g/s |
| Derived intensity | 2.6 gCO2e/kWh | 2.6 gCO2e/kWh |

The component sum equals `energy_consumed` in both rows
(CPU + RAM + GPU). The derived intensity is exactly 2.6 gCO2e/kWh, the Quebec
value in CodeCarbon 3.3.3's `data/private_infra/2024/canada_emissions.json`.
That file cites Environment and Climate Change Canada, *National Inventory
Report 1990–2024 (2026)*, Annex 7 Table A7-6, 2024 electricity consumption
intensity.

## Why the console showed 0.0001 g and 0.0000 g

The `codecarbon monitor` console prints:

```python
print(f"   Emissions: {emissions * 1000:.4f} g CO2eq")
```

`emissions` is in kg, so `× 1000` correctly converts to grams, then formats to
**four decimal places**:

- 0.0000512188 g → `0.0001 g`
- 0.0000379742 g → `0.0000 g`

This is display rounding, not a unit conversion defect. The CSV retains the
full value. There is also no hidden factor of 1000 error: `emissions /
energy_consumed` gives a plausible regional intensity, and the CSV
`emissions_rate` equals `emissions / duration` in kg/s.

The small values have four legitimate contributors:

1. **Short duration.** Both runs are under 18 seconds.
2. **Small energy.** About 0.02 Wh and 0.015 Wh respectively.
3. **Low-carbon grid.** Quebec's 2.6 gCO2e/kWh annual average is about 1/150 of
   a coal-heavy grid.
4. **Modelled energy.** CPU and RAM energy are estimates on this hardware.

The console is not a precision instrument for a short workload. Read the CSV or
the normalized resource event, not the four-decimal console line.

## Units that are easy to confuse

- `cpu_power`, `gpu_power`, `ram_power` are **watts**, not watt-hours.
- `cpu_energy`, `gpu_energy`, `ram_energy`, `energy_consumed` are **kWh**, not
  Wh.
- `emissions` is **kgCO2eq**, not g.
- `emissions_rate` is **kgCO2eq/second**, not g/second. The comment in
  `output_methods/emissions_data.py` says "emissions_rate in g/s", but the code
  divides a kg value by seconds; the CSV rate is kg/s. This audit uses the
  numeric behaviour, not the misleading comment.
- `duration` is elapsed seconds, not CPU-seconds.
- `cpu_utilization_percent` is the host's system-wide `psutil` utilization, not
  the tracked process's share.
- `water_consumed` is litres derived from the configured WUE. With `wue=0`,
  0 means "not modelled", not "measured zero water".

## Do not derive energy from the power columns

For the test row, `cpu_power + ram_power = 8.34 W`; `energy_consumed /
duration` is about 4.80 W. For the inventory row, the reported power total is
7.19 W while the energy-implied average is about 3.03 W. The fields come from
different aggregation paths: energy is accumulated from interval power samples,
while `cpu_power` is a mean of per-measurement power samples. The wrapper stores
the reported power values and the reported energy separately and never
recomputes one from the other.

## Sampling and short-workload behaviour

- `codecarbon monitor` sets `measure_power_secs=10` by default (the tracker's
  own default is 15).
- `start()` takes an immediate measurement, a scheduler measures every
  `measure_power_secs`, and `stop()` measures the final interval.
- A 15–17 second run therefore has very few intervals. The final interval can
  dominate the total.
- The wrapper sets `--measure-power-secs 1` to improve resolution for short
  workloads, at some extra collection overhead. It still warns when the
  duration is less than three sampling intervals.
- CodeCarbon's `start()` and Python import happen before the wrapped command;
  its own `duration` in the CSV is close to the command duration, while the
  wrapper's wall clock includes CodeCarbon startup. The wrapper records both so
  the monitoring overhead is visible.

## Apple Silicon measurement methods actually used

The CSV does not contain a "CPU measurement backend" column. The observed
method is established from the available data and the installed source:

| Component | Observed method | Evidence |
|---|---|---|
| CPU | load-based estimate | `cpu_power` is non-zero, `tracking_mode=process`, no RAPL on macOS, `powermetrics` was not available (otherwise `codecarbon detect` would not report the load fallback). macOS has no `lscpu`, so CodeCarbon's hardware discovery falls back to the Python `cpuinfo`/`platform` path, which does report `Apple M2` and 8 threads. The TDP registry still has no Apple M2 entry, so the CPU power model uses the generic `threads × 4 W = 32 W` TDP. CodeCarbon's process CPU model is then `TDP × (process CPU time / wall time / cpu_count)`. |
| RAM | modelled estimate | CodeCarbon's ARM RAM model uses 1.5 W per estimated DIMM with a 3 W minimum. 16 GB is estimated as 2 DIMMs, so 3.0 W. |
| GPU | unavailable | `gpu_count=0`, empty `gpu_model`; CodeCarbon has no Apple GPU provider. The `0.0` power and energy values are placeholders, not measured zeros. |

The wrapper records `gpu_available: false` and `gpu_wh: null`. It never displays
the unavailable GPU as a measured zero.

### Optional powermetrics path

CodeCarbon 3.3.3 supports Apple Silicon `powermetrics` for CPU and GPU power.
It requires passwordless `sudo` for `powermetrics`; the default mode of this
repository does **not** require or request that privilege. If an operator
chooses to enable it, they must configure a narrowly scoped sudoers rule for
`powermetrics` themselves. Do not grant general passwordless sudo. Even with
powermetrics, the accounting boundary is the Apple package, not the whole
laptop, and it still does not include the display, SSD, or external devices.

Document the exact rule used if powermetrics is enabled; a future resource
event can then record `method: codecarbon-apple-powermetrics` and
`gpu_available: true`.

## Network calls and offline configuration

`--no-api` disables CodeCarbon's emissions API upload. It does **not** disable
geographic detection. In the original CSV, `longitude`/`latitude` were filled
with a Montreal coordinate, derived by:

1. `https://get.geojs.io/v1/ip/geo.json` (primary), then
2. `https://ipinfo.io/json` (fallback).

Those values are not present in the local `emissions.csv` because the file is
overwritten/appended by later runs, but the original rows in this audit include
them. Either way, the latitude/longitude fields are geographic metadata, not
measurements of the command.

The wrapper uses `--offline --country-iso-code CAN --region quebec --no-api`.
`--offline` selects `OfflineEmissionsTracker`, which does not call the
geographic endpoints. The offline run's CSV has empty `longitude`/`latitude`.
No telemetry is sent to CodeCarbon's services.

## Concurrency

CodeCarbon tracks one process tree per tracker. Concurrent trackers can
conflict or skip measurement. The wrapper:

- serializes CodeCarbon invocations with a local lock;
- gives every measurement a unique UUID and a unique raw directory;
- serializes ledger appends with a second lock;
- records overlap when another measurement was active, instead of silently
  attributing all host energy to one repository.

It does not attribute whole-machine energy to one repository. The CodeCarbon
boundary is `process-and-descendants`; a machine-level tracker would need a
different boundary and a different attribution rule.

## Docker Desktop and virtual machines

CodeCarbon running on the host does not see inside the Docker Desktop Linux VM
as a tracked process. A container run needs the tracker inside the container or
an explicit host/VM boundary. The default wrapper is for a local macOS process.
If a workload runs in Docker Desktop:

- record `boundary: container` or `virtual-machine`, not `tracked-process`;
- do not attribute the whole Docker VM to one repository;
- do not add container measurements and host measurements for the same work.

## Other measurement options investigated

- **External electricity meter**: the most defensible whole-device
  measurement, but it costs money, needs calibration, and still cannot split a
  shared laptop between concurrent repositories.
- **Green Metrics Tool**: useful for containerized workloads with a known
  boundary; adds infrastructure and is not justified for an 11-second local
  test run.
- **Firefox Energy Scanner**: browser-energy profiling, not Node.js process
  accounting; not applicable to this workload.
- **macOS `powermetrics`**: optional and privileged, as above.

None of these are enabled by default. The repository uses CodeCarbon as an
optional, labelled estimate and records the boundary and limitations.

## Reproduction

```bash
# Inspect the original CSV fields and values
head -2 emissions.csv

# Import it without altering upstream values
node scripts/import-resource-evidence.cjs \
  --codecarbon-csv emissions.csv \
  --activity=test-suite \
  --task=maintenance-baseline

# Measure a new command offline
CODECARBON_BIN="$HOME/.venvs/codecarbon/bin/codecarbon" \
  node scripts/resource-run.cjs \
    --activity=test-suite --task=maintenance-baseline \
    --codecarbon -- npm test

# Compare measurement overhead without CodeCarbon
node scripts/resource-benchmark.cjs --workload=noop --repetitions=5
node scripts/resource-benchmark.cjs --workload=noop --repetitions=3 --codecarbon
```

## Known limitations

- CPU energy is load-based, not measured.
- RAM energy is a fixed model on this machine.
- GPU telemetry is unavailable and is never reported as zero.
- Grid intensity is a 2024 annual provincial average, not a marginal or
  time-matched intensity.
- No embodied or construction emissions are included.
- CodeCarbon's CSV has no command exit status; imported CSV events are marked
  outcome/validation `unknown`.
- `experiment_id` is a constant default and is not a measurement identifier.
  Use `run_id` or the wrapper's `measurement_id`.
- The CSV `timestamp` is local naive time. The wrapper records UTC start/end
  separately.
- The 11-second test suite is too short for a stable energy comparison; use the
  benchmark facility with repetitions and report variability.
