"""v2 Phase 2: rain windows, trend features and forecast confidence."""

import sys
from datetime import date
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from forecast import confidence  # noqa: E402
from ml_common import Rain, obs_features, status_of  # noqa: E402

R = Rain({"k": {"2026-01-01": 5.0, "2026-01-02": 0.0, "2026-01-03": 0.5, "2026-01-04": 2.0, "2026-01-05": 0.0}})


def test_rain_windows():
    assert R.window("k", date(2026, 1, 3), 3) == 5.5             # 1..3 inclusive
    assert R.between("k", date(2026, 1, 2), date(2026, 1, 4)) == 2.5  # (2, 4]
    assert np.isnan(R.window("k", date(2026, 1, 2), 5))          # before the record
    assert R.hth("k", date(2026, 1, 3)) == 2                      # 0.0 and 0.5 mm are dry days
    assert R.hth("k", date(2026, 1, 4)) == 0


def test_status_thresholds_match_scoring():
    assert [status_of(h) for h in (0.2, 0.5, 0.7, 0.9)] == ["Normal", "Waspada", "Siaga", "Awas"]


def test_trend_uses_previous_usable_observation_only():
    base = dict(valid_ha=100, c1=0, c2=50, c3=0, c5=0, s2=0, s3=50, s4=50, bare_ha=0, ripe_ha=0,
                nddi_sum=0, ndvi_sum=50, ndmi_sum=0, ndvi_valid_sum=50)
    obs = pd.DataFrame([
        base | {"date": "2026-01-01", "active_ha": 100, "c4": 50},
        base | {"date": "2026-01-09", "active_ha": 1, "c4": 1},     # too little active rice: skipped
        base | {"date": "2026-01-17", "active_ha": 100, "c4": 80},
    ]).assign(desa_id="d", date=lambda d: pd.to_datetime(d["date"]))
    st = pd.DataFrame({"desa_id": ["d"], "kec_id": ["k"], "crop_ha": [100.0], "elev_m": [10.0],
                       "irrigated_share": [0.5], "rice3x_share": [0.0]})
    o = obs_features(obs, st).set_index("date")
    last = o.loc["2026-01-17"]
    assert last["prev_gap"] == 16 and abs(last["d_share45"] - 0.3) < 1e-9


def test_confidence_from_width_and_coverage():
    assert confidence(0.10, 0.9) == "Tinggi"
    assert confidence(0.10, 0.3) == "Sedang"   # little clear sky: one level down
    assert confidence(0.40, 0.9) == "Rendah"
