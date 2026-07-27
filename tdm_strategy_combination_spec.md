# CDOT TDM Calculator — Strategy Combination Logic

**Purpose:** Engineering spec for how the calculator combines TDM strategy VMT reductions, what caps apply, and which strategies cannot be stacked. Implements CAPCOA combination rules adapted for a TAZ-based baseline VMT model.

**Anchor reference:** CAPCOA *Handbook for Analyzing Greenhouse Gas Emission Reductions, Assessing Climate Vulnerabilities, and Advancing Health and Equity* (2021, with 2024 update). Section references below point to the CAPCOA transportation chapter combination guidance (Handbook p. 38 combination rules; per-measure fact sheets cited inline).

---

## 1. Core data model

Every strategy in the calculator must carry four tags. These tags drive all combination logic.

| Tag | Values | Purpose |
|---|---|---|
| `mechanism` | `trip_generation`, `trip_length`, `mode_shift` | Which VMT factor the strategy acts on. Drives cross-mechanism math. |
| `category` | `land_use`, `neighborhood_design`, `parking`, `transit`, `commute_trip_reduction` (CTR) | CAPCOA subsector. Drives category caps and exclusivity. |
| `place_type` eligibility | `urban_core`, `urban`, `suburban`, `rural` (defined by TAZ density) | Gates the strategy by the TAZ's context. See Section 3.0 for the CAPCOA crosswalk. |
| `purpose_applicability` | subset of `{commute, recreational, other}` | **Which VMT purpose pools the strategy acts on.** Drives the purpose-segmented architecture (Section 1.5). |
| `target_population` | `commute`, `all_trips`, `residential`, `attraction_end`, etc. | Drives overlap detection within a pool. |

### Why mechanism matters

Baseline VMT decomposes as:

```
VMT = (number of trips) × (avg trip length) × (auto mode share)
```

- `trip_generation` → reduces **number of trips**
- `trip_length` → reduces **average trip length**
- `mode_shift` → reduces **auto mode share**

Because each mechanism acts on a *different multiplicative factor*, combining across mechanisms multiplicatively is mechanistically correct, not just a convenience.

### 1.5 Purpose-segmented architecture (the top-level structure)

The calculator's baseline VMT is split by trip purpose: **commute**, **recreational**, and **other**. These are **disjoint pools** — a commute mile and a recreational mile are different miles. This drives the highest-level combination rule:

- **WITHIN a purpose pool → multiplicative.** Two strategies that both act on commute VMT can double-count each other, so they combine multiplicatively and are subject to caps (run the full Section 2 engine inside the pool).
- **ACROSS purpose pools → additive.** Reductions come from non-overlapping pools of VMT, so summing the VMT saved in each pool is correct. No double-counting risk exists because no mile belongs to two purposes.

```
Total VMT saved = (commute VMT × R_commute)
                + (recreational VMT × R_recreational)
                + (other VMT × R_other)
```

where each `R_pool` is the result of running the complete within-then-across-mechanism engine **independently inside that pool**, using only the strategies whose `purpose_applicability` includes that pool.

**Why this also fixes the scaling problem.** When a strategy is defined as "8% of commute VMT," you apply that 8% directly to the commute pool — no conversion to a total-VMT-equivalent is needed. Purpose segmentation makes the scope of each strategy honest automatically. A strategy that touches all purposes (e.g., a trip-length/density strategy) enters all three pools; a commute-only strategy (e.g., workplace parking pricing) enters only the commute pool.

**Applicability map.** Every strategy declares `purpose_applicability` — the set of pools it acts on. A strategy contributes its reduction *only* inside its eligible pools and is simply absent from the others.

---

## 2. The combination algorithm (authoritative order of operations)

Execute in exactly this sequence. The engine runs **independently inside each purpose pool** (commute, recreational, other); results are summed across pools at the end. Do not flatten the within-pool mechanism math into a single multiplication.

```
═══ OUTER LOOP: for each purpose pool P in {commute, recreational, other} ═══
    Use only strategies whose purpose_applicability includes P, applied to that pool's VMT.

  STEP 1 — TAG
    Each selected strategy already has: mechanism, category, place_type, purpose_applicability, target_population.

  STEP 2 — GATE
    For the TAZ's place type, remove any strategy not eligible in that context.
    (Gate = make unavailable, not zero. A strategy invalid in "rural" should not appear selectable.)

  STEP 3 — CHECK EXCLUSIVITY  (see Section 4)
    Apply hard mutual-exclusion rules. If two mutually exclusive strategies are selected,
    block the second and surface the conflict to the user. (Exclusivity is evaluated per pool.)

  STEP 4 — COMBINE WITHIN CATEGORY  (multiplicative)
    For each category c:
      R_c = 1 - Π(1 - R_i)   for all strategies i in category c (that apply to pool P)
    Then CLAMP R_c to that category's cap (Section 3).

  STEP 5 — ROLL CATEGORIES INTO MECHANISMS
    Group the (capped) category results by their mechanism and combine multiplicatively:
      R_trip_generation = 1 - Π(1 - R_c)  for categories tagged trip_generation
      R_trip_length     = 1 - Π(1 - R_c)  for categories tagged trip_length
      R_mode_shift       = 1 - Π(1 - R_c)  for categories tagged mode_shift
    (Note: combine at the strategy level and bucket by mechanism — a strategy with two
     mechanisms is split per its fact-sheet derivation, not entered at full value in both.)

  STEP 6 — COMBINE ACROSS MECHANISMS  (multiplicative)
    R_P = 1 - (1 - R_trip_generation)(1 - R_trip_length)(1 - R_mode_shift)

  STEP 7 — CLAMP POOL TO PLACE-TYPE MAXIMUM  (Section 3)
    R_P = min(R_P, global_cap_for_place_type)

  STEP 8 — POOL VMT SAVED
    VMT_saved_P = baseline_VMT_P × R_P
═══ END LOOP ═══

STEP 9 — SUM ACROSS POOLS  (additive — disjoint pools, no double-count)
  Total VMT saved = Σ VMT_saved_P  over P in {commute, recreational, other}
  Final VMT = baseline_total_VMT − Total VMT saved
```

> **Where caps live.** The category, land-use-subcategory, CTR, and per-measure caps all apply *within a pool* at Steps 4–6. The place-type global maximum is applied per pool at Step 7 (each pool's reduction percentage is bounded). The cross-pool sum at Step 9 is pure addition of VMT — no further cap, because disjoint pools cannot double-count.

**The headline rule for the dev team:** *within a mechanism, strategies compete (overlap, capped); across mechanisms, they compound (independent factors of VMT); across purpose pools, they add (disjoint miles).*

### Worked formula example (two strategies, same category)

If strategy A = 10% and strategy B = 10% in the same category:

```
R_c = 1 - (1 - 0.10)(1 - 0.10) = 1 - 0.81 = 0.19  (19%, not 20%)
```

This multiplicative damping is the CAPCOA-standard way to avoid double-counting; only 90% of VMT remains after the first strategy for the second to act on.

---

## 3. Caps (tie each to place type)

CAPCOA applies **three tiers** of caps, all varying by place type. Implement as a lookup table keyed on the TAZ place type. Values below are the CAPCOA transportation VMT caps.

### 3.0 CDOT place_type → CAPCOA context crosswalk

The calculator uses **four density-based place types**, classified from TAZ density. CAPCOA's caps were published for four contexts that are not purely density-based (they also embed transit access and surrounding intensity). We crosswalk as follows:

| CDOT `place_type` | Classified by | Maps to CAPCOA context | Cap basis |
|---|---|---|---|
| `urban_core` | Highest TAZ density | Urban | CAPCOA "Urban" column |
| `urban` | High TAZ density | Compact Infill | CAPCOA "Compact Infill" column |
| `suburban` | Moderate/low TAZ density | Suburban | CAPCOA "Suburban Center" values (conservative: higher of CAPCOA's two suburban tiers, so we don't under-credit moderate-density suburban TAZs) |
| `rural` | Lowest TAZ density | (no CAPCOA rural column) | **Inherits `suburban` values** as a conservative proxy |

> **Documented simplifications for CDOT review:**
> 1. Place type is classified by **density alone**. No transit-availability flag is applied. This means a dense TAZ receives the same caps whether or not high-quality transit is present — a known over-credit risk for transit/parking strategies in dense-but-transit-poor TAZs. Flag for future refinement if CDOT wants transit-gated eligibility.
> 2. CAPCOA's "Suburban Center" and "Suburban" tiers are **collapsed into one `suburban` tier**, using the Suburban Center (higher) values. This is intentionally non-punitive; if CDOT prefers stricter treatment of low-density suburban TAZs, switch the `suburban` row to CAPCOA's lower Suburban values.
> 3. **`rural` inherits `suburban` caps.** CAPCOA never published a rural cap column. Inheriting suburban values is conservative in the sense that rural TAZs rarely reach even the suburban caps in practice (most transit/parking strategies are gated out of rural by eligibility — see Section 5), so the cap is rarely binding. The real control on rural is strategy *eligibility*, not the cap value.

### 3.1 Tiered caps by CDOT place type

Implement as the lookup table the engine reads at Steps 4–7.

| Cap tier | `urban_core` | `urban` | `suburban` | `rural` |
|---|---|---|---|---|
| **Global maximum** (all 5 categories) | 75% | 40% | 20% | 20% |
| **Category maximum** (4 categories: land use, neighborhood, parking, transit) | 70% | 35% | 15% | 15% |
| **Land Use subcategory** | 65% | 30% | 10% | 10% |

- **Global maximum** caps the combination across all five categories: land use, neighborhood enhancements, parking, transit, and commute trip reduction.
- **Category maximum** caps the combination across the four non-CTR categories.
- The **Land Use subcategory** cap is the tightest and applies to land-use measures alone.
- `rural` values are inherited from `suburban` per Section 3.0.

> Implementation note: these tiers are nested. Apply the land-use subcategory cap first (Step 4), then the category maximum across the four built-environment categories, then the global maximum at Step 7. All caps are applied **per purpose pool**.

### 3.2 Selected per-measure / per-subcategory caps

These are individual measure or subcategory ceilings from the CAPCOA fact sheets. Enforce them at Step 4 before the category roll-up.

| Measure / subcategory | Cap | Source |
|---|---|---|
| Increase Residential Density (T-1) | 30% | CAPCOA pp. 70–72 — lower-density developments do not reduce VMT; reduction capped at 30%. |
| Provide Transit-Oriented Development (T-3) | 31% | CAPCOA pp. 76–79 — max VMT reduction for TOD-area projects. Baseline VMT must not already credit transit proximity. |
| Commute Trip Reduction subcategory (T-5 through T-13 combined) | 45% | CAPCOA — combined CTR-subcategory VMT reduction may not exceed 45%. |
| Voluntary CTR program (T-5), standalone | ~4% | CAPCOA T-5 fact sheet (context-dependent). |
| Commute TDM / employer programs (LA calculator implementation of TRT-9 family) | 15% of commute VMT | Reflects the commute-VMT scope limit. |

> **Double-counting guard built into the CTR cap:** the 45% CTR subcategory cap is CAPCOA's mechanism for absorbing overlap among employer programs, transit subsidy, ridesharing, and parking cash-out, which all pull from the same commuter mode-shift pool. Let the cap absorb *general* overlap rather than trying to flag every pair.
>
> **But not where the Handbook states an exclusion outright.** The cap is the wrong instrument for T-5/T-6 vs T-7…T-11: a cap only binds once the combined reduction is large, whereas that double count exists at any magnitude. See §4.1, which enforces it as a supersession in the engine.

---

## 4. Mutual exclusivity and overlap rules

True mutual exclusivity is **rare** in CAPCOA. Most conflicts are *overlap* (two strategies acting on the same mechanism and the same population), which the caps already handle. Implement two classes of rule:

### 4.1 Hard mutual exclusions (BLOCK the second selection)

These are explicit CAPCOA / calculator-implementation exclusions where the strategies describe overlapping activities such that crediting both is double-counting.

| Strategy A | Strategy B | Reason |
|---|---|---|
| Transit fare subsidy / unlimited transit pass (TRT-11 family) | Neighborhood Shuttle **or** Required (Mandatory) Commute Trip Reduction Program | The activities overlap; LA VMT Calculator disallows combining these because the described activity is already captured. Treat as hard block. |
| Provide Transit-Oriented Development (T-3) | Standalone Increase Residential Density (T-1) **applied to the same parcels** | TOD already embeds density + transit proximity; stacking re-counts the same effect. Allow only one per location. |
| Voluntary CTR Program (T-5) | Mandatory CTR Program (T-6) | Same program, two implementation intensities. Mutually exclusive by definition. |
| Voluntary or Mandatory CTR Program (T-5 / T-6) | Each of T-7, T-8, T-9, T-10, T-11 | **Implemented 2026-07-27.** T-5 fact sheet, Mutually Exclusive Measures: "If this measure is selected, the user may not also take credit for Measures T-7 through T-11. Measure T-5 accounts for the combined GHG reductions achieved by each of these individual measures. To combine the GHG reductions from T-5 with any of these measures would be considered double counting." T-12 and T-13 stay creditable alongside T-5, bounded by the 45% CTR cap. |

**Implementation note: supersession, not blocking.** T-5/T-6 vs T-7…T-11 is enforced in the engine rather than by blocking the second selection. `compute.ts::resolveSupersessions` zeroes the superseded strategies' contribution to the combined total, leaves their standalone estimates intact so the detail view still shows what each would do alone, and the results view tags them "Already counted" with the reason. Enforcing it in the engine makes the total correct regardless of the order strategies were added, which blocking at the point of selection would not guarantee on its own. Rules are declared in `strategy-catalog/globals.yaml` under `measure_supersessions` and matched on `capcoa_measure`, so a strategy added later carrying a covered measure is handled without a code change.

Affected strategies today: `commute_incentives` and `tmo_coverage` are T-5 (superseding); `commute_marketing` T-7, `employee_commuting_benefits` T-9, `end_of_trip_facilities` T-10, `vanpool` T-11 (superseded); `workplace_parking_pricing` T-12 (unaffected, per the fact sheet's own carve-out).

This supersedes the earlier guidance in §3 that the 45% CTR cap alone should absorb this overlap. A cap only binds once the combined reduction is large; the double count exists at any magnitude, so the cap is the wrong instrument for an exclusion the Handbook states outright.

**Resolved 2026-07-27: two strategies may both carry T-5.** `commute_incentives` and `tmo_coverage` are both tagged T-5, and CAPCOA defines a single T-5, so selecting both could be read as double counting the measure against itself. Per CDOT: they model **genuinely distinct programs** (an employer-run rewards programme versus a TMO/TMA extending coordinated services to more worksites), and crediting both is intended. No rule change: a superseding measure is never superseded by its own rule, so the current implementation already behaves this way. The 45% CTR subgroup cap remains the bound on their combined effect.

### 4.2 Soft overlap flags (WARN, do not block)

Surface a non-blocking warning when two selected strategies share **both** `mechanism` AND `target_population`. These are not forbidden, but their combined credit beyond CAPCOA's caps is suspect and warrants analyst review.

Examples to warn on:

- Parking pricing + commute transit subsidy + employer CTR program — all `mode_shift` + `commute`. Let the 45% CTR cap bound them; warn that they overlap.
- Residential vs. workplace versions of the same parking strategy — segment by `target_population` / trip purpose so they do not both apply to the same trips.
- "Increase transit accessibility" + a land-use density measure in a transit-rich TAZ — partially redundant; the place-type gating absorbs most of this.

### 4.3 Sequencing interaction (handled automatically, document it)

Telework/compressed work week is tagged `trip_generation` (it removes commute trips). It shrinks the commute base that downstream `mode_shift` commute strategies act on. The within-then-across sequencing in Section 2 handles this automatically: telework reduces trips, mode-shift reduces auto share of what remains. **Do not** special-case it; just keep the strict ordering.

---

## 5. Reference tagging table for common strategies

Use this as the seed for the strategy table. `T-#` codes are CAPCOA 2021/2024 measure IDs.

| Strategy | CAPCOA ID | `category` | `mechanism` | `purpose_applicability` | `target_population` | Place types (eligible) | Measure cap |
|---|---|---|---|---|---|---|---|
| Increase Residential Density | T-1 | land_use | trip_length + trip_generation | commute, recreational, other | residential / all_trips | urban_core, urban, suburban | 30% |
| Increase Job Density | T-2 | land_use | trip_length | commute | attraction_end | urban_core, urban, suburban | (LU subcat cap) |
| Transit-Oriented Development | T-3 | land_use | mode_shift + trip_length | commute, recreational, other | all_trips | urban_core, urban | 31% |
| Integrate Affordable/BMR Housing | T-4 | land_use | trip_length | commute, recreational, other | residential | urban_core, urban, suburban | (LU subcat cap) |
| Improve Street Connectivity | T-17 | neighborhood_design | trip_length + mode_shift | commute, recreational, other | all_trips | all | (category cap) |
| Infill Development | T-55 | land_use | trip_length | commute, recreational, other | all_trips | urban_core, urban | (LU subcat cap) |
| Bike/Active Infrastructure | T-10 | neighborhood_design | mode_shift | commute, recreational, other | all_trips | all | (category cap) |
| Voluntary CTR Program | T-5 | commute_trip_reduction | mode_shift + trip_generation | commute | commute | all (w/ employment) | ~4% standalone |
| Mandatory CTR Program | T-6 | commute_trip_reduction | mode_shift + trip_generation | commute | commute | all (w/ employment) | (CTR 45% subcat) |
| Telework / Compressed Work Week | T-7/T-8 family | commute_trip_reduction | trip_generation | commute | commute | all (w/ employment) | (CTR 45% subcat) |
| Ridesharing / Carpool Match | TRT family | commute_trip_reduction | mode_shift | commute | commute / attraction_end | all (w/ employment) | (CTR 45% subcat) |
| Transit Fare Subsidy / Unlimited Pass | TRT-11 family | transit | mode_shift | commute, other | commute / all_trips | urban_core, urban, suburban | (category cap) |
| Improve Transit Service / Frequency | transit measures | transit | mode_shift | commute, recreational, other | all_trips | urban_core, urban, suburban | (category cap) |
| Transit Shelters / Stop Amenities | T-46 | transit | mode_shift | commute, recreational, other | all_trips | urban_core, urban | (category cap) |
| Parking Pricing (workplace) | parking pricing | parking | mode_shift | commute | commute | urban_core, urban, suburban | (category cap) |
| Parking Pricing (non-work destination) | parking pricing | parking | mode_shift + trip_generation | recreational, other | attraction_end | urban_core, urban | (category cap) |
| Parking Cash-Out | parking mgmt | parking | mode_shift | commute | commute | urban_core, urban, suburban | (category cap) |
| Reduce Parking Supply / Unbundle | parking mgmt | parking | mode_shift | commute, recreational, other | all_trips | urban_core, urban | (category cap) |

> Where a strategy carries two mechanisms (e.g., T-1 density shortens trips *and* removes some), split its modeled reduction across the mechanisms per the CAPCOA fact-sheet derivation, or assign it the dominant mechanism and document the simplification. Do not let one strategy's full reduction enter two mechanism buckets at full value — that re-introduces double-counting.

> **On `purpose_applicability` vs. `target_population`.** They are related but distinct. `purpose_applicability` selects which *pools* the strategy runs in (the outer loop). `target_population` is finer-grained and drives overlap warnings *within* a pool. The `commute, recreational, other` values above are reasonable defaults — confirm each against your CAPCOA fact-sheet derivation and how your travel demand model defines the purpose split, since some strategies (e.g., non-work parking pricing) act mainly on attraction-end trips that may fall across both recreational and other.

> **On the eligibility column.** Values list the CDOT `place_type` tiers where the strategy is selectable. `all` = `urban_core, urban, suburban, rural`. Note that most transit and parking strategies are intentionally **not** eligible in `rural` — this eligibility gating, not the cap value, is the real control on rural TAZs (rural inherits suburban caps per Section 3.0, but those caps rarely bind because the high-reduction strategies are gated out). Land-use and trip-length strategies (density, connectivity, infill) remain the primary rural-eligible levers. Confirm each row against the CAPCOA fact sheet and CDOT policy.

---

## 6. Implementation checklist

- [ ] Strategy table carries all tags for every strategy, including `purpose_applicability`.
- [ ] Baseline VMT is read per purpose pool (commute, recreational, other) from the model.
- [ ] Engine runs independently inside each purpose pool, using only strategies applicable to that pool.
- [ ] Place-type cap lookup table implemented (Section 3.1) and keyed to TAZ context.
- [ ] Per-measure caps enforced at Step 4 (Section 3.2), within each pool.
- [ ] Within-category multiplicative combination + clamp.
- [ ] Mechanism bucketing + cross-mechanism multiplication (per pool).
- [ ] Global cap clamp at Step 7 (per pool).
- [ ] Cross-pool additive sum at Step 9 (VMT saved, not percentages).
- [ ] Hard mutual-exclusion rules block conflicting selections with a clear message (Section 4.1).
- [ ] Soft overlap warnings fire on shared mechanism + target_population within a pool (Section 4.2).
- [ ] Baseline VMT does **not** already embed reductions the strategies claim (esp. transit proximity for TOD — avoids the most common double-count).

---

## 7. Citations

- CAPCOA, *Handbook for Analyzing GHG Emission Reductions...* (2021; 2024 update). Combination guidance, Handbook p. 38; transportation measures organized into Land Use, Neighborhood Design, Trip Reduction Programs, Parking Management, Transit, Road/Parking Pricing, Clean Vehicles/Fuels subsectors.
- Transportation VMT caps (global / category / land-use subcategory by place type): CAPCOA presentation materials, South Coast AQMD.
- Residential density 30% cap: CAPCOA pp. 70–72 (via Caltrans SB 743 Mitigation Playbook).
- TOD 31% cap: CAPCOA pp. 76–79 (via Caltrans SB 743 Mitigation Playbook).
- CTR subcategory 45% combined cap: CAPCOA Measure T-5 fact sheet.
- Transit-pass / shuttle / mandatory-CTR mutual exclusion: LA VMT Calculator TDM strategy documentation (LADOT), implementing CAPCOA TRT-11.
- Multiplicative damping method: CAPCOA combination rules; cf. SCTA VMT Reduction Calculator design document.
