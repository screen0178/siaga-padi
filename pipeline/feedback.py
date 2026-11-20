"""Field reports back into the pipeline (Stage 3, see config.FEEDBACK).

Reads the officers' reports, decides which desa are corrected (taken out of
active rice), and checks every report against what the map said for that
place and month. gee_export.py and scenario.py call this; run it alone for a
dry run that needs no Earth Engine:

  python pipeline/feedback.py                    # reads server/siaga.db
  python pipeline/feedback.py --reports r.csv    # or an /api/reports.csv export
"""

import argparse
import csv
import json
import sqlite3
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path

from config import BOUNDARY_DIR, FEEDBACK, WEB_DATA_DIR

ANSWER_LABEL = {
    "ok": "Sesuai: padi tercekam kering",
    "not_rice": "Bukan padi",
    "harvested": "Sudah panen / bera",
    "irrigated": "Masih teririgasi baik",
}


def load_reports(source=None) -> list[dict]:
    """Reports oldest first, from a CSV export or the server's SQLite file.
    Missing source -> no reports (the pipeline runs fine without a server)."""
    path = Path(source) if source else FEEDBACK["db"]
    if not path.exists():
        return []
    if path.suffix == ".csv":
        with path.open(newline="", encoding="utf-8") as f:
            rows = list(csv.DictReader(f))
    else:
        c = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
        c.row_factory = sqlite3.Row
        try:
            rows = [dict(r) for r in c.execute("SELECT * FROM reports ORDER BY id")]
        except sqlite3.OperationalError:  # server never started: no table yet
            rows = []
        finally:
            c.close()
    for r in rows:
        r["desa_id"] = r.get("desa_id") or None
    return sorted(rows, key=lambda r: (r["created_at"], int(r["id"])))


def desa_features():
    return {f["properties"]["id"]: f for f in
            json.loads((BOUNDARY_DIR / "pati_desa.geojson").read_text())["features"]}


def corrections(reports) -> list[dict]:
    """Desa taken out of active rice: enough 'not_rice' reports, and they are
    the majority of that desa's reports."""
    by_desa: dict[str, Counter] = {}
    for r in reports:
        if r["desa_id"]:
            by_desa.setdefault(r["desa_id"], Counter())[r["answer"]] += 1
    desa = desa_features()
    out = []
    for did, n in sorted(by_desa.items()):
        total = sum(n.values())
        if (n["not_rice"] >= FEEDBACK["exclude_min_reports"]
                and n["not_rice"] / total >= FEEDBACK["exclude_share"] and did in desa):
            p = desa[did]["properties"]
            out.append({"desa_id": did, "name": p["name"], "kec_id": p["kec_id"],
                        "not_rice": n["not_rice"], "reports": total})
    return out


def exclusion_geometry(excluded):
    """ee.Geometry of the corrected desa, or None. Imported lazily so the dry
    run needs no Earth Engine."""
    if not excluded:
        return None
    import ee
    desa = desa_features()
    return ee.FeatureCollection([ee.Feature(desa[e["desa_id"]]["geometry"]) for e in excluded]).geometry()


# ---------------------------------------------------------------- checks
def map_view(stage_ha: dict, joint_ha: dict) -> dict:
    """What the map said for one place: shares used to judge a report.
    stage_ha: cropland ha per stage; joint_ha: active ha per 'c{class}s{stage}'."""
    crop = sum(stage_ha.values()) or 0.0
    active = sum(joint_ha.values()) or 0.0
    stressed = sum(v for k, v in joint_ha.items() if k[1] in "45")
    inactive = sum(stage_ha.get(k, 0) for k in ("6", "7", "8"))
    return {
        "cropland_ha": round(crop, 1),
        "active_ha": round(active, 1),
        "stressed_share": round(stressed / active, 3) if active else None,
        "inactive_share": round(inactive / crop, 3) if crop else None,
        "excluded_ha": round(stage_ha.get("8", 0), 1),
    }


def agrees(answer: str, view: dict) -> bool | None:
    """Did the map already say what the officer saw? None = cannot tell."""
    s, i = view["stressed_share"], view["inactive_share"]
    if answer == "ok":            # stressed rice on the ground
        return None if s is None else s >= FEEDBACK["stressed_share"]
    if answer == "harvested":     # map should call it inactive (bera / panen)
        return None if i is None else i >= FEEDBACK["inactive_share"]
    if answer == "irrigated":     # map should NOT show stress
        return None if s is None else s < FEEDBACK["stressed_share"]
    if answer == "not_rice":      # right once corrected (border pixels may stay)
        crop = view["cropland_ha"]
        return None if not crop else view["excluded_ha"] / crop >= 0.9
    return None


def check(reports, views_by_period: dict, kec_views_by_period: dict) -> dict:
    """views_by_period: {period: {desa_id: map_view}} for reported desa;
    kec_views_by_period: same per kec_id, used for reports without a desa.
    Reports from months outside the exported window are skipped."""
    rows = []
    for r in reports:
        pid = r["period_id"]
        if r["desa_id"]:
            view = views_by_period.get(pid, {}).get(r["desa_id"])
        else:
            view = kec_views_by_period.get(pid, {}).get(r["kec_id"])
        if view is None:
            continue
        rows.append({"id": int(r["id"]), "period_id": pid, "kec_id": r["kec_id"], "desa_id": r["desa_id"],
                     "answer": r["answer"], "agrees": agrees(r["answer"], view), "map": view})
    summary = {}
    for a in ANSWER_LABEL:
        rs = [x for x in rows if x["answer"] == a]
        judged = [x for x in rs if x["agrees"] is not None]
        summary[a] = {"label": ANSWER_LABEL[a], "n": len(rs), "agree": sum(1 for x in judged if x["agrees"]),
                      "judged": len(judged)}
    return {"summary": summary, "reports": rows}


def write(reports, excluded, checked, source):
    out = {
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "source": source,
        "rules": {k: v for k, v in FEEDBACK.items() if k != "db"},
        "n_reports": len(reports),
        "excluded_desa": excluded,
        "check": checked,
    }
    (WEB_DATA_DIR / "feedback.json").write_text(json.dumps(out, indent=1))
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--reports", help="CSV from /api/reports.csv (default: server/siaga.db)")
    args = ap.parse_args()
    reps = load_reports(args.reports)
    print(f"{len(reps)} reports from {args.reports or FEEDBACK['db']}")
    for a, n in Counter(r["answer"] for r in reps).most_common():
        print(f"  {ANSWER_LABEL.get(a, a)}: {n}")
    ex = corrections(reps)
    print(f"Desa taken out of active rice on the next export: {len(ex)}")
    for e in ex:
        print(f"  {e['name']} ({e['kec_id']}): {e['not_rice']}/{e['reports']} 'bukan padi'")


if __name__ == "__main__":
    main()
