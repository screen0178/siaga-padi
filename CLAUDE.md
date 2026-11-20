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
  `web/src/weather.ts` (rain bars, scenario curve); the what-if starts from
  "Uji skenario" in the detail panel, its slider sits in a yellow bar above
  the timeline while on, and it mutates props like period switching; messages to
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
- v2 Phase 2 forecast: `pipeline/ml_dataset.py` (EE, desa × Landsat date,
  git-ignored `data/ml/obs_*.csv`, `rain_daily.csv`, `desa_static.csv`),
  `ml_common.py` (features, shared), `ml_train.py` (→ committed
  `data/ml/models/<run>/model.pkl` + metrics + MODEL_CARD, `LATEST`),
  `forecast.py` (→ `forecast.json`: steps now/+7/+14, per kecamatan
  share/ha/hazard P10-P50-P90, status, confidence, reasons, model metrics).
  Server: `forecast_reviews` table, GET/POST `/api/forecast/reviews` (Dinas
  only, 409 if the forecast changed). Frontend `web/src/forecast.ts` (card,
  model page, message sentence); forecast view mutates props like the
  scenario (status, H, rank) and is exclusive with it.
- v2 Phase 4 impact: `pipeline/impact.py` (config `IMPACT`, `ACTION_OPTIONS`)
  annotates the written files in place (no EE): `impact` {ha_eq, t, rp as
  [low, mid, high]} on kecamatan props, each series entry, meta totals and
  periods, scenario steps; `options` (pump / rotation / delay) on top-level
  props = current period only. Called at the end of `outputs.write_run` and
  `scenario.py`. Frontend `web/src/impact.ts` (detail section), 
  `web/src/cockpit.ts` ("Dasbor Dinas" dialog, top-bar button, all roles).
- v2 Phase 5: `pipeline/anomaly.py` (→ `anomaly.json`, desa/kec NDDI z vs
  the same month 2013–2025 from `data/ml/obs_*.csv`, no EE) and
  `pipeline/verification.py` (→ `verification.json`, gathers video check from
  `config.VIDEO_CHECK`, capacity proxy, scenario hindcast, forecast metrics,
  feedback). Both run in the weekly job. Frontend: map layer "anomaly" is a
  desa fill driven by feature-state (`api.setDesaValues`), `web/src/verify.ts`
  (page opened from the freshness badge, cockpit, detail). main.ts split:
  `util.ts`, `sections.ts`, `tourSteps.ts`, `legend.ts`. Phone check:
  `tools/phone_check.py` (Chrome DevTools Protocol, 390×844 mobile).
- Reports → pipeline: `pipeline/feedback.py` (rules in `config.FEEDBACK`).
  gee_export loads reports (server/siaga.db or `--reports csv`), paints
  corrected desa to stage 8 in `build(exclude=)` for all periods, checks
  each report against desa/kec stats of its month (`report_views`), writes
  `feedback.json` (optional contract file). scenario.py reuses the
  exclusions listed in feedback.json, so N=0 still matches the map.
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
- Reports into pipeline done (2026-11-20): verified with 5 test reports in
  Kayen on an Oct–Nov EE run (then restored the committed data, deleted the
  test reports): Beketel 53.3 of 53.8 ha cropland → stage 8 (border pixels
  stay), purple only inside Beketel in stage.png; check results ok 1/1,
  not_rice 2/2, harvested 0/1 (map 16 % inactive), irrigated 0/1. The UI
  detail panel was checked before the last two text tweaks (tooltip for
  corrected desa, chip renamed "Sawah tidak aktif"); those were type-checked
  only. No real reports yet, so committed data has no feedback.json.
- v2 Phase 0 (2026-11-20):
  - 0.1 race fixed: workflow writes use `BEGIN IMMEDIATE` (`store.conn(write=True)`);
    test fires two simultaneous identical steps → exactly one 200, one 409
    (failed with two 200s before the fix).
  - 0.2 stage 9 "panen atau puso? (perlu cek)": a harvest-like drop (rule 7)
    where NDDI ≥ 1.25 in a month from the peak on while the crop still stood
    (NDVI ≥ 0.25; bare months skipped because bare soil reads as high NDDI),
    or the drop came ≤ 1 month after green-up. Monthly NDDI history added to
    `month_ndvi`. Not active, not ranked; shown as "Perlu verifikasi" in the
    detail panel, a ⚠ badge on the priority list (≥ 25 ha), orange in the
    stage layer, and a new report answer "Puso / gagal panen karena kering"
    (feedback.py checks it against the map's puso share). Re-export Jun–Nov:
    7+9 equals the old 7 exactly; active and Kuat+Ekstrem unchanged.
    Share of drops flagged 9: Jun 1 %, Jul 12 %, Aug 26 %, Sep 35 %,
    Oct 46 %, Nov 49 % (6.0k ha in Oct). Highest in the dry south/east (Oct:
    Tambakromo 65 %, Winong 68 %), lowest in the wetter north (Gembong,
    Cluwak, Margoyoso ~10 %). June's 1 % suggests normal ripening rarely
    triggers it, but senescence does raise NDDI: it is a check flag, not a
    puso estimate. Nov top: Sukolilo 780 ha, Gabus 673, Kayen 543.
    Stage 10 "gagal tanam?" waits for the Phase 3 irrigation layer.
  - Browser: priority-list badges verified; the detail section was only
    type-checked (pane hidden, map never loaded).
- v2 Phase 3 (2026-11-20), irrigation capacity:
  - 3.1 `pipeline/irrigation.py` parses the 2024 XLSX (user-downloaded) into
    `data/irrigation/irigasi_2024_per_kecamatan.csv`; totals match the tables
    (35,408.3 ha irrigated, 21,976.2 rainfed). Most rainfed: Pucakwangi 92 %,
    Batangan 89 %, Jaken 86 %. Sukolilo (85 % irrigated) and Kayen (72 %)
    grow 0 % rice 3x/year: "irrigated" ≠ dry-season water.
  - 3.2 `pipeline/water_access.py`: share of ESA cropland with NDVI ≥ 0.45 in
    Aug or Sep 2026 (rule fixed before validation). Spearman vs official
    irrigated share 0.62, vs rice-3x share 0.67; variants (Jul–Sep, 0.40,
    0.50) 0.60–0.74. Also ESA cropland vs official sawah per kec r = 0.97,
    totals 59.3k vs 57.4k ha: the cropland mask matches sawah at kec level.
  - 3.3 scoring: priority = ha_at_risk × (1 − 0.3 × official irrigated share);
    status unchanged. Official share, not the proxy, because the proxy comes
    from the same NDVI as the hazard (double counting). Nov ranking: Kayen,
    Jaken (3→2), Tambakromo (5→3), Gabus, Sukolilo (2→5), Pucakwangi (8→6).
    Recommendation water steps by source (irigasi: gilir air / P3A;
    tadah hujan: pompa sumur dangkal / embung, tunda tanam, genjah;
    campuran: both, labelled by block). Detail panel "Kapasitas air".
  - Stage 10 "gagal tanam?": rule 6 (never greened) where ≥ 50 % of cropland
    within 300 m greened (peak ≥ 0.45). Re-export: 6+10 = old 6 every month;
    active, Kuat+Ekstrem, scenario totals unchanged. Small: Nov 518 ha (2 % of
    never-green), Oct 1.1k (14 %). Mostly isolated fields in the irrigated
    north (Tayu 41 %, Gunung Wungkal 50 %); ~0 in the dry SE because whole
    areas never greened, so there are no green neighbours. It catches single
    failed fields, not area-wide failure; Nov bera in rainfed areas is
    expected anyway (planting waits for rain).
  - New report answer "Gagal tanam / bibit mati karena kering"; 20 tests.
  - Verified with headless Chrome (`--dump-dom` / `--screenshot` with
    swiftshader), which works while the app's browser pane is hidden;
    renders sometimes time out before the map loads, just rerun.
- v2 Phase 1 (2026-11-20), frontend only, no contract change:
  - 1.3 freshness badge (`web/src/fresh.ts`): latest scene date and age
    (green ≤ 16 d, amber ≤ 32 d, red beyond) and rain update age (≤ 12 h /
    ≤ 36 h); re-rendered every minute. Now: scene 4 Nov, 16 days.
  - 1.1 timeline: "Hari ini" marker after the months ("citra terakhir 4 Nov,
    16 hari lalu", coloured by scene age, click = current month). The
    what-if left the ranking panel (see Architecture). Side panels now end
    above the bottom bar via a measured `--lb-h`. Forecast segment, P10-P90
    and the forecast sentence in messages wait for Phase 2 forecast.json.
  - 1.2 guided tour (`web/src/tour.ts`): 8 steps (welcome, layers, timeline,
    summary + freshness, priorities, detail, workflow, reports + identity),
    auto-starts on first visit unless the URL has a kecamatan hash, "Pemandu"
    button in the top bar, ←/→/Esc. Updated after Phase 2: 10 steps when
    forecast.json exists (+ "Prakiraan 14 hari" on the timeline, + "Kartu
    prakiraan dan tinjauan Dinas" in the detail panel; timeline, summary and
    detail texts revised). Seen flag `siaga.tour.v2`: bump the key whenever
    the steps change materially, so returning users see the new tour once.
    Rule: any UI phase that adds a visible feature updates the tour.
  - Verified in the app's browser pane at 1440×900 (all 8 steps, scenario
    on/off, Hari ini jump). Phone width not verified: the pane's mobile
    emulation misrenders and headless Chrome cannot go below ~500 px; the
    timeline already overflowed phones before (Phase 5.3).
- v2 Phase 2 (2026-11-20), ML forecast:
  - Data: 664 Landsat dates Apr 2013 – 4 Nov 2026 (cloud < 70 %, 4 path/rows),
    631 with usable desa, 396 desa, 114k desa-dates; 22 min with 6 workers.
    Rain from the Open-Meteo archive per kecamatan (not CHIRPS: inference uses
    Open-Meteo too). Pairs h = 8–40 days: train 79k (≤ 2022), val 45k (2023),
    test 92k (2024–Nov 2026); recent years have more because of Landsat 9.
  - Model: scikit-learn HistGradientBoosting quantile (LightGBM needs a
    system libomp on macOS), 400 trees chosen on validation, refit on all
    years for production; metrics from the held-out model.
  - Test: desa share MAE 6.8 vs persistence 8.5 vs climatology 9.9 points;
    kecamatan Kuat+Ekstrem MAE 89 vs 124 vs 143 ha; status match 89 % vs
    85 %; Siaga/Awas hit rate 77 % vs 58 %, false alarm ratio 10 % vs 16 %;
    P10-P90 coverage desa 84 %, kecamatan 90 % (summed quantiles are
    conservative). Future rain replaced by climatology: kec MAE 97 ha (lower
    bound). Gain over persistence grows with horizon (8–16 d: 5.5 vs 5.9;
    29–40 d: 8.2 vs 11.2 points). Importance: NDDI state ≫ past rain >
    irrigation > future rain > season.
  - First forecast (20 Nov, from 3–4 Nov scenes, 383 desa): wet season has
    started (230–290 mm to 4 Dec), Kuat+Ekstrem 12.1k ha now → 7.3k (+7) →
    6.0k (+14) vs 14.5k on the Nov map; no Awas by +14. P10 = 0 everywhere
    and confidence mostly Rendah: checked, real — after ≥ 150 mm in ~2 weeks
    past desa at ≥ 60 % stress ended at median 48 %, P10 3 % (only 127 such
    pairs, so the onset regime is thin in training).
  - Verified in the browser: forecast steps on the timeline, map/ranking/top
    bar switch, detail card, model page, Terima/Tolak against the real
    server (message sentence appears after Terima, disappears after Tolak;
    test reviews deleted), tour step 4 of 9. The scheduler's weather job ran
    forecast.py by itself. 10 server + 13 pipeline tests pass.
- v2 Phase 4 (2026-11-20), impact + options + Dinas cockpit:
  - Sources: Pati 2024 yield 54.63 ku/ha GKG (BPS Jateng table, 96,537 ha,
    527,355 t; read in the browser, the page renders by JS); HPP GKG at mill
    Rp 8,000/kg (Kepbadan 2/2025), HPP GKP Rp 6,500 kept for 2026 (Inpres
    4/2026); GKP market ~Rp 7,000 in Jul 2026 (Bapanas) → high price 8,600
    (assumption). Pump 4 inch ~10 ha static, ~30 ha moved (Kementan pump
    aid, Indramayu 2024). Efficacies (pump 50–80 %, rotation 20–40 %) and
    yield ±10 % are assumptions, labelled as such in the UI.
  - Production at risk = ha_at_risk × yield, read as hectare-equivalents of
    lost harvest (ha_at_risk already weighs hazard × stage). Nov 2026:
    51.6–63.1k t GKG, Rp 413–543 bn (≈ 11 % of Pati's 2024 output); peak
    Sep 104k t, Rp 860 bn (mid).
  - Options Nov: rainfed-heavy Jaken / Pucakwangi 9–26 pumps for ~255 ha
    (Rp 3–7 bn saved); irrigated Kayen mostly gilir air (1,296 ha, Rp 5–13
    bn); delay planting for rainfed fallow (Pucakwangi 3.2k ha), with a
    note "syarat tanam mulai terpenuhi" when the 16-day rain forecast ≥ 100 mm.
  - Cockpit: tiles (Kuat+Ekstrem + delta vs previous month, kecamatan per
    status, value at risk, actions incl. "menunggu Dinas" and Siaga/Awas not
    yet acted on, +14 forecast), alert list (Siaga/Awas now or forecast, or
    action in progress) with owner (last actor), age (since last event, else
    since data processed), next need; proposals awaiting Dinas on top; row
    click opens the detail. Always describes the current month, observed.
  - Tour now 12 steps (+ "Dampak dan opsi tindakan", + "Dasbor Dinas"),
    seen key `siaga.tour.v3`. Verified in the browser at 1440×900 with a
    test proposal via the API (deleted afterwards); 15 pipeline tests pass.
- v2 Phase 5 (2026-11-20), verification and polish:
  - 5.2 anomaly: Jun–Sep 2026 near normal for the season (median desa z
    +0.2 / +0.3 / −0.0 / +0.3), Oct +0.8 (40 % of desa z > 1), Nov +1.4
    (69 %): the 2026 drought is unusual because it lasted into Oct–Nov, when
    rice is normally green. Nov: Winong z +2.2 (NDDI +5.3), Gembong +2.3,
    Jaken +1.8. Single-date stage masks as in the ML data (relative signal).
  - 5.1 verification page: video 2/4 matched (Kuat, Cluwak lowest; Normal
    tiny class, Tambakromo not matched), capacity ρ 0.62 + cropland~sawah r
    0.97 (scatter), scenario hindcast beats "no change" in all 3 months,
    forecast −28 % kec error vs persistence, reports 1 (needs ≥ 20).
  - 5.3 phones: the timeline row (~760 px) made phones zoom the whole page
    out (innerWidth 768 on a 390 px screen) and the map fit used a 380 px
    desktop padding (showed the world). Fixed: scrolling timeline/layer rows,
    caption hidden, bottom-sheet ranking, detail slides up, map padding by
    width, tour card docks top/bottom away from its target. Checked with
    tools/phone_check.py (true mobile emulation; the app's pane and plain
    headless Chrome cannot): width 390, map fits Pati, detail, cockpit, tour.
    main.ts 1,089 → 878 lines.
  - Tour key `siaga.tour.v4` (layers step mentions the anomaly layer, summary
    step the verification page).
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

**Active plan: docs/ROADMAP-v2.md (phases 0-5). It supersedes the list below where they overlap.**

1. Read Adinda (2020) full text (PDF from the user, or once the journal site
   is fixed) and set `PHENOLOGY_CLASSES` from its table. Sensitivity already
   tested (see Status).
2. Calibrate `TRAJECTORY` thresholds with field reports ("Sudah panen / bera"
   answers); consider 16-day periods so harvest (abrupt) and drought
   (gradual) can be told apart.
3. Stage 2 follow-ups: rain from CHIRPS / BMKG stations instead of model
   points; out-of-sample check of the what-if once the 2027 dry season exists;
   stage aging in the scenario (vegetative → reproductive).
4. Stage 3 follow-ups: real login (at least a PIN per role), deploy (one
   small VM or container with EE service-account credentials), WhatsApp
   delivery tracking. Once enough "Sudah panen / bera" reports exist, tune
   `TRAJECTORY` from feedback.json agreement (now reported, not auto-tuned).
   Stage 4: ML (rice vs dryland from field reports; NDDI forecast).

## Known limitations (keep visible in UI and slides)

- ESA cropland ≠ wetland rice; southern Pati may be dryland crops → false drought.
- Landsat revisit 16 days minus clouds; data always lags reality.
- Scoring weights and status thresholds are provisional until calibrated.

## Conventions

- Developer: Python for data/ML, TypeScript for frontend.
- UI text in Indonesian; code and comments in English.
- Keep sample-data mode clearly labelled ("DATA SAMPEL" banner).
