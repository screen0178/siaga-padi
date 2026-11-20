"""Capacity in scoring: priority discounted, status unchanged."""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from scoring import score, water_source  # noqa: E402

J = {"c5s4": 300.0, "c4s3": 200.0, "c2s2": 100.0}


def test_capacity_changes_priority_not_status():
    a, b = score(J), score(J, irrigated_share=1.0)
    assert a["status"] == b["status"] and a["ha_at_risk"] == b["ha_at_risk"]
    assert a["priority"] == a["ha_at_risk"] and b["priority"] == round(a["ha_at_risk"] * 0.7, 1)


def test_water_source_and_steps():
    assert [water_source(x) for x in (0.9, 0.1, 0.5, None)] == ["irigasi", "tadah hujan", "campuran", None]
    rf = " ".join(score(J, 0.1)["action"]["steps"])
    ir = " ".join(score(J, 0.9)["action"]["steps"])
    mix = score(J, 0.5)["action"]["steps"]
    assert "sumur" in rf and "P3A" in ir
    assert any(s.startswith("Blok irigasi") for s in mix) and any(s.startswith("Blok tadah hujan") for s in mix)
