"""Shared configuration for the SIAGA-Padi pipeline.

Everything that encodes a methodological choice lives here, so it can be cited,
changed and calibrated in one place.
"""

from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
BOUNDARY_DIR = ROOT / "data" / "boundaries"
WEB_DATA_DIR = ROOT / "web" / "public" / "data"

# --- Study area -------------------------------------------------------------
REGION = {
    "id": "id3318",
    "name": "Kabupaten Pati",
    "province": "Jawa Tengah",
}

# --- Analysis window (reproduces NgabubuGIS #2: dry season, August 2024) ----
DEFAULT_START = "2024-08-01"
DEFAULT_END = "2024-08-31"
MAX_CLOUD_PCT = 30

# --- NDDI drought classes (Artikanur et al., 2022) --------------------------
# (class_id, lower_bound, upper_bound, label_id, label_en, color)
NDDI_CLASSES = [
    (1, float("-inf"), -2.0, "Normal", "Normal", "#2b83ba"),
    (2, -2.0, 0.7, "Ringan", "Mild", "#abdda4"),
    (3, 0.7, 1.25, "Sedang", "Moderate", "#fdae61"),
    (4, 1.25, 3.0, "Kuat", "Strong", "#e8553d"),
    (5, 3.0, float("inf"), "Sangat Ekstrem", "Extreme", "#8b0a1a"),
]

# Pixels with |NDDI| above this come from NDVI + NDMI ~ 0 (division blow-up,
# cloud edges, water). The video uses NDDI.lt(100); we guard both sides.
NDDI_ABS_GUARD = 100

# --- Rice growth-stage classes from NDVI (Adinda, 2020) ---------------------
# Source: Riska Adinda (2020), Jurnal Ilmiah Mahasiswa Pertanian 5(2):301-309,
# doi:10.17969/jimfp.v5i2.14873. Full text not yet read (journal site's TLS
# certificate expired on 2026-11-20), so only the class-1 bound (-0.03, from
# the video) is confirmed; the rest are provisional.
# Sensitivity test on Aug 2024 data (bounds shifted by +/-0.05, see CLAUDE.md):
#  - drought hectares per NDDI class: unchanged (stressed pixels have low NDVI);
#  - priority ranking: top 2 unchanged, ranks 3-7 swap;
#  - stage of stressed fields (and thus the recommendation text) swings a lot.
PHENOLOGY_CLASSES = [
    (1, float("-inf"), -0.03, "Bera / terbuka / air", False),
    (2, -0.03, 0.25, "Vegetatif awal", True),
    (3, 0.25, 0.45, "Vegetatif akhir", True),
    (4, 0.45, 0.65, "Reproduktif", True),
    (5, 0.65, float("inf"), "Pematangan", False),
]

# --- Growth stage from the NDVI trajectory (series mode) --------------------
# A single NDVI value cannot tell young rice from stressed mature rice, or a
# fallow field from either. In series mode each pixel's monthly NDVI medians
# over a 4-month window (about one rice cycle) decide the stage instead:
#   fallow      peak NDVI in the window < fallow_peak_max: never greened
#               (fallow, not planted, or failed to establish) -> stage 6
#   harvested   peaked >= harvest_peak_min in an earlier month, now at least
#               harvest_drop below the peak AND near-bare (< harvest_ndvi_max)
#               -> stage 7
#   otherwise active: NDVI < 0.30 -> 2, < 0.50 -> 3, >= 0.50 -> 4; rising and
#               >= 0.50 -> 3 (still growing); falling after a real peak -> 4
#               (grain filling or stressed reproductive rice).
# Deliberately conservative: a stressed crop that is still standing stays
# active, because hiding real drought is worse than a false alarm. Officers
# correct the rest with the "Sudah panen / bera" field report.
# Effect on Kuat+Ekstrem area, 2026 (prototype test): Aug 14.2k -> 11.5k ha,
# Oct 34.8k -> 18.8k, Nov 35.6k -> 14.5k (Nov: 49% fallow, 10% harvested).
TRAJECTORY = {
    "window_months": 4,
    "fallow_peak_max": 0.35,
    "harvest_peak_min": 0.45,
    "harvest_drop": 0.25,
    "harvest_ndvi_max": 0.25,
    "trend_eps": 0.05,
}
# Extra, non-active stage classes that only exist in series mode
TRAJECTORY_CLASSES = [
    (6, None, None, "Bera / tidak tumbuh", False),
    (7, None, None, "Panen / pasca-panen", False),
]

# --- Field reports back into the pipeline (Stage 3) -------------------------
# Officers' "Laporan cek lapangan" (server/siaga.db, or a CSV from
# /api/reports.csv) correct the map in one way and are checked in another:
#   correction  a desa with >= exclude_min_reports "Bukan padi" reports that
#               make up >= exclude_share of its reports is taken out of active
#               rice for the whole window (land use does not change monthly):
#               its cropland becomes stage 8. Newer "Sesuai" reports can
#               undo it. Whole-desa granularity is coarse on purpose: reports
#               name a desa, not a field polygon.
#   check       every report is compared with what the map said for that
#               desa (or kecamatan) in that month, giving agreement rates per
#               answer. "Sudah panen / bera" agreement is the calibration
#               signal for TRAJECTORY; it is reported, not auto-tuned, until
#               there are enough reports.
FEEDBACK = {
    "db": ROOT / "server" / "siaga.db",
    "exclude_min_reports": 2,
    "exclude_share": 0.5,
    # What counts as "the map said so" when checking a report
    "stressed_share": 0.25,   # Kuat+Ekstrem share of active rice
    "inactive_share": 0.5,    # bera+panen(+excluded) share of cropland
}
FEEDBACK_CLASSES = [
    (8, None, None, "Bukan padi (laporan lapangan)", False),
]

# --- Impact scoring (rule-based, Stage 0) -----------------------------------
# Inspired by the H-MHEWS impact index (Susandi et al., 2018): hazard is
# combined with exposure before a status is assigned. Weights are provisional
# and are meant to be calibrated with officer field feedback (Stage 3/4).
STAGE_VULNERABILITY = {  # how much a hectare in each stage counts as exposed
    2: 0.5,  # vegetatif awal
    3: 0.7,  # vegetatif akhir
    4: 1.0,  # reproduktif: most drought-sensitive
}
CLASS_HAZARD = {1: 0.0, 2: 0.1, 3: 0.5, 4: 0.85, 5: 1.0}
STATUS_THRESHOLDS = [  # on the hazard index H in [0, 1]
    (0.40, "Normal"),
    (0.60, "Waspada"),
    (0.75, "Siaga"),
    (float("inf"), "Awas"),
]

# --- Weather (Stage 2, Open-Meteo) ------------------------------------------
WEATHER = {
    "past_days": 92,          # forecast API history window
    "forecast_days": 16,      # Open-Meteo maximum
    "obs_dasarian": 6,        # dasarian shown before (and incl.) the current one
    "dry_day_mm": 1.0,        # BMKG: a day without rain has < 1 mm
    "dry_dasarian_mm": 50,    # BMKG season criterion: dasarian < 50 mm is dry
    "archive_lag_days": 6,    # ERA5 archive lags ~5 days
    # BMKG classes for consecutive days without rain (HTH): (max days, label)
    "hth_classes": [(5, "Sangat pendek"), (10, "Pendek"), (20, "Menengah"),
                    (30, "Panjang"), (60, "Sangat panjang"),
                    (float("inf"), "Kekeringan ekstrem")],
}

# --- What-if scenario "no rain for N dasarian" (Stage 2) --------------------
# NDDI quantile maps calibrated on month pairs of our own series whose second
# month was nearly dry (see scenario.py). Provisional: one dry season only.
SCENARIO = {
    "calib_max_month_mm": 40,  # month counts as "no rain" below this total
    # slider range = 3 dasarian per dry month found in the series
}
