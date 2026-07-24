# TDM Strategy Tagging Table — Phase 1 (DECISIONS APPLIED)

**Purpose:** Final `mechanism`, `purpose_applicability`, `target_population`, `capcoa_subsector`,
`capcoa_measure`, and per-measure cap for every compiled strategy. Cross-checked to CAPCOA 2021
(CalEEMod Handbook Ch.3). This is the source of truth driving the YAML edits.

**Decisions locked (2026-07-21):**
- **Single dominant mechanism** — two-mechanism measures collapsed to their dominant factor (no splits).
- **`urban` global cap = 40%** (TDM-combined ceiling; CAPCOA Compact Infill place-type is 35%).
- **`lane_mile_addition` bypasses** the reduction engine (`excluded_from_caps: true`); added as a positive VMT delta after the cross-pool sum.
- **`employment_density` purpose = all** (job density affects non-home-based-work trips too).
- **`transit_pass_subsidy`** gets a `vmt_scope` select input (commute vs all) via `purpose_scope_input`, instead of duplicating the strategy. (Input control + wiring land with the Phase-2 engine, since scope only has meaning once pools are separated.)

**Legend** — mechanism: `TG`=trip_generation, `TL`=trip_length, `MS`=mode_shift · purpose `all`=commute+recreational+other · place types UC/U/S/Rr · cap in % VMT.

## Implemented strategies

| id | uid | capcoa_measure | mechanism | purpose_applicability | target_population | capcoa_subsector | place types | measure_cap |
|---|---|---|---|---|---|---|---|---|
| residential_density | LU-01 | T-1 | TL | all | residential | land_use | UC,U,S | **30** |
| employment_density | LU-02 | T-2 | TL | all | attraction_end | land_use | UC,U,S | — |
| transit_oriented_development | LU-03 | T-3 | MS | all | all_trips | land_use | UC,U | **31** |
| pedestrian_network_improvements | BP-08 | T-18 | MS | all | all_trips | neighborhood_design | all | — |
| separated_bike_lanes | BP-01 | T-19-A | MS | all | all_trips | neighborhood_design | all | — |
| sharrows_bike_lanes | BP-02 | T-20 | MS | all | all_trips | neighborhood_design | all | — |
| shared_micromobility | BP-03 | T-22 | MS | all | all_trips | neighborhood_design | UC,U | — |
| wayfinding | BP-04 | (derived) | MS | all | all_trips | neighborhood_design | all | — |
| traffic_calming | BP-05 | (SDT-2, legacy) | MS | all | all_trips | neighborhood_design | all | — |
| car_share_access | PK-06 | T-21 | MS | all | all_trips | neighborhood_design | UC,U | — |
| workplace_parking_pricing | PK-01 | T-12 | MS | commute | commute | parking | UC,U,S | — |
| parking_fees_curb_management | PK-02 | T-24 | MS | all | attraction_end | parking | UC,U | — |
| dynamic_parking_pricing | PK-03 | T-24 | MS | all | attraction_end | parking | UC,U | — |
| transit_service_expansion | TR-01 | T-26 | MS | all | all_trips | transit | UC,U,S | — |
| transit_pass_subsidy | TR-02 | T-29 | MS | all *(vmt_scope-gated)* | all_trips | transit | UC,U,S | — |
| park_and_ride | TR-04 | (derived) | MS | commute | commute | transit | U,S | — |
| new_transit_service | TR-06 | T-25 | MS | all | all_trips | transit | UC,U,S | — |
| transit_shelters | TR-09 | T-46 | MS | all | all_trips | transit | UC,U | — |
| end_of_trip_facilities | BP-07 | T-10 | MS | commute | commute | commute_trip_reduction | all (w/ emp) | (CTR 45) |
| telework | SP-01 | T-6 | TG | commute | commute | commute_trip_reduction | all (w/ emp) | (CTR 45) |
| commute_marketing | SP-03 | T-7 | MS | commute | commute | commute_trip_reduction | all (w/ emp) | (CTR 45) |
| commute_incentives | SP-04 | T-5 | MS | commute | commute | commute_trip_reduction | all (w/ emp) | (CTR 45) |
| tmo_coverage | SP-05 | T-5 | MS | commute | commute | commute_trip_reduction | all (w/ emp) | (CTR 45) |
| employee_commuting_benefits | SP-06 | T-9 | MS | commute | commute | commute_trip_reduction | all (w/ emp) | (CTR 45) |
| vanpool | VP-01 | T-11 | MS | commute | commute | commute_trip_reduction | all (w/ emp) | (CTR 45) |
| lane_mile_addition | ID-01 | (induced) | TG | all | all_trips | induced | all | **excluded_from_caps** |

## Planned (tagged now, wired later)

| id | uid | capcoa_measure | mechanism | purpose_applicability | target_population | capcoa_subsector | place types | measure_cap |
|---|---|---|---|---|---|---|---|---|
| mixed_use_development | LU-05 | (T-1 fam) | TL | all | all_trips | land_use | UC,U,S | — |
| mobility_hub | TR-03 | (T-25/27 fam) | MS | all | all_trips | transit | UC,U | — |
| parking_cashout | PK-05 | T-13 | MS | commute | commute | commute_trip_reduction | UC,U,S | (CTR 45) |
| unbundled_parking | PK-04 | T-16 | MS | all | residential | parking | UC,U | 15.7 ⚠ |

## Secondary calls resolved with defaults (veto any)

- **traffic_calming (SDT-2 legacy):** kept quantified (status unchanged), tagged `neighborhood_design`. No 2021 equivalent — flag if CDOT wants it moved to `not_recommended`.
- **car_share_access subsector:** `neighborhood_design` (CAPCOA T-21 location), even though it displays under the `parking` category.
- **CTR combined cap = 45%** (T-5…T-13), adopted per spec / LA calculator.
- **unbundled_parking cap 15.7%** from the T-16 fact-sheet note; confirm before it's wired (planned).

## Cap tables written to globals.yaml

| Cap tier | urban_core | urban | suburban | rural |
|---|---|---|---|---|
| Global max (all 5 subsectors) | 75 | 40 | 20 | 20 |
| Category max (4 built-env subsectors) | 70 | 35 | 15 | 15 |
| Land-use subcategory | 65 | 30 | 10 | 10 |

Per-measure: T-1 = 30, T-3 = 31, unbundled ≈ 15.7. CTR subgroup (T-5…T-13) = 45.
These **replace** the current flat `categories[].cap` (transit 15 / bikeped 8 / landuse 20 /
vanpool 6 / support 10) in the Phase-2 engine; the old caps stay in place until then so current
behavior is unchanged during Phase 1.
