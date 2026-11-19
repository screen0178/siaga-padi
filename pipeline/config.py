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
