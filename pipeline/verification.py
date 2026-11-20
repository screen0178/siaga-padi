"""v2 Phase 5.1: one verification page for everything the app claims.

Collects, from files the pipeline already wrote:
  video        Aug 2024 run vs the NgabubuGIS #2 video (config.VIDEO_CHECK)
  capacity     satellite dry-season proxy vs official irrigation (Phase 3)
  scenario     no-rain what-if hindcast vs "no change" (Stage 2)
  forecast     ML test years vs persistence / climatology (Phase 2)
  reports      field reports vs the map (feedback.json)
No Earth Engine. Run after any of those change:
  python pipeline/verification.py   -> web/public/data/verification.json
"""

import csv
import json
from datetime import datetime, timezone

from scipy.stats import pearsonr, spearmanr

from config import ROOT, VIDEO_CHECK, WEB_DATA_DIR

IRR = ROOT / "data" / "irrigation"


def read(name):
    p = WEB_DATA_DIR / name
    return json.loads(p.read_text()) if p.exists() else None


def capacity():
    p = IRR / "water_access_2026.csv"
    if not p.exists():
        return None
    rows = list(csv.DictReader(p.open()))
    f = lambda k: [float(r[k]) for r in rows]
    g = f("dry_green_share")
    return {
        "n": len(rows),
        "spearman_irrigated": round(spearmanr(g, f("irrigated_share"))[0], 2),
        "spearman_rice3x": round(spearmanr(g, f("rice3x_share"))[0], 2),
        "pearson_cropland_sawah": round(pearsonr(f("cropland_ha"), f("sawah_ha_official"))[0], 2),
        "cropland_total": round(sum(f("cropland_ha"))), "sawah_total": round(sum(f("sawah_ha_official"))),
        "points": [{"name": r["name"], "proxy": float(r["dry_green_share"]), "official": float(r["irrigated_share"])}
                   for r in rows],
    }


def run():
    sc, fc, fb = read("scenario.json"), read("forecast.json"), read("feedback.json")
    out = {
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "video": [{"what": w, "video": v, "ours": o, "unit": u, "matched": m, "note": n}
                  for w, v, o, u, m, n in VIDEO_CHECK],
        "capacity": capacity(),
        "scenario": [{k: m[k] for k in ("pair", "rain_mm", "kec_mae_ha", "persist_mae_ha", "kec_bias_ha")}
                     for m in sc["calibration"]["months"]] if sc else None,
        "forecast": {k: fc["model"][k] for k in ("run_id", "test_period", "n_pairs", "test", "test_rain_climatology",
                                                 "test_by_horizon")} if fc else None,
        "reports": {"n": fb["n_reports"], "generated_at": fb["generated_at"],
                    "summary": {k: v for k, v in fb["check"]["summary"].items() if v["n"]},
                    "excluded_desa": len(fb["excluded_desa"])} if fb else {"n": 0},
    }
    (WEB_DATA_DIR / "verification.json").write_text(json.dumps(out, indent=1, ensure_ascii=False))
    return out


if __name__ == "__main__":
    v = run()
    c = v["capacity"]
    print(f"video: {sum(x['matched'] for x in v['video'])}/{len(v['video'])} matched")
    if c:
        print(f"capacity: rho {c['spearman_irrigated']} / {c['spearman_rice3x']}, cropland~sawah r {c['pearson_cropland_sawah']}")
    for s in v["scenario"] or []:
        print(f"scenario {s['pair']}: MAE {s['kec_mae_ha']} vs no change {s['persist_mae_ha']} ha")
    if v["forecast"]:
        k = v["forecast"]["test"]["kecamatan"]["mae_ha"]
        print(f"forecast: kec MAE {k['model']:.0f} vs {k['persistence']:.0f} vs {k['climatology']:.0f} ha")
    print(f"reports: {v['reports']['n']}")
