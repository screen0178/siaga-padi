"""Field-report rules (no Earth Engine). Run: python -m pytest pipeline/tests -q"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import feedback  # noqa: E402

D = next(iter(feedback.desa_features()))  # any real desa id


def rep(i, answer, desa=D, period="2026-11", kec="k1"):
    return {"id": i, "created_at": f"2026-11-0{i}T00:00:00+00:00", "period_id": period,
            "kec_id": kec, "desa_id": desa, "answer": answer}


def test_one_report_is_not_enough():
    assert feedback.corrections([rep(1, "not_rice")]) == []


def test_two_not_rice_reports_exclude_the_desa():
    ex = feedback.corrections([rep(1, "not_rice"), rep(2, "not_rice")])
    assert [e["desa_id"] for e in ex] == [D] and ex[0]["not_rice"] == 2


def test_contradicting_reports_undo_the_exclusion():
    rs = [rep(1, "not_rice"), rep(2, "not_rice"), rep(3, "ok"), rep(4, "ok"), rep(5, "ok")]
    assert feedback.corrections(rs) == []


def test_kecamatan_level_reports_never_exclude():
    assert feedback.corrections([rep(1, "not_rice", desa=None), rep(2, "not_rice", desa=None)]) == []


def test_map_view_and_agreement():
    v = feedback.map_view({"2": 50, "4": 50, "6": 100}, {"c4s2": 30, "c2s4": 70})
    assert v["stressed_share"] == 0.3 and v["inactive_share"] == 0.5
    assert feedback.agrees("ok", v) is True          # 30% >= 25%
    assert feedback.agrees("irrigated", v) is False
    assert feedback.agrees("harvested", v) is True   # 50% >= 50%
    corrected = feedback.map_view({"8": 53.3, "2": 0.5}, {"c4s2": 0.1})
    assert feedback.agrees("not_rice", corrected) is True   # border pixels left
    assert feedback.agrees("not_rice", v) is False
    empty = feedback.map_view({}, {})
    assert feedback.agrees("ok", empty) is None


def test_check_skips_months_outside_the_window():
    out = feedback.check([rep(1, "ok", period="2025-01")], {}, {})
    assert out["reports"] == [] and out["summary"]["ok"]["n"] == 0
