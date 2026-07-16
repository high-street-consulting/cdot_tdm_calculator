# TDM Calculator: strategy updates

*A heads-up on changes to how strategies are defined, what's newly live, and the refreshed TAZ data.*

## The headline: you can now edit strategy math in the YAML

Until now, a strategy's VMT-reduction math lived in code (Python **and** a hand-written TypeScript copy for the app), while the YAML held only descriptions. Adding or tweaking a formula meant a developer round-trip.

That's changed. **Closed-form strategies now define their math directly in the strategy YAML**, in a `compute:` block: one formula, evaluated identically by the Python engine and the app. No code, no hand-translation.

```yaml
# traffic_calming.yaml
compute:
  pool: all
  const:
    min_effect: 0.0025   # 0.25%, CAPCOA 2010 SDT-2 low end
    max_effect: 0.0100   # 1.00%, measure max
  let:
    - coverage: "clamp(cov_raw, 0, 1)"
    - A: "clamp(min_effect + coverage * (max_effect - min_effect), 0, max_effect) * any_measure"
  formula: "-A"
```

**Of the 26 implemented strategies, 22 are now defined entirely in YAML.** You can adjust a constant, change a formula, or author a new closed-form strategy without a developer: edit the YAML, run two checks (below), commit.

**4 strategies stay in code** because their math can't be a simple formula (a dropdown that switches the formula, a lookup table, or cross-zone/spatial logic): `transit_service_expansion`, `shared_micromobility`, `lane_mile_addition`, and `park_and_ride`. Changing those still needs a developer.

## How to edit + check a `compute:` strategy

1. Edit the `compute:` block in `strategy-catalog/strategies/<id>.yaml`.
2. `python strategy-catalog/build.py`: validates the YAML and recompiles.
3. `python scripts/generate_compute_golden.py`: confirms your formula reproduces the authoritative Python engine (it prints `ok`/`FAIL` per case).

**Docs:** the full grammar (`+ - * /`, `clamp/min/max/if`, etc.), the block shape, and how per-TAZ data (mode share, AVO, parking) reaches a formula are in `strategy-catalog/README.md` → *"Computing the math"*, which links to the complete reference.

## Newly live strategies

The "must-have" strategies that were added to the catalog now actually compute in the app: **Traffic Calming, Carshare, Park-and-Ride, Pedestrian Network Improvements, Transit Shelters, and Wayfinding** (plus *Mixed-Use Development* and *Mobility Hub*, which remain `planned`).

**Rename:** *New Transit Service* → **Increased Transit Service** (now covers new routes, extensions, regional connections, **and expanded operating hours**; it points users to *Transit Service Frequency Increase* for frequency-only changes).

## ⚠️ Constants to confirm

Two strategies use **placeholder constants** pending your confirmation against the source fact sheets. Please verify before these numbers are relied on:

- **Carshare** (CAPCOA T-21): `participation_rate`, `member_vmt_reduction`.
- **Transit Shelters** (CAPCOA T-46): `shelter_ridership_uplift`, `measure_max`.

Both are clearly flagged in the YAML `compute.const` and the `notes`.

## Refreshed TAZ data

The TAZ data layer was republished with observed per-zone values from the TDM model that strategies now use where available (falling back to statewide defaults otherwise): **average vehicle occupancy (AVO), VMT split by trip purpose, model trip length, and drive-to-transit access share**. Practical effect: transit, parking, and park-and-ride estimates now reflect each zone's actual model data rather than a single statewide assumption.

---

*Questions on a specific strategy's formula or the authoring workflow? Happy to walk through it.*
