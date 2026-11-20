# SIAGA-Padi v2: build plan

Goal: maximise the app before the KS5203 presentation. Work phase by phase,
commit after each task, keep the data contract backward compatible, and record
results and decisions in CLAUDE.md "Status" as before.

Guiding ideas (from the course and the lecturer's reference app ARNANTARA):
- One timeline like Ventusky: past (satellite) | today | +14 days (forecast).
- ML is expected: forecasts come with a P10-P90 range, a confidence label,
  the top reasons, and a human Terima/Tolak.
- Impact-based: express risk as hectares, tonnes and rupiah, and show action
  options with their estimated effect.
- Real 2026 data is our edge over simulated dashboards; keep "data freshness"
  visible. Do not chase feature count.

---------------------------------------------------------------------------
## Phase 0: required fixes

Status 2026-11-20: 0.1 and 0.3 done; 0.2 done for stage 9 (results in
CLAUDE.md); stage 10 "gagal tanam?" moved to after Phase 3 (needs the
irrigation layer).

0.1 Race condition in server/store.py
  - Python sqlite3 opens the transaction only at the INSERT, so the step check
    (SELECT) runs outside it; two simultaneous clicks can both pass from_step.
  - Fix: write paths use `BEGIN IMMEDIATE` (e.g. a `conn(write=True)` variant
    or isolation_level=None with explicit BEGIN IMMEDIATE / COMMIT).
  - Accept: a test firing two concurrent identical steps gets exactly one 200
    and one 409.

0.2 "Panen atau puso?" instead of silent exclusion
  - Today TRAJECTORY stage 7 (panen) and 6 (bera) drop pixels from active rice.
    A drought-killed crop (puso) or a failed establishment (gagal tanam) looks
    the same, so the worst-hit areas vanish from the priorities.
  - Split: 7 = panen (expected timing, NDDI not stressed before the drop),
    9 = "panen atau puso? perlu cek" (drop earlier than ~90 days after
    green-up, or NDDI in Kuat/Ekstrem in the period before the drop).
    6 stays bera, but 10 = "gagal tanam?" where the pixel is irrigated
    (Phase 3 layer) or neighbouring sawah in the same desa greened.
  - UI: a "Perlu verifikasi" list per kecamatan (ha of 9 and 10), its own
    colour in the stage layer, and a prefilled field-report question.
  - Accept: Jun-Nov 2026 re-export; report ha of 7 vs 9 and 6 vs 10 per
    kecamatan in CLAUDE.md.

0.3 CLAUDE.md: remove the stale "meta.notes not rendered" next step.

---------------------------------------------------------------------------
## Phase 1: one timeline + guided tour

Status 2026-11-20: 1.2 and 1.3 done; 1.1 done except the parts that need
Phase 2 (forecast steps, P10-P90, forecast sentence in messages). Results in
CLAUDE.md.

1.1 Unified timeline (replaces the separate month strip + what-if slider)
  - Bottom bar: monthly observed periods ... | "Hari ini" | +7 d | +14 d.
  - Observed periods: as now. Forecast steps: from forecast.json (Phase 2);
    until it exists, hide the forecast segment.
  - Forecast views are clearly marked (badge "PRAKIRAAN", hatched or faded
    raster, uncertainty shown as P10-P90 in the panel and trend chart).
  - Show the real date of the latest satellite scene next to "Hari ini"
    ("citra terakhir 4 Nov, 16 hari lalu"): today is itself a nowcast.
  - The no-rain what-if moves to a "Uji skenario" button in the detail panel
    (still uses scenario.json).
  - Messages to Gapoktan keep using observed data, plus an optional forecast
    sentence when the forecast is confident.

1.2 Guided tour ("Pemandu"), like Nara in ARNANTARA
  - 6-8 steps with highlight + short text: map and layers, timeline,
    status levels, priority list, detail panel, action workflow, field
    reports, forecast. Prev / Next / Jeda, remembered as seen (localStorage).
  - Auto-start on first visit, button in the top bar afterwards.

1.3 Data freshness badge (top bar): latest scene date, rain update time,
    forecast run time; green / amber / red by age.

---------------------------------------------------------------------------
## Phase 2: ML forecast, 14 days ahead

2.1 Training data export (pipeline/ml_dataset.py)
  - Landsat 8 (2013-) + 9 (2021-) TOA C2, same masks and indices as
    gee_export. Unit: desa (~400) x Landsat observation date (per-date
    composites over Pati, skip if cloud-free active rice < 30 %).
  - Per (desa, date): area by NDDI class, mean/quantiles NDDI, NDVI and NDVI
    change vs the previous observation, growth-stage shares, cropland ha.
  - Rain: CHIRPS daily (UCSB-CHG/CHIRPS/DAILY) per desa: sums for the last
    10/30/60 days, and for the target window.
  - Static: irrigated share per kecamatan (Phase 3), elevation (SRTM), month.
  - Save as parquet under data/ml/. Expect a long EE run: batch by year, make
    it resumable.

2.2 Target and model (pipeline/ml_train.py)
  - Target: share of active rice in Kuat+Ekstrem at the next observation(s),
    horizon h in [8, 40] days from the last observation (h is a feature, so
    one model covers nowcast "today" and +14 days from today).
  - Models: LightGBM quantile regression (alpha 0.1 / 0.5 / 0.9).
  - Split by time: train 2013-2022, validate 2023, test 2024-2026. Never
    random splits (leakage between neighbouring dates).
  - Baselines: persistence ("no change"), and desa climatology for the month.
  - Metrics: MAE in ha per kecamatan, pinball loss, P10-P90 coverage
    (target ~80 %), hit rate / false alarm for "reaches Siaga or Awas".
  - Explanations: SHAP top 3 features per kecamatan forecast, mapped to plain
    Indonesian ("hujan 14 hari rendah", "fase reproduktif", "irigasi minim").
  - Rain caveat: training uses observed rain for the future window, inference
    uses a forecast. Also report test skill when the future rain is replaced
    by climatology, to show the lower bound.
  - Save model + metrics to data/ml/models/<run_id>/ with a model card.

2.3 Inference (pipeline/forecast.py) -> web/public/data/forecast.json
  - Inputs: latest observed state + Open-Meteo 14-day rain (already fetched
    in weather.py) + statics.
  - Output per kecamatan and desa for +0 (nowcast), +7, +14 days: P10/P50/P90
    of Kuat+Ekstrem share and ha, the implied status via scoring.score(),
    confidence (from the P10-P90 width), top reasons, model run id,
    test metrics summary.
  - Optional raster: desa choropleth is enough; no pixel forecast needed.
  - Scheduler: run after weather refresh (server/jobs.py).

2.4 UI
  - Forecast steps on the timeline; desa/kecamatan colouring by P50 status
    with a confidence indicator.
  - Detail panel: forecast card with P10-P90 bar, "Model" vs "Aturan" label,
    keyakinan (Tinggi/Sedang/Rendah), 3 reasons, and Terima/Tolak for Dinas
    (logged as an event; accepted forecasts may feed the recommendation).
  - "Tentang model" page: data, split, metrics vs baselines, limitations.

---------------------------------------------------------------------------
## Phase 3: irrigation capacity (risk = hazard x vulnerability / capacity)

Status 2026-11-20: 3.1, 3.2, 3.3 done (except the ML feature, which waits for
Phase 2), plus stage 10 from 0.2. Results in CLAUDE.md.

3.1 Ingest official stats (data/irrigation/): sawah irigasi and sawah tadah
    hujan per kecamatan, 2024 XLSX from opendata.patikab.go.id (user
    downloads; 2022 totals already in sawah_irigasi_2022_per_kecamatan.csv).
    Normalise kecamatan names (e.g. "Gunungwungkal" = "Gunung Wungkal").
3.2 Satellite proxy 2026: pixels that stayed green or were planted during the
    dry months (Jul-Sep 2026) have water access. Aggregate per kecamatan and
    validate against the official irrigated area (scatter + correlation in
    CLAUDE.md and the "Tentang data" page).
3.3 Use it: capacity factor in scoring (rainfed-heavy kecamatan weigh more),
    feature in the ML model, and recommendations split by water source
    (irigasi: atur gilir air / koordinasi P3A; tadah hujan: pompa sumur
    dangkal, tunda tanam, varietas genjah).

---------------------------------------------------------------------------
## Phase 4: impact in tonnes and rupiah + action options

4.1 Potential loss = ha at risk x Pati rice productivity (BPS, cite year) x
    gabah price (HPP GKP, cite regulation). Keep both in config.py with
    sources; show as a range, never false precision.
4.2 Action options per kecamatan with estimated effect ("pompa ke blok X:
    selamatkan +/- N ha, +/- Rp ..."), using simple, documented assumptions.
4.3 Dinas cockpit view (role dinas): KPI tiles (ha Kuat+, kecamatan per
    status, potential loss, open actions, forecast trend) and an alert list
    with owner and age, like ARNANTARA modules A and L.

---------------------------------------------------------------------------
## Phase 5: verification and polish

5.1 Verification panel: forecast skill on the test years, hit/false alarm,
    agreement with field reports (feedback.json), video check (Aug 2024).
5.2 NDDI anomaly vs the 2013-2025 same-month baseline as an extra layer
    ("lebih kering dari biasanya").
5.3 Mobile check of the officer views; split web/src/main.ts if it keeps growing.
