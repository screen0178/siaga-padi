"""v2 Phase 2.3: drought forecast for today (nowcast), +7 and +14 days.

For every desa: its latest usable Landsat observation (d0) from
data/ml/obs_*.csv, rain from Open-Meteo (past 92 days + 16-day forecast) at
its kecamatan point, and the model in data/ml/models/LATEST. Each target date
d1 gives h = d1 - d0 (the model was trained on 8-40 days).

Per kecamatan (desa aggregated by their active rice at d0):
  share  P10/P50/P90 of Kuat+Ekstrem share; ha = share x the map's active ha
  hazard P10/P50/P90 of H -> status (same thresholds as scoring)
  confidence  Tinggi / Sedang / Rendah from the P10-P90 width and how much of
              the cropland had a recent clear observation
  reasons     top 3 feature groups by how much they move the P50 (occlusion:
              group set to its training median), in plain Indonesian
Kecamatan bands add desa quantiles, which assumes desa move together (they
mostly do: same rain, same season); the model card reports the coverage.

Run:  python pipeline/forecast.py [--project EE_PROJECT]
  --project first exports Landsat dates newer than the last one on disk.
Writes web/public/data/forecast.json (optional contract file).
"""

import argparse
import json
import pickle
from datetime import date, datetime, timedelta, timezone

import numpy as np
import pandas as pd

from config import WEB_DATA_DIR
from ml_common import (H_MAX, H_MIN, MODELS_DIR, Rain, add_rain, add_season, load_obs, load_static,
                       obs_features, status_of)

STEPS = [("now", "Hari ini", 0), ("d7", "+7 hari", 7), ("d14", "+14 hari", 14)]
STALE_DAYS = 32         # a desa whose last clear observation is older is left out
CONF_WIDTH = (0.15, 0.30)  # P10-P90 width of the share: < first Tinggi, < second Sedang


def load_model():
    run_id = (MODELS_DIR / "LATEST").read_text().strip()
    with (MODELS_DIR / run_id / "model.pkl").open("rb") as fh:
        m = pickle.load(fh)
    meta = json.loads((MODELS_DIR / run_id / "metrics.json").read_text())
    return m, meta


def current_rain(today: date) -> Rain:
    """Archive history (training file) overlaid with Open-Meteo's recent past
    and forecast, so windows reaching 60 days back and 14 days ahead exist."""
    from weather import daily_rain, kecamatan_points
    hist = Rain.from_csv()
    daily = {}
    for kid, v in hist.vals.items():
        d0 = hist.start[kid]
        daily[kid] = {(d0 + timedelta(days=i)).isoformat(): float(x) for i, x in enumerate(v) if not np.isnan(x)}
    recent = daily_rain(kecamatan_points(), past_days=92, forecast_days=16)
    for kid, days in recent.items():
        daily.setdefault(kid, {}).update({d: mm for d, mm in days.items() if mm is not None})
    return Rain(daily)


def predict(m, X):
    out = {}
    for t in ("share45", "hazard"):
        a = np.column_stack([m["models"][(t, q)].predict(X[m["features"]]) for q in m["quantiles"]])
        out[t] = np.clip(np.sort(a, axis=1), 0, 1)
    return out


def contributions(m, X):
    """P50 share change per feature group when that group is set to its
    training median (positive = the group raises the forecast)."""
    base = np.clip(m["models"][("share45", 0.5)].predict(X[m["features"]]), 0, 1)
    out = {}
    for g, cols in m["groups"].items():
        x = X.copy()
        for c in cols:
            x[c] = m["medians"][c]
        out[g] = base - np.clip(m["models"][("share45", 0.5)].predict(x[m["features"]]), 0, 1)
    return out


def bulan(d: date):
    return f"{d.day} {['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des'][d.month - 1]}"


def reason_text(g, up, v, d1: date):
    """One plain sentence per feature group; v = area-weighted feature values."""
    pct = lambda x: f"{100 * x:.0f}%"
    if g == "rain_future":
        return (f"Hujan sampai {bulan(d1)} sedikit: ±{v['rain_win']:.0f} mm" if up
                else f"Hujan sampai {bulan(d1)} cukup: ±{v['rain_win']:.0f} mm")
    if g == "rain_past":
        return (f"Hujan 30 hari sebelum citra hanya {v['rain30']:.0f} mm ({v['hth']:.0f} hari tanpa hujan)" if up
                else f"Hujan 30 hari sebelum citra cukup: {v['rain30']:.0f} mm")
    if g == "state":
        return (f"Cekaman sudah tinggi pada citra terakhir ({pct(v['share45'])} kuat–ekstrem)" if up
                else f"Cekaman pada citra terakhir masih rendah ({pct(v['share45'])} kuat–ekstrem)")
    if g == "trend":
        return "Cekaman naik sejak citra sebelumnya" if up else "Cekaman turun sejak citra sebelumnya"
    if g == "stage":
        return (f"Fase tumbuh rawan (NDVI rata-rata {v['mean_ndvi']:.2f})" if up
                else f"Tanaman masih hijau (NDVI rata-rata {v['mean_ndvi']:.2f})")
    if g == "water":
        return (f"Irigasi minim ({pct(v['irrigated_share'])} sawah irigasi)" if up
                else f"Sawah irigasi {pct(v['irrigated_share'])} meredam kekeringan")
    if g == "season":
        return "Musim: bulan ini biasanya kering" if up else "Musim: bulan ini biasanya basah"
    return g


def confidence(width, coverage):
    lvl = 0 if width < CONF_WIDTH[0] else 1 if width < CONF_WIDTH[1] else 2
    if coverage < 0.5:
        lvl = min(2, lvl + 1)
    return ["Tinggi", "Sedang", "Rendah"][lvl]


def run(today: date, project=None):
    if project:
        import ee
        import ml_dataset
        ee.Initialize(project=project)
        ml_dataset.export_landsat([today.year - 1, today.year] if today.month == 1 else [today.year], workers=4)
    m, meta = load_model()
    static = load_static()
    o = obs_features(load_obs(), static)
    u = o[o["usable"] & (o["date"] <= pd.Timestamp(today))]
    last = u.sort_values("date").groupby("desa_id").tail(1)
    last = last[(pd.Timestamp(today) - last["date"]).dt.days <= STALE_DAYS].copy()
    rain = current_rain(today)

    kec_json = json.loads((WEB_DATA_DIR / "kecamatan.json").read_text())
    kec_props = {f["properties"]["id"]: f["properties"] for f in kec_json["features"]}
    crop_by_kec = static.groupby("kec_id")["crop_ha"].sum()

    out_kec = {k: {"name": p["name"], "steps": {}} for k, p in kec_props.items()}
    totals = {}
    steps = []
    for sid, label, days in STEPS:
        d1 = today + timedelta(days=days)
        steps.append({"id": sid, "label": label, "date": d1.isoformat(), "days": days})
        X = last.copy()
        X["d1"] = pd.Timestamp(d1)
        X["h"] = (X["d1"] - X["date"]).dt.days.clip(lower=H_MIN)
        X = add_season(add_rain(X, rain))
        X = X[X["h"] <= H_MAX]
        p = predict(m, X)
        contrib = contributions(m, X)
        X = X.assign(**{f"s{k}": p["share45"][:, k] for k in range(3)},
                     **{f"z{k}": p["hazard"][:, k] for k in range(3)},
                     **{f"g_{g}": v for g, v in contrib.items()})
        tot = np.zeros(3)
        for kid, grp in X.groupby("kec_id"):
            w = grp["active_ha"].to_numpy()
            wm = lambda col: float(np.average(grp[col], weights=w))
            share = [wm(f"s{k}") for k in range(3)]
            haz = [wm(f"z{k}") for k in range(3)]
            act = float(kec_props.get(kid, {}).get("active_ha") or 0)
            cov = float(grp["crop_ha"].sum() / crop_by_kec.get(kid, np.nan))
            vals = {c: wm(c) for c in ("rain_win", "rain30", "hth", "share45", "mean_ndvi", "irrigated_share")}
            gs = sorted(((g, wm(f"g_{g}")) for g in m["groups"]), key=lambda kv: -abs(kv[1]))
            reasons = [{"group": g, "pp": round(100 * c, 1), "up": bool(c > 0), "text": reason_text(g, c > 0, vals, d1)}
                       for g, c in gs[:3] if abs(c) >= 0.005]
            ha = [round(s * act, 1) for s in share]
            tot += ha
            out_kec[kid]["steps"][sid] = {
                "share": [round(s, 3) for s in share], "ha": ha, "hazard": [round(z, 3) for z in haz],
                "status": status_of(haz[1]), "status_range": [status_of(haz[0]), status_of(haz[2])],
                "confidence": confidence(share[2] - share[0], cov), "coverage": round(cov, 2),
                "h_days": [int(grp["h"].min()), int(grp["h"].max())],
                "rain_win_mm": round(vals["rain_win"], 1), "reasons": reasons,
            }
        counts = {}
        for k in out_kec.values():
            st = k["steps"].get(sid, {}).get("status")
            if st:
                counts[st] = counts.get(st, 0) + 1
        totals[sid] = {"ha": [round(x) for x in tot], "status_count": counts}

    for kid, k in out_kec.items():
        k["obs_dates"] = sorted({d.date().isoformat() for d in last.loc[last["kec_id"] == kid, "date"]})
    mt = meta["metrics"]
    out = {
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "today": today.isoformat(),
        "steps": steps,
        "latest_obs": str(last["date"].max().date()) if len(last) else None,
        "desa_used": int(len(last)),
        "rain_source": "Open-Meteo: 92 hari terakhir + prakiraan 16 hari, titik label kecamatan",
        "model": {
            "run_id": meta["run_id"], "trained_at": meta["trained_at"], "data": meta["data"],
            "kind": "Gradient boosting kuantil (P10/P50/P90), scikit-learn",
            "horizon_days": mt["horizon_days"], "n_pairs": mt["n_pairs"], "test_period": mt["test_period"],
            "test": mt["test"], "test_rain_climatology": mt["test_rain_climatology"],
            "test_by_horizon": mt["test_by_horizon"], "group_importance": mt["group_importance"],
        },
        "totals": totals,
        "kecamatan": out_kec,
    }
    (WEB_DATA_DIR / "forecast.json").write_text(json.dumps(out, indent=1, ensure_ascii=False))
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--project")
    ap.add_argument("--today", help="YYYY-MM-DD (default: today)")
    a = ap.parse_args()
    today = date.fromisoformat(a.today) if a.today else date.today()
    f = run(today, a.project)
    print(f"forecast.json for {f['today']} (model {f['model']['run_id']}, {f['desa_used']} desa, "
          f"latest obs {f['latest_obs']})")
    for sid, t in f["totals"].items():
        print(f"  {sid:>4}: Kuat+Ekstrem {t['ha'][1]:,} ha (P10 {t['ha'][0]:,} - P90 {t['ha'][2]:,}); {t['status_count']}")
    rows = sorted(f["kecamatan"].items(), key=lambda kv: -kv[1]["steps"].get("d14", {}).get("ha", [0, 0])[1])
    for kid, k in rows[:8]:
        s = k["steps"].get("d14")
        if s:
            print(f"  {k['name']:<14} +14: {s['status']:<8} {s['ha'][1]:>6,.0f} ha [{s['ha'][0]:,.0f}-{s['ha'][2]:,.0f}] "
                  f"{s['confidence']:<6} | " + "; ".join(r["text"] for r in s["reasons"]))


if __name__ == "__main__":
    main()
