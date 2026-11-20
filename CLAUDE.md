# CLAUDE.md: SIAGA-Padi

Context for Claude Code. Read README.md for setup and method details.

## What this is

Prototype for **KS5203 Kecerdasan untuk Sistem Multidisiplin** (ITB, Magister
Kecerdasan Sistem), Proyek Minor. The course (P9–P13, Dr. Armi Susandi) is
about hydrometeorological disasters, impact-based early warning, intelligent
DSS and digital twins. Deliverable: a concept + prototype of an intelligent
information system for one disaster phase, presented at P14–P15.

**Positioning (decided):** *In-season drought response system for extension
officers.* Turns satellite crop-stress data (NDDI) into prioritised,
approved and tracked field actions, and learns from officer field reports.
Ventusky is only the visual inspiration, not the product.

- Primary user: **penyuluh** (extension officer). Secondary: **Dinas Pertanian**
  (approves actions). Farmers benefit via WhatsApp messages to Gapoktan.
- Complements the lecturer's SICA (when to plant) rather than competing with it:
  this covers stress during the season.
- Honest maturity label: **digital shadow with a human-closed feedback loop**,
  moving toward a twin. Do not call it a full digital twin.
- Lecturer's emphasis: close the gap between data and action (decision,
  what-if simulation, two-way loop), not just better prediction.

## Study area and method

- Kabupaten Pati. **Operational view = rolling last 6 months up to today**
  (`gee_export.py --last-months 6`). Aug 2024 is only a verification run
  against the NgabubuGIS #2 video, not the product's default (user's call).
- Method from NgabubuGIS #2 (Izzuddin Muhammad, 2026): Landsat 8/9 TOA → NDVI,
  NDMI, NDDI via `.expression()`; ESA WorldCover class 40 mask; NDVI growth
  stage mask (keep stages 2–4); |NDDI| < 100 guard; Artikanur 2022 classes.
- Video reference values for verification: Kuat ≈ 11,000 ha; Normal ≈ 19 ha;
  Tambakromo mean NDDI ≈ 2.647 (highest, then Batangan, Pucakwangi, Winong);
  Cluwak ≈ 0.3 (lowest).

## Architecture

- `pipeline/` Python = single source of truth for data and scoring.
  `config.py` holds every methodological choice. `scoring.py` = impact index
  (H-MHEWS style): H → status, ha-at-risk → ranking, rule-based recommendation.
- `web/` TypeScript + Vite + MapLibre, Indonesian UI. Reads only
  `web/public/data/` (contract v1: `meta.json`, `kecamatan.json`, `desa.json`,
  `layers/*.png`). Sample and real data share the contract.
- Stage 1 contract extension (optional, backward compatible): `meta.periods[]`
  + `meta.current_period`, `properties.series[period_id]` per kecamatan,
  rasters in `periods/<id>/layers/`. Top-level fields mirror the current
  period. Frontend: `web/src/timeline.ts` (month strip + trend chart); period
  switching mutates feature props in place and calls `api.setPeriod()`.
- Stage 2 contract extension (optional): `weather.json` (per kecamatan
  dasarian rain obs/forecast, HTH, forecast sum; `pipeline/weather.py`) and
  `scenario.json` (per kecamatan score for N = 0..9 dasarian without rain,
  calibration diagnostics; `pipeline/scenario.py`). Frontend:
  `web/src/weather.ts` (rain bars, scenario curve); the slider lives in the
  ranking panel and mutates props like period switching; messages to
  Gapoktan always use observed data. Scenario only for `current_period`.
- Stage 3 backend: `server/` FastAPI + SQLite (`app.py`, `store.py`, `jobs.py`).
  Append-only events (step/reset) per (period, kec); state derived. Server
  enforces roles (proposed/sent/done = penyuluh, approved = dinas; reset:
  dinas, or penyuluh withdrawing a proposal), step order, optimistic
  concurrency (`from_step` → 409) and current-period-only writes. Reports
  (answer id, optional desa) at `/api/reports.csv`. Scheduler runs pipeline
  scripts as subprocesses (weather 6 h; full weekly if `SIAGA_EE_PROJECT`).
  Frontend `web/src/workflow.ts` falls back to localStorage when `/api` fails
  (4 s timeout); polls state 15 s, status 60 s. Vite proxies `/api` → :8000.
  No auth: name + role typed by the user.
- Data files are `.json` (not `.geojson`): the claude.ai preview host refuses `.geojson`.
- Raster layers are drawn through a MapLibre canvas source; labels are HTML
  markers (no glyph server). Both keep the app working offline / sandboxed.

## Status

- Stage 0 done: map, 6 layers, ranked action list, detail panel, recommendation,
  WhatsApp text, action workflow + field report form (localStorage only).
- Stage 1 done (2026-11-20): `web/public/data/` holds the rolling series
  Jun–Nov 2026 (`--last-months 6`, EE project `scourge-earth`, ~90 s/month),
  default view Nov 2026 (partial, 2 dates: 3–4 Nov). Month strip, play,
  ←/→ keys, NDDI trend chart, ha-at-risk delta vs previous month all verified
  in the browser. `make_placeholder.py` regenerates sample data if needed.
- 2026 season: Kuat+Ekstrem 5.3k ha (Jun) → 14.3k (Aug) → 28.8k (Sep) →
  34.9k (Oct) → 35.7k (Nov). Winong mean NDDI 0.82 → 7.93, Pucakwangi
  0.87 → 4.75 (single-date stages, before the trajectory fix).
- Trajectory stages (2026-11-20, `config.TRAJECTORY`, series mode only):
  4-month NDVI window per pixel; never greened (peak < 0.35) → 6 bera,
  dropped ≥ 0.25 from an earlier peak ≥ 0.45 to NDVI < 0.25 → 7 panen.
  Both excluded from active rice, shown in UI ("Sawah tidak dihitung aktif",
  top-bar chip). Conservative on purpose: stressed standing crops stay active.
  Exported Jun–Nov 2026 with it: active rice 56.9k → 31.6k ha; Kuat+Ekstrem
  4.9k (Jun) → 11.5k (Aug) → 19.0k (Sep) → 18.8k (Oct) → 14.5k (Nov);
  bera 1.5k → 21.1k, panen peaks Oct 13.1k. Bera clusters in the east/SE
  (Pucakwangi, Jaken, Winong, Batangan): likely rainfed sawah left fallow,
  or failed crop. Top priorities in Nov now Kayen, Sukolilo, Jaken
  (Winong is Awas but has only 1.5k ha active rice left).
  Reproductive stage now detected (Nov 4.4k ha; was ≈ 0). The looser harvest
  rule (no near-bare condition) relabelled 55–75% of Jun–Aug stress as
  harvest, too aggressive.
- Stage 2 done (2026-11-20): Open-Meteo rain (wet season has started: every
  kecamatan 70–160 mm forecast over 14 days, no dry spell) and the what-if.
  Model = NDDI quantile maps from the 2026 dry months (Jun→Jul 8 mm,
  Jul→Agu 16 mm, Agu→Sep 24 mm median rain), replayed on the Nov histogram.
  Result: Kuat+Ekstrem 14.5k → 15.8k (3 das) → 18.5k (6) → 23.1k ha (9);
  Awas 6 → 7 → 8 → 12 kecamatan. Hindcast MAE per kec beats "no change" by
  19 / 41 / 56 % (in-sample in time). Rejected: pixel Markov chain on classes
  (Kuat persistence only 30–60 %, learned noise, drought fell without rain)
  and EE's percentile reducer (coarse buckets; exact 0.05 histograms instead).
- Stage 3 done (2026-11-20): shared action log with roles, field reports per
  desa, scheduled refresh, "data baru" prompt, local fallback. 8 API tests
  pass; verified in the browser (propose → Dinas approve via API → page
  syncs; stale click → 409 + refreshed view; report with desa; Dinas
  "Perbarui sekarang" ran weather.py). Production: FastAPI serves web/dist.
- Aug 2024 video-check run (single period) was done first; its data is in
  git history (commit 1d21c4f), not on disk.
- Verification vs video (Aug 2024): Kuat 12,637 ha (video ≈ 11,000, OK);
  Normal 124 ha (video ≈ 19; tiny class, sensitive); Cluwak lowest at 0.39
  (video 0.3, OK). Top mean NDDI: Batangan 2.43, Pucakwangi 2.06, Jaken,
  Jakenan, Tambakromo 1.57 (video says Tambakromo 2.647 highest: NOT matched).
  Tested masks (cropland only, no mask, stage ranges) and composites (mean,
  no QA mask, L8/L9 only, latest mosaic): Tambakromo stays 1.3–1.8 and the top
  group is stable, so the gap likely comes from the video's boundaries or
  dates, not our method. Open question.
- Growth-stage thresholds (2026-11-20): source is Riska Adinda (2020),
  JIM Pertanian 5(2):301-309, doi:10.17969/jimfp.v5i2.14873. Full text not
  read (jim.usk.ac.id certificate expired). Sensitivity test with bounds
  shifted ±0.05 on Aug 2024 data:
  - Drought ha per class: unchanged (Kuat 12,613 in every variant).
  - Priority ranking: Pucakwangi > Winong always top 2; ranks 3–7 swap.
  - Stressed (Kuat+) ha by stage swings hard: stage 2 from 1.6k to 11.9k ha,
    stage 3 from 4.2k to 14.5k ha, stage 4 ≈ 0. So the recommendation text
    depends on the thresholds.
  - Structural limitation: high NDDI implies low NDVI, so a stressed
    reproductive crop gets labelled as early vegetative. Single-date NDVI
    cannot tell young plants from stressed mature plants. Stage 1 time series
    (NDVI trajectory per pixel) is the real fix.
  - Cropland NDVI in Aug 2024: 80% of pixels between 0.20 and 0.65.

## Next steps

1. Show limitations in the UI: `meta.notes` exists but is not rendered yet.
2. Read Adinda (2020) full text (PDF from the user, or once the journal site
   is fixed) and set `PHENOLOGY_CLASSES` from its table. Sensitivity already
   tested (see Status).
3. Calibrate `TRAJECTORY` thresholds with field reports ("Sudah panen / bera"
   answers); consider 16-day periods so harvest (abrupt) and drought
   (gradual) can be told apart.
4. Stage 2 follow-ups: rain from CHIRPS / BMKG stations instead of model
   points; out-of-sample check of the what-if once the 2027 dry season exists;
   stage aging in the scenario (vegetative → reproductive).
5. Stage 3 follow-ups: real login (at least a PIN per role), deploy (one
   small VM or container with EE service-account credentials), WhatsApp
   delivery tracking. Use field reports to calibrate (feed `/api/reports.csv`
   into the pipeline: exclude reported non-rice desa, tune `TRAJECTORY`).
   Stage 4: ML (rice vs dryland from field reports; NDDI forecast).

## Known limitations (keep visible in UI and slides)

- ESA cropland ≠ wetland rice; southern Pati may be dryland crops → false drought.
- Landsat revisit 16 days minus clouds; data always lags reality.
- Scoring weights and status thresholds are provisional until calibrated.

## Conventions

- Developer: Python for data/ML, TypeScript for frontend.
- UI text in Indonesian; code and comments in English.
- Keep sample-data mode clearly labelled ("DATA SAMPEL" banner).
