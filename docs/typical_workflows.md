# Typical Workflows: CDOT TDM Calculator

Three end-to-end walkthroughs of how people actually use the calculator app, written
to exercise a broad range of its features. Each step names the specific UI element
(button label, panel, control) so these double as a manual test script and as a
reference for onboarding, QA, and accessibility review.

Shared chrome that appears on every calculator screen:

- **Header**: the CDOT logo / **TDM Calculator** title doubles as a "start a new
  project" home button; nav links **Calculator**, **Methodology**, **Data sources**.
- **Workflow steps bar** (the breadcrumb): **1 Area › 2 Strategies › 3 Results**.
  Each step is a button; **3 Results** stays disabled until at least one strategy is
  in the package. To its right is a live totals strip (**Project area** (TAZ count),
  **Baseline VMT**, **Basket impact** (−% VMT), **Annual reduction** (M mi/yr)) and a
  **View results** button carrying a count badge.
- A **Skip to main content** link is the first tab stop on every page.

The three views referenced below map to routes `#/area`, `#/strategies`,
`#/strategies/:id`, `#/cart`, and `#/report`, plus the static `#/methodology` and
`#/data` reference pages.

---

## Workflow 1: Build a defensible package for a grant application (the full happy path)

**Persona:** An MPO/regional planner assembling a VMT-reduction estimate for a
transit-oriented development near a rail station, to attach to a grant application.

**Goal:** Select the project area, stack several strategies, sanity-check the
methodology, and export a citable PDF.

1. Land on **Area** (`#/area`). Read the **How it works** panel, then go to the map.
2. In the map **search box** (top-left, *"Search address, place, or TAZ ID…"*), type the
   station's address (or a known TAZ id) to jump there. (The search is biased to
   Colorado, so namesake results elsewhere are filtered out.)
3. **Click** a TAZ over the station to select it (it fills blue), then **Shift-click**
   the adjacent zones to add them, or press **Draw area**, click vertices around the
   whole station district, and double-click to finish. The totals strip flashes and
   fills in **Project area** and **Baseline VMT**.
4. Click **Select strategies →** (enabled once ≥1 TAZ is selected). You land on
   **Strategies** (`#/strategies`).
5. In the **Filter strategies** sidebar, click the **Land use** category, then refine
   with **Tags** chips (e.g. the **Context** facet → *transit-served*). Note the
   **N in basket** counts that appear under categories as you add strategies.
6. Click the **Transit Oriented Development** card. On the detail page:
   - Read the hero (its **ID** badge `LU-03`, category band, description, photos).
   - Check the **Project context** section: the baseline density, mode share, and VMT
     pulled from *your* selected TAZs, with a `→ projected` value where relevant.
   - In **Configure**, drag the **sliders** / set the **number** and **select** inputs.
     Use a **How do I find this?** disclosure under an input if you're unsure of a value.
   - Watch the **At your settings** preview update live (−X.XX % VMT · N TAZs, and
     **Annual VMT reduced** in M mi/yr against baseline).
   - Expand the **Methodology** accordion to read the **Method**, **Subsector cap**,
     formula box, and citations you'll need to defend the number.
   - Click **Add to package**. The **"… added to your package · N strategies total"**
     banner appears on the strategies list.
7. Repeat for **Increased Residential Density** and **Transit Service Frequency
   Increase**. If a chosen strategy doesn't fit the area (e.g. density too low), heed
   the **"Limited applicability for this area."** warning on its detail page.
8. Click **View results** (or breadcrumb **3 Results**) → **Results** (`#/cart`):
   - The hero shows the combined **−X.XX % VMT**, plus **Daily VMT reduced**,
     **Annual VMT reduced**, and **GHG avoided**.
   - If transit strategies stack past their cap, a **"Subsector cap applied"** note
     shows and affected lines are flagged **CAPPED**.
   - The right rail shows **Reduction by category** and **Co-benefits** (GHG avoided,
     **Cars off-road equivalent**).
9. In the **Export** card, click **Export PDF report** → **Report** (`#/report`). The
   print dialog opens automatically once the project-area map renders. Review the
   **Results summary**, **Per-strategy contribution** table, **Project area &
   configured inputs** (static map + TAZ table), and **Selected strategies &
   methodology**, then **Print / Save as PDF**.

**Features exercised:** address / TAZ-ID search · click / shift-click / draw-area
selection · category + tag filtering · detail hero, project context, all three input
types, "how do I find this?", live preview, applicability warning, methodology
accordion · add-to-package banner · cart hero, category breakdown, co-benefits,
subsector cap · PDF report export.

---

## Workflow 2: Drill into bike & micromobility strategies and dial in their inputs

**Persona:** A local-government active-transportation planner evaluating a neighborhood
bike-network buildout. They want to look only at the cycling and micromobility options
and know exactly what each one asks for before configuring it.

**Goal:** Build a single-category bike/ped package, setting each strategy's required
inputs deliberately, and see how the category's combined cap behaves.

1. From **Area**, select the project neighborhood's TAZs (click + **Shift-click**, or
   **Draw area**), then click **Select strategies →**.
2. On **Strategies**, in the **Filter strategies** sidebar click the **Bike and Ped Infrastructure and
   Amenities** category; the count shows how many live there and the grid narrows to
   just those. Narrow further with the **Mode** tag facet → *bike* for only the cycling
   measures. Keep in mind this category carries an **8% combined subsector cap**.
3. Open **Protected or Buffered Bike Lanes** (`BP-01`). Required inputs:
   - **Share of study-area VMT affected by the bikeway**: slider, **0–70 %** (default **5 %**),
     the share of study-area VMT on the bikeway corridor and nearby parallel streets.
   - **Annual ridable days**: number, **0–365** (pre-filled from NOAA climate normals
     for your area, e.g. **230**). Override only if you have a local figure; the
     **How do I find this?** disclosure explains the "high 32–95 °F, no precip" definition.
   Watch the **At your settings** preview, then **Add to package**.
4. Open **Striped Bike Lanes, Neighborhood Bikeways and Sharrows** (`BP-02`). One input:
   **Share of study-area VMT affected by the bikeway**, a slider, **0–100 %** (default
   **10 %**), for the share of study-area VMT on the affected streets. **Add to package**.
5. Open **Shared Micromobility** (`BP-03`). Note it now lives under **Shared Mobility**,
   not this category, so clear the category filter or search for it. Five inputs:
   - **Fleet mix: pedal bikes / e-bikes / scooters**: three sliders (default **100 % / 0 %
     / 0 %**). The car-trip substitution rates (19.6 %, 35.0 %, 38.5 %) are blended by
     share, so a mixed fleet is entered directly. Shares are normalized.
   - **% population with access today**: slider; set **0 %** if there's no system yet.
   - **% population with access after**: slider (e.g. **30 %**). The before→after gap is
     what drives the reduction. **Add to package**.
6. Open **Workplace Bicycle Amenities** (`BP-07`). One input: **Share of commuters with
   access**, a slider, **0–100 %** (default **40 %**), for the share of area commuters at
   worksites that provide secure bike parking, showers, and lockers. **Add to package**.
7. Click **View results**. Because the bike/ped measures share a subsector, expect
   the **8 % subsector cap** to bind: the **"Subsector cap applied"** note appears, the
   stacked lines carry the **CAPPED** flag, and the combined total is scaled down. The
   **Reduction by category** card isolates the bike/ped contribution.
8. In the **Export** card, click **Download CSV** to pull the per-strategy figures and
   your configured inputs into a spreadsheet for the project file.

**Features exercised:** single-category drill-down + **Mode** tag facet · the specific
required inputs for each bike/micromobility strategy (parallel-VMT and area-VMT sliders,
the NOAA-prefilled "ridable days" number, the device-type **select** with its
substitution ratios, before/after access sliders, the commuter-access slider) ·
**How do I find this?** guidance · the **8 % bike/ped subsector cap** binding across a
single-category package · CSV download.

---

## Workflow 3: Iterate, compare scenarios, and stress-test the numbers

**Persona:** A reviewer who is skeptical of the estimate; they want to understand the
methodology, test how caps behave, model an offsetting road widening, and revise inputs.

**Goal:** Vet the tool's assumptions and iterate on a package, using the analytical and
editing features.

1. Before building anything, click **Methodology** in the header. Skim the **Calculation
   flow**, the **Mode share imputation** table, the per-category **Strategy formulas**,
   and the **Elasticities and effect sizes** tables. Then open **Data sources** to see
   the **enriched TAZ layer** fields and the **Source datasets** (CDOT 2019 SWTDM, ACS
   B08301, NOAA normals, CDOT public layers).
2. Return to **Calculator**, select a handful of urban TAZs on the map (click +
   shift-click). Toggle the **Reference layers** panel (the **▸ Reference layers**
   disclosure on the map) to overlay **Traffic volume (AADT, 2024)** and **Transit
   routes** (the **map legend** appears bottom-corner) to sanity-check the corridor's
   context as you choose zones.
3. Go to **Strategies** and deliberately stack several from one capped category (e.g.
   add **Transit Service Frequency Increase**, **Transit Service Expansion**, and
   **Transit Shelters**) to see capping behave. Use the **Tags**
   facets (**Lever**, **Mode**) to find related strategies, and **Clear all filters**
   to reset the sidebar.
4. On **Results**, confirm the **"Subsector cap applied"** note appears and the stacked
   lines show the **CAPPED** flag, with the combined total scaled down accordingly.
5. Model a tradeoff: add **Lane Miles Reduced or Lane Miles Added (Induced Demand)** (the **Roadway Capacity** category). Its card and detail page are styled as a warning, the preview
   shows a **+** (VMT increase), and on **Results** its contribution is added with a
   `+` sign, letting you net a capacity project against the TDM package.
6. Iterate without leaving Results: click **Edit** on a strategy line to jump back to its
   detail page (inputs pre-filled to your last values), adjust a **slider** or **select**,
   and **Update selection**. Use **Remove** on a line (or the detail page) to drop a
   strategy. Watch the hero **−X.XX % VMT** and **Reduction by category** recompute.
7. Compare a second scenario: change the project area (breadcrumb **1 Area**, adjust the
   TAZ selection) and watch every downstream figure update, since the area, basket, and
   results are shared state.
8. Start clean for the next project: click the **CDOT logo / TDM Calculator** home
   button. Because the session is "dirty," the **"Start a new project?"** confirm modal
   appears; choose **Start over** (clears TAZs, basket, and results) or **Keep working**.

**Features exercised:** Methodology + Data sources reference pages · reference layers
(AADT / Transit) + legend · tag facets + clear filters · subsector-cap behavior and
**CAPPED** flags · the induced-demand / negative-impact strategy ·
**Edit**/**Update selection**/**Remove** round-trips from the cart · shared state
recomputation when the area changes · the **Start a new project?** reset modal.

---

## Keyboard-only reproduction (validated, no mouse)

All three workflows above were driven end-to-end with **keyboard only** (Tab / Shift+Tab
to move focus, **Enter**/**Space** to activate, arrow keys for sliders & selects) using
Playwright against the local dev server, and all three reach the Results page with the
correct configured package. Reproduce with these mechanics and concrete inputs:

**Universal keyboard mechanics**

- **Move / activate:** Tab and Shift+Tab move focus; Enter activates buttons, links, and
  **strategy cards**; Space also activates cards and toggles **Reference layers**
  checkboxes; the first Tab stop on every page is **Skip to main content**.
- **Selecting a project area is done through the map *search box*, not the map canvas.**
  The map surface is `role="application"` and only responds to mouse clicks, so the
  keyboard path is: Tab to the search box (*"Search address, place, or TAZ ID…"*), type a
  known **TAZ id**, press **↓ then Enter** to choose the *TAZ ID* suggestion. The zone is
  added to the selection, the map zooms to it, and **Project area** increments. Use the
  reproducible urban-core zone **TAZ 6789** (pop ≈ 7,600 · emp ≈ 11,600) for a non-trivial
  result; repeat for additional zones.
- **On a strategy detail page the "Add to package" button sits *above* the Configure
  inputs in the tab order.** Keyboard sequence: Tab *down* into **Configure** to set the
  sliders / number / select, then **Shift+Tab** back up to **Add to package** (or
  **Update selection**) and press Enter.
- **Reset dialog:** activating the **TDM Calculator** home button opens the
  **"Start a new project?"** `<dialog>`; focus lands on **Keep working**, focus is
  trapped, **Esc** cancels, Enter on **Start over** resets.

**WF1, grant package (keyboard script).** Area → search **6789** → Enter on
**Select strategies →**. For each of **Transit Oriented Development**, **Increased
Residential Density**, **Transit Service Frequency Increase**: filter the **Search
strategies** box to the name, Tab to the card, Enter, configure, Shift+Tab to **Add to
package**, Enter. Then Enter on **View results** → Results shows the three strategies
(≈ **−23 % VMT** for 6789). Tab to **Export PDF report**, Enter → `#/report`.

**WF2, bike package (keyboard script).** Area → search **6789** → **Select strategies →**.
Enter on the **Bike and Ped Infrastructure and Amenities** category (grid narrows to **6 of 26**). Add
**Protected or Buffered Bike Lanes** (slider + *Annual ridable days* number),
**Striped Bike Lanes…**, **Pedestrian Network Improvements** (two mileage numbers),
**Workplace Bicycle Amenities**, each via search→Tab→Enter, configure,
Shift+Tab→**Add**. **View results** (≈ **−0.8 % VMT**), Tab to **Download CSV**, Enter.

**WF3, iterate / stress-test (keyboard script).** Tab to **Methodology**, Enter; Tab to
**Data sources**, Enter; Tab to **Calculator**, Enter. Search **6789**. Enter on
**Reference layers**, then Tab to the checkbox and press **Space** (Transit Lines).
**Select strategies →**; add **Transit Service Expansion**, **Transit Service Frequency
Increase**, **Transit Pass Subsidies**, **Lane Miles Reduced or Lane Miles Added (Induced Demand)**.
**View results** (the induced-demand line shows a **+** sign). Tab to a line's **Edit**,
Enter, adjust a slider, Shift+Tab to **Update selection**, Enter; **View results** again;
Tab to **Remove** on a line, Enter. Tab to the home button, Enter, then Enter on **Keep
working** to preserve the package, ending on Results with the final set.

> **Note on the subsector cap:** for a single TAZ the combined transit reduction may stay
> under the 15 % cap, so the **CAPPED** flag won't always appear; select several urban
> TAZs (search multiple ids) and raise the inputs to force the cap to bind.

---

### Coverage matrix (quick reference)

| Feature / UI element | WF1 | WF2 | WF3 |
|---|:--:|:--:|:--:|
| Address / TAZ-ID search | ● | | |
| Click / Shift-click / Draw-area selection | ● | ● | ● |
| Reference layers (AADT / Transit) + legend | | | ● |
| Category filter / single-category drill-down | ● | ● | |
| Tag facet chips / Clear all filters | ● | ● | ● |
| Strategy search + Sort | | | ● |
| Detail: project context | ● | | |
| Detail: sliders / number / select inputs | ● | ● | ● |
| "How do I find this?" disclosure | ● | ● | |
| Live "At your settings" preview | ● | ● | ● |
| Applicability warning | ● | | |
| Methodology accordion | ● | | |
| Add / Update / Remove from package | ● | ● | ● |
| Added-to-package banner | ● | ● | |
| Cart hero + category breakdown + co-benefits | ● | ● | ● |
| Subsector cap / CAPPED flags | ● | ● | ● |
| Roadway Capacity (Lane Miles Reduced/Added) | | | ● |
| Edit round-trip from cart | | | ● |
| PDF report export | ● | | |
| CSV download | | ● | |
| Methodology / Data sources pages | | | ● |
| Start-a-new-project reset modal | | | ● |
| Breadcrumb step navigation | ● | ● | ● |
