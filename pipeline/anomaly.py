"""v2 Phase 5.2: "lebih kering dari biasanya" - NDDI anomaly per desa.

For each month of the map's series, compares a desa's mean NDDI on active
rice with the same calendar month in the baseline years (2013-2025), from
the per-date Landsat observations of the ML dataset (data/ml/obs_*.csv; no
new Earth Engine run). Monthly value = active-rice-weighted mean over that
month's clear dates. Anomaly:
  diff = value - baseline mean
  z    = diff / baseline standard deviation (needs >= MIN_YEARS years)
Kecamatan values weight desa by active rice. Single-date stage masks, as in
the ML data, so it is a relative signal, not the map's exact NDDI.

Run:  python pipeline/anomaly.py      -> web/public/data/anomaly.json
"""

import json
from datetime import datetime, timezone

import numpy as np
import pandas as pd

from config import WEB_DATA_DIR
from ml_common import load_obs, load_static, obs_features

BASE_YEARS = (2013, 2025)
MIN_YEARS = 5
MIN_ACTIVE_HA = 5
SD_FLOOR = 0.15  # avoid huge z where a desa barely varies


def monthly(o: pd.DataFrame) -> pd.DataFrame:
    """Active-weighted monthly mean NDDI per desa."""
    u = o[(o["active_ha"] >= MIN_ACTIVE_HA) & o["mean_nddi"].notna()].copy()
    u["ym"] = u["date"].dt.to_period("M")
    g = u.groupby(["desa_id", "kec_id", "ym"])
    m = (g["nddi_sum"].sum() / g["active_ha"].sum()).rename("nddi").to_frame()
    m["active_ha"] = g["active_ha"].mean()
    m = m.reset_index()
    m["year"], m["month"] = m["ym"].dt.year, m["ym"].dt.month
    return m


def run():
    meta = json.loads((WEB_DATA_DIR / "meta.json").read_text())
    periods = [p["id"] for p in meta.get("periods", [])] or [meta["period"]["start"][:7]]
    m = monthly(obs_features(load_obs(), load_static()))
    base = m[(m["year"] >= BASE_YEARS[0]) & (m["year"] <= BASE_YEARS[1])]
    clim = base.groupby(["desa_id", "month"])["nddi"].agg(["mean", "std", "count"]).reset_index()
    out = {"generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
           "baseline_years": list(BASE_YEARS), "min_years": MIN_YEARS, "periods": {}}
    for pid in periods:
        y, mo = int(pid[:4]), int(pid[5:7])
        cur = m[(m["year"] == y) & (m["month"] == mo)].merge(clim[clim["month"] == mo], on="desa_id", how="left")
        cur = cur[cur["count"] >= MIN_YEARS].copy()
        cur["diff"] = cur["nddi"] - cur["mean"]
        cur["z"] = cur["diff"] / np.maximum(cur["std"], SD_FLOOR)
        desa = {r.desa_id: {"nddi": round(r.nddi, 2), "base": round(r.mean, 2), "diff": round(r.diff, 2),
                            "z": round(r.z, 2), "years": int(r.count)} for r in cur.itertuples()}
        kec = {}
        for kid, g in cur.groupby("kec_id"):
            w = g["active_ha"].to_numpy()
            kec[kid] = {"diff": round(float(np.average(g["diff"], weights=w)), 2),
                        "z": round(float(np.average(g["z"], weights=w)), 2), "desa": int(len(g))}
        out["periods"][pid] = {"desa": desa, "kecamatan": kec}
    (WEB_DATA_DIR / "anomaly.json").write_text(json.dumps(out))
    return out


if __name__ == "__main__":
    a = run()
    names = {f["properties"]["id"]: f["properties"]["name"]
             for f in json.loads((WEB_DATA_DIR / "kecamatan.json").read_text())["features"]}
    for pid, p in a["periods"].items():
        zs = [d["z"] for d in p["desa"].values()]
        print(f"{pid}: {len(zs)} desa, median z {np.median(zs):+.2f}, z>1: {np.mean(np.array(zs) > 1):.0%}, "
              f"z<-1: {np.mean(np.array(zs) < -1):.0%}")
    last = a["periods"][list(a["periods"])[-1]]["kecamatan"]
    print("Latest month, kecamatan (z, diff):")
    for kid, v in sorted(last.items(), key=lambda kv: -kv[1]["z"]):
        print(f"  {names.get(kid, kid):<15} z {v['z']:+.2f}  diff {v['diff']:+.2f}  ({v['desa']} desa)")
