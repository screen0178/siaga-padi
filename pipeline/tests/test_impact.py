"""v2 Phase 4: impact ranges and action options."""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from config import IMPACT  # noqa: E402
from impact import impact, options  # noqa: E402


def test_value_range_brackets_mid():
    v = impact(100)
    assert v["t"][0] < v["t"][1] < v["t"][2]
    assert v["t"][1] == round(100 * IMPACT["yield_t_ha"], 1)
    assert v["rp"][0] < v["rp"][1] < v["rp"][2]


def test_options_split_by_water_source():
    p = {"stressed_stage_ha": {"2": 0, "3": 100, "4": 100}, "cropland_stage_ha": {"6": 200},
         "water": {"irrigated_share": 0.0}}
    ids = [o["id"] for o in options(p)]
    assert ids == ["pump", "delay"]                      # rainfed: pumps, no canal rotation
    pump = options(p)[0]
    assert pump["pumps"] == [7, 20] and pump["target_ha"] == 200   # 200 ha / 30 .. / 10
    p["water"]["irrigated_share"] = 1.0
    assert [o["id"] for o in options(p)] == ["rotation"]  # fully irrigated: rotation only
