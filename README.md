# SIAGA-Padi

**In-season drought response system for extension officers (penyuluh).**
Turns satellite crop-stress data (NDDI) into prioritised, approved and tracked
field actions, and learns from what officers report back.

KS5203 Kecerdasan untuk Sistem Multidisiplin, Proyek Minor (prototype).
Study area: Kabupaten Pati, Jawa Tengah. Method: NgabubuGIS #2 (NDDI).

## Where it sits

| | SICA / Katam | SIAGA-Padi |
|---|---|---|
| Question | When to plant? | Which fields need action this week, and what? |
| Timing | Before the season | During the season, growth-stage aware |
| Output | Planting calendar | Ranked action list, WhatsApp message, action log |
| Loop | One-way | Officer field reports correct the model |

Maturity (P13 test): **digital shadow** with a human-closed feedback loop,
moving toward a twin. Not autonomous: Dinas Pertanian approves every action.

## Repository

```
pipeline/                 Python: data + scoring (single source of truth)
  config.py               every methodological choice (thresholds, weights)
  prepare_boundaries.py   BPS desa polygons -> kecamatan
  scoring.py              hazard index H, status, ha-at-risk, recommendation
  make_placeholder.py     Stage 0: synthetic sample data (clearly labelled)
  gee_export.py           Stage 0/1: real Landsat NDDI via Earth Engine
  weather.py              Stage 2: Open-Meteo rainfall per dasarian + forecast
  scenario.py             Stage 2: "no rain for N dasarian" what-if (Earth Engine)
  feedback.py             Stage 3: field reports -> desa corrections + map-vs-report check
  ml_dataset.py           v2 Phase 2: desa x Landsat-date training data since 2013 (Earth Engine)
  ml_common.py            features shared by training and inference
  ml_train.py             quantile forecast, time split, baselines, model card
  forecast.py             today / +7 / +14 day forecast -> forecast.json
  impact.py               v2 Phase 4: tonnes / rupiah at risk + action options (no Earth Engine)
  anomaly.py              v2 Phase 5: NDDI vs the same month 2013-2025 per desa (no Earth Engine)
  verification.py         v2 Phase 5: all checks in one file for the app's verification page
tools/phone_check.py      phone-size screenshots + overflow report (Chrome DevTools Protocol)
  tests/                  rule tests (no Earth Engine)
  outputs.py              writes the web data contract
server/                   Stage 3: FastAPI backend (shared action log, field reports, scheduler)
  app.py                  API + serves web/dist and the data contract
  store.py                SQLite, append-only (audit trail)
  jobs.py                 scheduled pipeline refresh (weather 6-hourly, full weekly)
  tests/                  API rules (pytest)
data/boundaries/          BPS 2020 boundaries (via HDX)
web/                      TypeScript + Vite + MapLibre frontend
  public/data/            data contract: meta.json, kecamatan.json, desa.json, layers/*.png
                          optional: weather.json, scenario.json (Stage 2)
```

The frontend only reads `web/public/data/`. Sample data and real data use the
same contract, so switching is just re-running a different script.

## Run

```bash
# 1. Python side
python -m venv .venv && source .venv/bin/activate      # Windows: .venv\Scripts\activate
pip install -r pipeline/requirements.txt
python pipeline/prepare_boundaries.py
python pipeline/make_placeholder.py                    # sample data

# 2. Web side
cd web && npm install && npm run dev                   # http://localhost:5173
```

### Real data (Google Earth Engine)

1. Register a **noncommercial** Earth Engine project (Community tier is enough):
   https://code.earthengine.google.com/register
2. `earthengine authenticate`
3. `python pipeline/gee_export.py --project YOUR_PROJECT_ID`
   (defaults to 1–31 Aug 2024 to reproduce the video; use `--start/--end` for other dates)
4. The script prints a check against the video's numbers
   (Kuat ~11,000 ha; Tambakromo mean NDDI ~2.647; Cluwak ~0.3).
5. **Operational run (Stage 1): rolling 6 months up to today**, one composite per
   month (~90 s each; the current month is partial and labelled "berjalan"):
   `python pipeline/gee_export.py --project ID --last-months 6`
   Folders of months that fall out of the window are deleted (retention).
   The web app shows a month slider (← / → keys, play button) and an NDDI trend
   per kecamatan. A fixed range also works: `--series 2024-05:2024-10`.
   Single-period runs (`--start/--end`, used for the Aug 2024 video check) still
   work; the slider just hides.
6. **Rainfall and what-if (Stage 2)**, after step 5:
   `python pipeline/weather.py` (no Earth Engine; safe to run daily) and
   `python pipeline/scenario.py --project ID` (~1 min). Both files are optional:
   without them the rain section and the scenario slider simply do not appear.
7. **ML forecast (v2 Phase 2)**, optional:
   `python pipeline/ml_dataset.py --project ID` (~25 min once, resumable; writes
   git-ignored `data/ml/*.csv`), `python pipeline/ml_train.py` (~3 min; writes
   `data/ml/models/<run>/` with `MODEL_CARD.md`), then `python pipeline/forecast.py`
   (seconds; `--project ID` first adds new Landsat dates). The committed model can
   forecast once `data/ml/obs_*.csv` exists. Without `forecast.json` the forecast
   steps, card and model page do not appear.

### Backend (Stage 3)

```bash
pip install -r server/requirements.txt               # into the same venv as the pipeline
uvicorn server.app:app --port 8000                   # API on :8000; Vite proxies /api in dev
# production: cd web && npm run build, then http://localhost:8000 serves app + data + API
SIAGA_EE_PROJECT=your-project uvicorn server.app:app # also enables the weekly Landsat refresh
python -m pytest server/tests -q                     # role / step / conflict rules
```

- Penyuluh and Dinas Pertanian share one action log and one set of field reports
  (SQLite, `server/siaga.db`, append-only so the log is an audit trail).
- Roles are enforced by the server: a penyuluh proposes, sends, and records follow-up;
  only Dinas approves or cancels an approved action. Two people acting on stale views
  get a conflict, not a silent overwrite. Actions are for the current month only;
  past months are read-only history.
- Field reports carry an optional desa and are exported at `/api/reports.csv`.
- **Reports flow back into the pipeline** (`pipeline/feedback.py`, run by every export):
  - *correction*: a desa with ≥ 2 "Bukan padi" reports that are the majority of its
    reports is taken out of active rice in every month (stage 8, purple in the stage
    layer); later "Sesuai" reports undo it;
  - *check*: each report is compared with the map for that desa (or kecamatan) and
    month. The app marks each report "peta sesuai / berbeda", and
    `feedback.json` holds agreement rates per answer, the evidence for tuning
    `TRAJECTORY` (not auto-tuned yet: too few reports).
  `python pipeline/feedback.py` is a dry run; `gee_export.py --reports file.csv`
  uses a CSV export instead of `server/siaga.db`.
- The scheduler reruns `weather.py` (then `forecast.py` once a model and
  observations exist) every 6 h and, when `SIAGA_EE_PROJECT` is set,
  `gee_export.py --last-months 6` + `scenario.py` + `forecast.py --project` weekly.
- Dinas can **Terima / Tolak** the forecast per kecamatan (`/api/forecast/reviews`,
  tied to one forecast run). A forecast sentence goes into the Gapoktan message only
  when its confidence is Tinggi or Dinas accepted it, never after a rejection. Open pages see a
  "data baru" prompt. Dinas can trigger a refresh from the user dialog.
- Without the server (static hosting) the app falls back to browser storage and says so.

### Deploy on a server (Docker)

One container runs the API, the built web app and the scheduler. Any Linux VM
with Docker works (1 vCPU / 2 GB RAM is enough).

```bash
git clone <repo> siaga-padi && cd siaga-padi
# from your laptop: the forecast's training observations are git-ignored
rsync -av data/ml/*.csv data/ml/obs_done.txt user@server:siaga-padi/data/ml/
docker compose up -d --build            # -> http://<server-ip>:8000
docker compose logs -f                  # scheduler runs rain + forecast on start
```

- Open port 8000 in the VM's firewall / cloud security group
  (`SIAGA_PORT=80 docker compose up -d` to use another port).
- No satellite rerun is needed: the committed `web/public/data/` is served as is.
  Without `data/ml/*.csv` the app still works, but the forecast stays frozen.
- Bind mounts keep state on the host: `web/public/data/` (rewritten by the
  scheduler), `data/ml/`, and `var/siaga.db` (actions, reports, reviews; back it up).
  Before `git pull`, `git stash` the rewritten data files.
- Weekly Landsat refresh: set `SIAGA_EE_PROJECT` (e.g. in `.env`) and mount an
  Earth Engine login (`~/.config/earthengine`, commented in `docker-compose.yml`).
  Not tested inside the container yet.
- No login yet: anyone with the URL can act as Dinas. Share the address only
  with testers, or put it behind a reverse proxy with basic auth + HTTPS.
- One worker only (the scheduler lives in the app process).

## Method

1. Landsat 8/9 TOA (C2), cloud cover < 30 %, QA_PIXEL cloud/shadow mask, median mosaic.
2. NDVI = ND(B5, B4); NDMI = ND(B5, B6); NDDI = (NDVI − NDMI)/(NDVI + NDMI) via `.expression()`.
3. Cropland mask: ESA WorldCover v200, class 40.
4. Growth stage, keep active stages (early veg, late veg, reproductive):
   - single-period run (video check): single-date NDVI thresholds;
   - series run (operational): each pixel's monthly NDVI over a 4-month window.
     Never greened → *bera / tidak tumbuh*; dropped to near-bare after a peak →
     *panen / pasca-panen*; both excluded from active rice and shown separately
     for field checking. A harvest-like drop after strong stress (or too soon
     after green-up) is *panen atau puso? (perlu cek)*: a drought-killed crop
     looks like a harvest, so it is flagged for a field check instead of
     silently leaving the priorities. Rules and thresholds in `config.TRAJECTORY`.
5. NDDI guard |NDDI| < 100, then 5 classes (Artikanur et al., 2022).
6. Per kecamatan: hectares by class × stage (`pixelArea`, 30 m).
7. Impact scoring (`scoring.py`), H-MHEWS-style: hazard combined with exposure.
   - H = mean class hazard weight on active rice → status Normal / Waspada / Siaga / Awas
   - ha at risk = Σ area × class hazard × stage vulnerability → ranking

8. Rainfall (Stage 2, `weather.py`): Open-Meteo at each kecamatan's label point.
   Past 92 days + 16-day forecast, summed per dasarian (BMKG's 10-day unit;
   < 50 mm = dry dasarian), plus days without rain (< 1 mm/day, BMKG classes).
9. What-if "no rain for N dasarian" (Stage 2, `scenario.py`), calibrated on our
   own series. Month pairs whose second month was nearly dry (median archive
   rain < 40 mm: Jun→Jul, Jul→Aug, Aug→Sep 2026) each give a quantile map of
   NDDI on rice that was active in both months ("p-th percentile before →
   p-th percentile after"). The scenario replays dry month 1, 2, 3 (3 dasarian
   each, linear within the month) on each kecamatan's current NDDI histogram,
   then re-scores with `scoring.py`. Hindcast per kecamatan (Kuat+Ekstrem ha):
   MAE 134 / 153 / 225 ha vs 166 / 261 / 507 ha for a "no change" baseline.
   A pixel-level Markov chain on classes was tried first and rejected: pixels
   keep the Kuat class only 30–60 % of the time month to month, so the chain
   learned noise and predicted drought would *fall* without rain.
10. Field reports (Stage 3, `feedback.py`): desa reported "bukan padi" (≥ 2 reports,
   majority) leave active rice as stage 8; every report is checked against the map.
11. Irrigation capacity (v2 Phase 3): official 2024 irrigated / rainfed sawah per
   kecamatan (`irrigation.py`), validated against a dry-season satellite proxy
   (`water_access.py`, Spearman 0.62–0.67). Ranking = ha at risk × (1 − 0.3 ×
   irrigated share); recommendations split by water source. Never-greened land
   surrounded by green fields is flagged *gagal tanam? (perlu cek)*.
12. Forecast (v2 Phase 2, `ml_*.py`, `forecast.py`): per desa, the Kuat+Ekstrem share
   of active rice and the hazard index H 8–40 days after a Landsat date, as
   P10/P50/P90 (gradient-boosted quantile trees, scikit-learn). Features: NDDI state
   and trend, stage shares, rain before and during the window (Open-Meteo), official
   irrigation, season, horizon. Trained ≤ 2022, validated 2023, tested 2024–Nov 2026
   against persistence and climatology (results in `MODEL_CARD.md` and the app's
   "Tentang model" page). Kecamatan values aggregate desa by active rice; ha = share ×
   the map's active rice; status from H with the map's thresholds.

13. Impact (v2 Phase 4, `impact.py`): production at risk = ha at risk × Pati yield
   (BPS 2024, 54.63 ku/ha GKG, ±10 %) × GKG price Rp 8,000 (HPP) – 8,600 (market),
   always a range. Action options with target ha and saved tonnes / rupiah: pumps
   (10–30 ha per 4-inch pump) on the rainfed part, water rotation on the irrigated
   part, delayed planting on rainfed fallow. "Dasbor Dinas" summarises the kabupaten
   and lists cases needing attention with owner and age.

14. Anomaly and verification (v2 Phase 5): each desa's monthly NDDI on active rice
   vs the same month 2013–2025 (z score) as a map layer; one verification page
   with the video check, capacity proxy, scenario hindcast, forecast skill and
   field-report agreement, including the checks that did not pass.

## Known limitations (state these in the presentation)

- **Growth-stage NDVI thresholds are provisional** (`config.py`; Adinda 2020 full text
  not yet read). They do not change drought hectares, but they do change which stage
  stressed fields are assigned to.
- **Fallow vs. failed crop.** In series mode a field that never greened is labelled
  fallow, but it may be rice that failed to establish because of drought. The UI
  says so and asks for a field report. Single-period runs still use single-date
  NDVI, which confuses young rice with stressed mature rice.
- **Cropland ≠ wetland rice.** ESA class 40 includes corn, sugarcane, cassava, which
  read as false extreme drought. Southern Pati (Tambakromo, Winong, Pucakwangi) may
  be affected. Field feedback is the planned fix.
- **Revisit gap.** Landsat every 16 days minus clouds; the map always lags reality.
- Scoring weights are expert guesses until calibrated with field reports.
- **What-if is a stress test, not a forecast.** It replays one dry season (2026),
  holds growth stage, active area and irrigation fixed, and its hindcast is
  in-sample in time. The raster layers keep showing the last image.
- **Rainfall is model data at one point per kecamatan** (Open-Meteo best-match
  NWP / ERA5), not rain gauges; BMKG station or CHIRPS data would be better.
- **The forecast is trained on single-date stages**, not the map's 4-month trajectory,
  and on observed rain; at run time the rain is a forecast. Wet-season onset after a
  drought is rare in the training data, so ranges are wide then. It forecasts an NDDI
  class, not crop loss.
- **Rupiah figures are estimates of production at risk, not losses.** They rest on
  ha at risk (provisional weights), one annual yield, and price assumptions; option
  efficacies are assumptions until field reports calibrate them.
- **No login yet.** Users type a name and pick a role; the server enforces what each
  role may do, but anyone can claim either role. Accountability, not security.

## Roadmap

| Stage | Adds |
|---|---|
| 0 ✅ | Map, layers, ranked actions, recommendation, WhatsApp text, action log (local) |
| 1 ✅ | Time slider: monthly dry-season series, NDDI trend per kecamatan |
| 2 ✅ | Rainfall per dasarian + 16-day forecast (Open-Meteo); calibrated what-if "no rain for N dasarian" |
| 3 ✅ | Backend (FastAPI + SQLite): shared action log with roles, field reports per desa, scheduled pipeline |
| v2 | Phases 0–5 ✅ (see docs/ROADMAP-v2.md): puso/gagal tanam flags, timeline + tour + freshness, ML forecast with Dinas review, irrigation capacity, tonnes / rupiah + options + Dinas cockpit |
| next | Real field reports → calibration; login; deployment |

## Sources

- Izzuddin Muhammad (2026). NgabubuGIS #2: Pemetaan Kekeringan Pertanian Menggunakan NDDI.
- Artikanur et al. (2022): NDDI drought classes. Adinda (2020): NDVI rice phenology.
- Susandi et al. (2018): H-MHEWS impact index. WMO (2015) No. 1150: impact-based forecasting.
- Fan et al. (2021); Kritzinger et al. (2018): digital twin maturity.
- Boundaries: BPS 2020 via HDX (github.com/JfrAziz/indonesia-district).
