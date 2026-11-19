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

- Kabupaten Pati, Aug 2024 first (reproduces NgabubuGIS #2), then 2026 El Niño.
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
- Data files are `.json` (not `.geojson`): the claude.ai preview host refuses `.geojson`.
- Raster layers are drawn through a MapLibre canvas source; labels are HTML
  markers (no glyph server). Both keep the app working offline / sandboxed.

## Status

- Stage 0 done: map, 6 layers, ranked action list, detail panel, recommendation,
  WhatsApp text, action workflow + field report form (localStorage only).
- `gee_export.py` **runs** (EE project `scourge-earth`, 2026-11-20): Aug 2024,
  14 Landsat 8/9 scenes, ~85 s. `web/public/data/` now holds real data (`mode: gee`).
  `make_placeholder.py` regenerates sample data if needed.
- Verification vs video (Aug 2024): Kuat 12,637 ha (video ≈ 11,000, OK);
  Normal 124 ha (video ≈ 19; tiny class, sensitive); Cluwak lowest at 0.39
  (video 0.3, OK). Top mean NDDI: Batangan 2.43, Pucakwangi 2.06, Jaken,
  Jakenan, Tambakromo 1.57 (video says Tambakromo 2.647 highest: NOT matched).
  Tested masks (cropland only, no mask, stage ranges) and composites (mean,
  no QA mask, L8/L9 only, latest mosaic): Tambakromo stays 1.3–1.8 and the top
  group is stable, so the gap likely comes from the video's boundaries or
  dates, not our method. Open question.

## Next steps

1. Run `earthengine authenticate`, then
   `python pipeline/gee_export.py --project <EE project id>`, fix errors,
   compare with the video reference values.
2. Verify growth-stage NDVI thresholds (`PHENOLOGY_CLASSES`, only −0.03 is
   confirmed) against the video / Adinda (2020).
3. Stage 1: time slider over a dry-season series + NDDI trend per kecamatan
   (extend contract with a `periods` list; keep backward compatible).
4. Stage 2: Open-Meteo rainfall forecast + what-if scenario (no rain for N
   dasarian → hectares shifting class).
5. Stage 3: FastAPI backend for shared action log + field reports; scheduled
   pipeline. Stage 4: ML (rice vs dryland from field reports; NDDI forecast).

## Known limitations (keep visible in UI and slides)

- ESA cropland ≠ wetland rice; southern Pati may be dryland crops → false drought.
- Landsat revisit 16 days minus clouds; data always lags reality.
- Scoring weights and status thresholds are provisional until calibrated.

## Conventions

- Developer: Python for data/ML, TypeScript for frontend.
- UI text in Indonesian; code and comments in English.
- Keep sample-data mode clearly labelled ("DATA SAMPEL" banner).
