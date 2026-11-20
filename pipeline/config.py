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
    # "Panen atau puso?" (stage 9): a harvest-like drop that may be a
    # drought-killed crop. Flagged for a field check instead of silently
    # leaving active rice. Either rule is enough:
    #   stressed  NDDI >= puso_nddi_min (Kuat) in a month from the peak on,
    #             while the crop still stood (NDVI >= standing_ndvi_min).
    #             Bare months are skipped: bare soil itself reads as very
    #             high NDDI, so it says nothing about the crop.
    #   early     the drop came at most early_drop_months after green-up
    #             (first month with NDVI >= fallow_peak_max after a month
    #             below it). Monthly composites blur timing by +/- a month,
    #             so only a drop in the month right after green-up counts.
    "puso_nddi_min": 1.25,
    "standing_ndvi_min": 0.25,
    "early_drop_months": 1,
    # "Gagal tanam?" (stage 10): a never-greened field (rule 6) where most
    # cropland within neighbour_radius_m did green (peak >= harvest_peak_min):
    # the area was planted, so this field likely failed rather than lay fallow.
    "neighbour_radius_m": 300,
    "neighbour_green_min": 0.5,
}
# Extra, non-active stage classes that only exist in series mode
TRAJECTORY_CLASSES = [
    (6, None, None, "Bera / tidak tumbuh", False),
    (7, None, None, "Panen / pasca-panen", False),
    (9, None, None, "Panen atau puso? (perlu cek)", False),
    (10, None, None, "Gagal tanam? (perlu cek)", False),
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
# --- Water access / capacity (v2 Phase 3) ------------------------------------
# Satellite proxy: cropland with a real rice canopy (monthly median NDVI >=
# ndvi_min) in a month of the deep dry season had water from irrigation, a
# pump or a well; Aug and Sep 2026 had 16 and 24 mm median rain. Validated per
# kecamatan against the official 2024 tables (pipeline/irrigation.py).
WATER_ACCESS = {
    "months": [("2026-08-01", "2026-09-01"), ("2026-09-01", "2026-10-01")],
    "ndvi_min": 0.45,
    # Sensitivity variants reported by water_access.py, not used for scoring
    "variants": {"Jul-Sep 0.45": ([("2026-07-01", "2026-08-01"), ("2026-08-01", "2026-09-01"),
                                   ("2026-09-01", "2026-10-01")], 0.45),
                 "Aug-Sep 0.40": (None, 0.40), "Aug-Sep 0.50": (None, 0.50)},
}

# Capacity in the ranking (status stays hazard-only):
#   priority = ha_at_risk x (1 - weight x irrigated_share)
# Source: official 2024 irrigated share (independent of the satellite data;
# the NDVI proxy would count the drought evidence twice). Weight provisional:
# irrigation buffers drought but fails in a long dry season (Sukolilo is 85 %
# irrigated and still stressed), so it only discounts, never removes, risk.
CAPACITY = {
    "weight": 0.3,
    "irrigated_min": 0.7,   # >= -> water source "irigasi"
    "rainfed_min": 0.7,     # rainfed share >= -> "tadah hujan"; between -> "campuran"
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

# --- Impact in tonnes and rupiah (v2 Phase 4) ---------------------------------
# Production at risk = ha at risk x yield. ha at risk already weighs each
# hectare by drought class (CLASS_HAZARD) and growth-stage vulnerability, so it
# is read as "hectare-equivalents of lost harvest": an expected-loss proxy, not
# an observed loss. Always shown as a range, never as one exact number.
IMPACT = {
    # BPS Provinsi Jawa Tengah, "Luas Panen, Produktivitas, dan Produksi Padi
    # menurut Kabupaten/Kota, 2024": Pati 54.63 ku/ha GKG (96,537 ha, 527,355 t).
    "yield_t_ha": 5.463,
    "yield_source": "BPS Jawa Tengah 2024: produktivitas padi Kab. Pati 54,63 ku/ha GKG",
    # Season and field variation around the annual mean (assumption)
    "yield_factor": (0.9, 1.1),
    # GKG price, Rp/kg. Low: HPP GKG at the mill Rp 8,000 (Keputusan Kepala
    # Bapanas No. 2/2025; HPP kept for 2026 by Inpres No. 4/2026). High: the
    # market premium seen for GKP in 2026 (~Rp 7,000 vs HPP Rp 6,500, Bapanas
    # July 2026) applied to GKG: 8,000 x 7,000 / 6,500 ~ Rp 8,600 (assumption).
    "price_rp_kg": (8000, 8600),
    "price_source": "HPP GKG Rp 8.000/kg (Kepbadan 2/2025, Inpres 4/2026); harga pasar 2026 ±8% di atas HPP",
}

# Action options with an estimated effect (v2 Phase 4). Simple, documented,
# provisional assumptions; the UI shows them as ranges with these notes.
ACTION_OPTIONS = {
    # Pompanisasi: a 4-inch pump waters ~10 ha from one spot, ~30 ha when moved
    # between blocks (Kementan pump aid, Indramayu, Mar 2024). Targets stressed
    # (Kuat+Ekstrem) late-vegetative and reproductive rice on the rainfed part.
    "pump": {"ha_per_pump": (10, 30), "efficacy": (0.5, 0.8), "stages": ["3", "4"]},
    # Gilir air / P3A: redistributes limited canal water on the irrigated part;
    # recovers less than added water (assumption).
    "rotation": {"efficacy": (0.2, 0.4), "stages": ["2", "3", "4"]},
    # Tunda tanam + varietas genjah on fallow / not-yet-planted rainfed land:
    # avoids a failed planting; no rupiah estimate (nothing is planted yet).
    "delay": {"stages": ["6", "10"]},
    "min_ha": 25,  # options below this many target ha are not shown
}

# --- Verification against the NgabubuGIS #2 video, Aug 2024 (v2 Phase 5.1) ---
# Our single-period run of 2024-08 (commit 1d21c4f) vs the values read off the
# video. Shown on the app's verification page as-is, including the miss.
VIDEO_CHECK = [
    # (what, video, ours, unit, matched, note)
    ("Luas kelas Kuat", 11000, 12637, "ha", True, "selisih +15 %"),
    ("Luas kelas Normal", 19, 124, "ha", False, "kelas sangat kecil, peka terhadap masker"),
    ("NDDI rata-rata terendah: Cluwak", 0.3, 0.39, "", True, "kecamatan terendah sama"),
    ("NDDI rata-rata tertinggi: Tambakromo", 2.647, 1.57, "", False,
     "kami: Batangan 2,43 tertinggi; Tambakromo 1,3-1,8 pada semua variasi masker dan komposit; "
     "kemungkinan beda batas wilayah atau tanggal citra"),
]
