# CAPCOA citation fixes: app source (handoff)

**Context.** The strategy YAML catalog (`strategy-catalog/strategies/*.yaml`) has been
updated to cite the **2021 CAPCOA Handbook** measure codes (the single `T-` series;
the 2010 `TRT-`/`LUT-` codes are retired). The same citations are duplicated in the
app's TypeScript source and were **not** updated in that pass. This doc lists every
remaining location and the exact change needed.

Two of these are **outright wrong codes** (not just stale prefixes) and will mislead a
practitioner reading the Methodology page (flagged with ⚠️ below).

**No numbers, formulas, or effect sizes change.** These are citation/label text only.

---

## Reference: 2021 measure codes used here

Canonical fact-sheet deep-link pattern (verified to resolve):
`https://www.caleemod.com/documents/handbook/ch_3_transportation/measure_t-{N}.pdf`
(sub-lettered measures use a lowercase suffix, e.g. `measure_t-19-a.pdf`).

| 2021 code | Title | Old 2010 code |
|---|---|---|
| T-1 | Increase Residential Density | LDT/LUT |
| T-2 | Increase Job Density | n/a |
| T-3 | Provide Transit-Oriented Development | LUT-4 |
| T-5 | Implement Commute Trip Reduction Program (Voluntary) | TRT-1 |
| T-6 | Implement Commute Trip Reduction Program (Mandatory) | TRT-2 |
| T-7 | Implement Commute Trip Reduction Marketing | TRT-7 |
| T-9 | Implement Subsidized or Discounted Transit Program | TRT-4 |
| T-10 | Provide End-of-Trip Bicycle Facilities | n/a |
| T-11 | Provide Employer-Sponsored Vanpool | n/a |
| T-12 | Price Workplace Parking | TRT-14 |
| T-13 | Implement Employee Parking Cash-Out | TRT-15 |
| T-19-A | Construct or Improve Bike Facility | n/a |
| T-20 | Expand Bikeway Network | n/a |
| T-22-A / B / C | Pedal / Electric Bikeshare / Scootershare | n/a |
| T-24 | Implement Market Price Public Parking (On-Street) | n/a |
| T-25 | Extend Transit Network Coverage or Hours | n/a |
| T-26 | Increase Transit Service Frequency | n/a |
| T-29 | Reduce Transit Fares | n/a |

> Note: `T-21` is **Carshare** and `T-23` is **Community-Based Travel Planning**; neither
> is a bike/scooter or transit-fare measure. They had been mis-cited (see below).

---

## 1. `app/src/components/MethodologyView.tsx`

This renders the "Elasticities and effect sizes" and "Pre-quantified program effects"
tables on the Methodology page. The citations are hardcoded in the `<td>` cells.

### ⚠️ Line ~201: bike facility cites the wrong measure (T-21 is carshare)
```diff
- <tr><td>bike_facility</td><td>+{ELASTICITIES.bike_facility}</td><td>CAPCOA T-21 effect size</td></tr>
+ <tr><td>bike_facility</td><td>+{ELASTICITIES.bike_facility}</td><td>CAPCOA T-19-A / T-20 effect size</td></tr>
```

### Line ~218: TMO voluntary CTR
```diff
- <td>TMO coverage: CAPCOA TRT-1 midpoint</td>
+ <td>TMO coverage: CAPCOA T-5 midpoint</td>
```

### Line ~219: commute marketing/incentives program
```diff
- <td>Marketing / incentives: CAPCOA TRT-7 midpoint</td>
+ <td>Marketing / incentives: CAPCOA T-7 (marketing) / T-5–T-6 (incentive) midpoint</td>
```

### Line ~220: parking cash-out
```diff
- <td>Parking cash-out: CAPCOA TRT-15</td>
+ <td>Parking cash-out: CAPCOA T-13</td>
```

### Line ~221: TOD multiplier
```diff
- <td>TOD-resident transit share vs. area: CAPCOA LUT-4</td>
+ <td>TOD-resident transit share vs. area: CAPCOA T-3</td>
```

### ⚠️ Line ~224: end-of-trip facilities cites the wrong measure (T-29 is Reduce Transit Fares)
```diff
- <td>End-of-trip facilities: CAPCOA T-29</td>
+ <td>End-of-trip facilities: CAPCOA T-10</td>
```

> Also worth checking line ~223 (`sharrows_bike_share_boost … CAPCOA T-19`): this one is
> already in the `T-` series. For precision it can read `CAPCOA T-19-A / T-20`, matching
> the YAML. Optional.

---

## 2. `app/src/strategies/context.ts`

These are `source:` strings shown on the "Project context" cards in the strategy detail
(configure) view.

### Line ~307: TOD multiplier
```diff
- source: "CAPCOA LUT-4 (Lund 2004 / Cervero 2007)",
+ source: "CAPCOA T-3 (Lund 2004 / Cervero 2007)",
```

### Line ~360: TMO per-eligible reduction
```diff
- source: "CAPCOA TRT-1 (voluntary CTR midpoint)",
+ source: "CAPCOA T-5 (voluntary CTR midpoint)",
```

### Line ~380: commute program per-eligible reduction
```diff
- source: "CAPCOA TRT-7 (marketing/incentives midpoint)",
+ source: "CAPCOA T-7 (marketing) / T-5–T-6 (incentive) midpoint",
```

---

## 3. `app/src/strategies/constants.ts` (code comments, optional)

Not user-facing, but inconsistent with `scripts/strategy_calculations.py`, whose
`PROGRAM_EFFECTS` comments already cite the 2021 codes (`T-5`, `T-13`, `T-3`). Align them:

### Line ~64
```diff
-  tmo_voluntary_ctr_per_eligible: 0.04,   // CAPCOA TRT-1 midpoint
+  tmo_voluntary_ctr_per_eligible: 0.04,   // CAPCOA T-5 midpoint (formerly TRT-1)
```

### Line ~67
```diff
-  tod_mode_share_ratio:           4.9,    // CAPCOA LUT-4
+  tod_mode_share_ratio:           4.9,    // CAPCOA T-3 (formerly LUT-4)
```

---

## 4. `app/src/strategies/strategies.ts` (code comment + assumptions label, optional)

### Line ~285: section comment
```diff
- // 6. Transit Oriented Development (Methods row 9: CAPCOA LUT-4)
+ // 6. Transit Oriented Development (Methods row 9: CAPCOA T-3, formerly LUT-4)
```

### Line ~323: assumptions string (appears in CSV export / debug output)
```diff
-      `tod_mode_share_ratio=${ratio}_per_CAPCOA_LUT-4`,
+      `tod_mode_share_ratio=${ratio}_per_CAPCOA_T-3`,
```
> ⚠️ If any golden-value test or snapshot asserts on the `assumptions` string, update the
> expected fixture too. (The TOD golden tests assert numeric output only, per the comment
> at `strategies.ts:301-303`, so this is likely safe, but grep for `per_CAPCOA_LUT-4`
> in tests/fixtures before changing.)

---

## Leave as-is

The `// formerly TRT-X in the 2010 edition` comments in
`scripts/strategy_calculations.py` (lines ~184-189, ~911, ~1183, ~1210, ~1245) already
cite the correct 2021 code and intentionally note the historical mapping. No change needed.

---

## After editing

The app reads the strategy *catalog* from `app/src/strategies/catalog.json` (synced from
the YAML), but the items above are hardcoded in `.ts`/`.tsx`, so a normal
build/typecheck is the only verification needed:

```
cd app
npm run build      # or: npm run typecheck && npm test
```

No catalog rebuild is required for these files (they aren't generated from the YAML).
