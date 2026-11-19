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
  outputs.py              writes the web data contract
data/boundaries/          BPS 2020 boundaries (via HDX)
web/                      TypeScript + Vite + MapLibre frontend
  public/data/            data contract: meta.json, kecamatan.json, desa.json, layers/*.png
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

## Method

1. Landsat 8/9 TOA (C2), cloud cover < 30 %, QA_PIXEL cloud/shadow mask, median mosaic.
2. NDVI = ND(B5, B4); NDMI = ND(B5, B6); NDDI = (NDVI − NDMI)/(NDVI + NDMI) via `.expression()`.
3. Cropland mask: ESA WorldCover v200, class 40.
4. Growth stage, keep active stages (early veg, late veg, reproductive):
   - single-period run (video check): single-date NDVI thresholds;
   - series run (operational): each pixel's monthly NDVI over a 4-month window.
     Never greened → *bera / tidak tumbuh*; dropped to near-bare after a peak →
     *panen / pasca-panen*; both excluded from active rice and shown separately
     for field checking. Rules and thresholds in `config.TRAJECTORY`.
5. NDDI guard |NDDI| < 100, then 5 classes (Artikanur et al., 2022).
6. Per kecamatan: hectares by class × stage (`pixelArea`, 30 m).
7. Impact scoring (`scoring.py`), H-MHEWS-style: hazard combined with exposure.
   - H = mean class hazard weight on active rice → status Normal / Waspada / Siaga / Awas
   - ha at risk = Σ area × class hazard × stage vulnerability → ranking

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
- Stage 0 workflow/feedback is stored in the browser only.

## Roadmap

| Stage | Adds |
|---|---|
| 0 ✅ | Map, layers, ranked actions, recommendation, WhatsApp text, action log (local) |
| 1 ✅ | Time slider: monthly dry-season series, NDDI trend per kecamatan |
| 2 | Rainfall forecast (Open-Meteo) + what-if scenarios (no rain for N dasarian) |
| 3 | Backend (FastAPI): shared action log, officer field reports, scheduled pipeline |
| 4 | ML: rice vs. dryland classifier from field reports; NDDI 1–2 dasarian forecast |

## Sources

- Izzuddin Muhammad (2026). NgabubuGIS #2: Pemetaan Kekeringan Pertanian Menggunakan NDDI.
- Artikanur et al. (2022): NDDI drought classes. Adinda (2020): NDVI rice phenology.
- Susandi et al. (2018): H-MHEWS impact index. WMO (2015) No. 1150: impact-based forecasting.
- Fan et al. (2021); Kritzinger et al. (2018): digital twin maturity.
- Boundaries: BPS 2020 via HDX (github.com/JfrAziz/indonesia-district).
