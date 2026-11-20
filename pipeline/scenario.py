"""Stage 2: what-if scenario "no rain for N dasarian".

Model: quantile mapping of the NDDI distribution, calibrated on our own
Landsat series (not assumed):

  1. Dry months: month pairs of the series whose second month was nearly
     dry (median Open-Meteo archive rainfall over the kecamatan below
     SCENARIO["calib_max_month_mm"]). In 2026: Jun>Jul, Jul>Aug, Aug>Sep.
  2. For each dry pair k, take the rice pixels that are active in both
     months and compute NDDI percentiles 1..99 before and after (Earth
     Engine). The transfer function T_k maps "the p-th percentile before"
     to "the p-th percentile after". Drought builds up, so later dry months
     shift the distribution further than the first one.
  3. The scenario replays dry month 1, 2, 3 in order, 3 dasarian each:
     within month k, dasarian j (1..3) moves each value a fraction j/3 of
     the way from x to T_k(x), so every month end matches T_k exactly.
  4. Each kecamatan's current NDDI histogram (per growth stage, 0.05 bins)
     is pushed through those steps, reclassified into the Artikanur classes
     and re-scored with scoring.score(), so status, ranking and
     recommendation follow the same rules as the observed data.

Why not a pixel-level Markov chain on the classes (tried first): a pixel in
the Kuat class keeps it only 30-60% of the time month to month, so the
chain mostly learns NDDI noise and pulls an already stressed state back to
the mean (it predicted drought would *drop* without rain). Comparing whole
distributions of the same pixels cancels that noise.

Assumptions (shown in the UI): growth stage and active area are held fixed
(no aging, no harvest, no replanting), and the 2026 dry season is taken as
representative of the next one.

Run after gee_export.py --last-months (reads the periods in meta.json):
  python pipeline/scenario.py --project YOUR_GCP_PROJECT
Writes web/public/data/scenario.json (optional contract extension).
"""

import argparse
import json
from datetime import datetime, timezone

import ee
import numpy as np

from config import NDDI_CLASSES, SCENARIO, WEB_DATA_DIR
from gee_export import SCALE, build, load_kecamatan, trajectory_histories
from scoring import score
from weather import kecamatan_points, monthly_rain

STAGES = [2, 3, 4]
PCTS = list(range(1, 100))
LO, HI, BIN = -3.0, 7.0, 0.05  # histogram range; outside is Normal / Ekstrem anyway
NBINS = round((HI - LO) / BIN)


def nddi_class(x):
    """Artikanur class (1..5) for an array of NDDI values."""
    out = np.ones_like(x, dtype=int)
    for cid, lo, hi, *_ in NDDI_CLASSES:
        out[(x >= lo) & (x < hi)] = cid
    return out


def nddi_bins(nddi):
    return nddi.clamp(LO, HI - 1e-6).subtract(LO).divide(BIN).floor().toInt()


def percentiles(nddi, aoi):
    """Area-weighted NDDI percentiles 1..99 from an exact 0.05-bin histogram
    (EE's percentile reducer buckets too coarsely over NDDI's wide range)."""
    area = ee.Image.pixelArea().divide(1e4)
    b = nddi_bins(nddi).rename("bin")
    r = area.updateMask(b.mask()).addBands(b).reduceRegion(
        ee.Reducer.sum().group(groupField=1, groupName="bin"), aoi, SCALE,
        maxPixels=1e10, tileScale=4).getInfo()
    h = np.zeros(NBINS)
    for g in r["groups"]:
        h[int(g["bin"])] += g["sum"]
    cdf = np.cumsum(h) / h.sum()
    edges = LO + BIN * np.arange(1, NBINS + 1)  # upper edge of each bin
    # Linear within the bin: value where the CDF crosses p
    lower = np.concatenate([[0.0], cdf[:-1]])
    out = []
    for p in PCTS:
        k = int(np.searchsorted(cdf, p / 100))
        frac = (p / 100 - lower[k]) / max(cdf[k] - lower[k], 1e-12)
        out.append(edges[k] - BIN + frac * BIN)
    return np.array(out)


def transfer(before, after):
    """T(x) as a function: interpolate between the percentile pairs, constant
    offset beyond the calibrated range."""
    def T(x):
        y = np.interp(x, before, after)
        y = np.where(x < before[0], x + (after[0] - before[0]), y)
        return np.where(x > before[-1], x + (after[-1] - before[-1]), y)
    return T


def calibrate(fc, aoi, periods, rain):
    plan = [(p["id"], p["start"], p["end"], p["label"]) for p in periods]
    histories = trajectory_histories(aoi, plan)
    Ls = [build(aoi, s, e, h) for (_, s, e, _), h in zip(plan, histories)]
    dry = []
    for i in range(len(plan) - 1):
        a, b = plan[i][0], plan[i + 1][0]
        mm = float(np.median([r[b] for r in rain.values() if r.get(b) is not None]))
        if mm >= SCENARIO["calib_max_month_mm"]:
            print(f"  {a} -> {b}: median rain {mm:.0f} mm, not dry, skipped")
            continue
        print(f"  {a} -> {b}: median rain {mm:.0f} mm, percentiles ...")
        both = Ls[i]["active"].And(Ls[i + 1]["active"])
        before = percentiles(Ls[i]["nddi"].updateMask(both), aoi)
        after = percentiles(Ls[i + 1]["nddi"].updateMask(both), aoi)
        before, after = np.maximum.accumulate(before), np.maximum.accumulate(after)
        T = transfer(before, after)
        # Hindcast per kecamatan: push each kecamatan's own "before"
        # histogram through the district-wide map and compare Kuat+Ekstrem
        # with what was observed a month later
        both_L = lambda L: {**L, "active": both, "stage": L["stage"].updateMask(both)}
        hb, ha_ = histograms(fc, both_L(Ls[i]), Ls[i]["nddi"]), histograms(fc, both_L(Ls[i + 1]), Ls[i + 1]["nddi"])
        x = LO + BIN * (np.arange(NBINS) + 0.5)
        stressed = lambda h, xs: float(sum(v[nddi_class(xs) >= 4].sum() for v in h.values()))
        err, obs, persist = [], [], []
        for kid in hb:
            o = stressed(ha_[kid], x)
            err.append(stressed(hb[kid], T(x)) - o)
            persist.append(stressed(hb[kid], x) - o)  # baseline: "nothing changes"
            obs.append(o)
        dry.append({"pair": f"{a}>{b}", "rain_mm": round(mm, 1), "before": before, "after": after,
                    "T": T, "kec_mae_ha": round(float(np.mean(np.abs(err)))),
                    "kec_bias_ha": round(float(np.mean(err))),
                    "persist_mae_ha": round(float(np.mean(np.abs(persist)))),
                    "kec_mean_ha": round(float(np.mean(obs)))})
    if not dry:
        raise SystemExit("No dry month pairs in the series; cannot calibrate.")
    return dry, Ls


def histograms(fc, L, nddi=None):
    """{kec_id: {stage: ha per NDDI bin}} for active rice in one period."""
    area = ee.Image.pixelArea().divide(1e4)
    b = nddi_bins(L["nddi"] if nddi is None else nddi)
    code = L["stage"].multiply(1000).add(b).updateMask(L["active"]).rename("code")
    res = area.updateMask(code.mask()).addBands(code).reduceRegions(
        collection=fc, reducer=ee.Reducer.sum().group(groupField=1, groupName="code"),
        scale=SCALE, tileScale=4).getInfo()
    out = {}
    for f in res["features"]:
        h = {st: np.zeros(NBINS) for st in STAGES}
        for g in f["properties"].get("groups", []):
            st, k = int(g["code"]) // 1000, int(g["code"]) % 1000
            if st in h and 0 <= k < NBINS:
                h[st][k] += g["sum"]
        out[f["properties"]["kec_id"]] = h
    return out


def scenarios(hist, maps):
    """{N: score dict} for one kecamatan; maps[k] is the NDDI transfer
    function of dry month k + 1. Stage and area held fixed."""
    x0 = LO + BIN * (np.arange(NBINS) + 0.5)  # bin centres
    xs = [x0]
    for T in maps:
        start = xs[-1]
        end = T(start)
        xs += [start + (end - start) * j / 3 for j in (1, 2, 3)]
    out = {}
    for n, x in enumerate(xs):
        cls = nddi_class(x)
        j = {}
        for st, ha in hist.items():
            for c in range(1, 6):
                v = float(ha[cls == c].sum())
                if v > 0.05:
                    j[f"c{c}s{st}"] = v
        out[n] = score(j)
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--project", required=True)
    args = ap.parse_args()

    meta = json.loads((WEB_DATA_DIR / "meta.json").read_text())
    periods = meta.get("periods")
    if not periods or len(periods) < 2:
        raise SystemExit("Needs a monthly series in meta.json (gee_export.py --last-months 6).")
    current = meta["current_period"]

    ee.Initialize(project=args.project)
    fc = load_kecamatan()
    aoi = fc.geometry()

    print("Monthly rainfall (Open-Meteo archive) ...")
    rain = monthly_rain(kecamatan_points(), [(p["id"], p["start"], p["end"]) for p in periods])

    print("Calibrating dry-month NDDI shifts ...")
    dry, Ls = calibrate(fc, aoi, periods, rain)
    maps = [d["T"] for d in dry]

    print(f"Current NDDI histograms ({current}) ...")
    L = Ls[[p["id"] for p in periods].index(current)]
    per_kec = {kid: scenarios(h, maps) for kid, h in histograms(fc, L).items()}
    n_max = 3 * len(maps)
    for n in range(n_max + 1):  # rank within each scenario
        order = sorted(per_kec, key=lambda k: -per_kec[k][n]["ha_at_risk"])
        for r, kid in enumerate(order, 1):
            per_kec[kid][n]["rank"] = r

    totals = {}
    for n in range(n_max + 1):
        rows = [per_kec[k][n] for k in per_kec]
        totals[str(n)] = {
            "class_ha": {str(c): round(sum(r["class_ha"].get(str(c), 0) for r in rows), 1)
                         for c in range(1, 6)},
            "active_ha": round(sum(r["active_ha"] for r in rows), 1),
            "ha_at_risk": round(sum(r["ha_at_risk"] for r in rows), 1),
        }

    # Sanity: N = 0 must reproduce the observed scoring on disk (up to binning)
    kec = json.loads((WEB_DATA_DIR / "kecamatan.json").read_text())
    diffs = [abs(f["properties"]["ha_at_risk"] - per_kec[f["properties"]["id"]][0]["ha_at_risk"])
             for f in kec["features"]]
    print(f"  N=0 vs observed ha_at_risk: max diff {max(diffs):.1f} ha")

    deciles = PCTS[9::10]
    out = {
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "period_id": current,
        "max_dasarian": n_max,
        "method": "quantile_mapping",
        "calibration": {
            "rain_max_mm": SCENARIO["calib_max_month_mm"],
            "months": [{"pair": d["pair"], "rain_mm": d["rain_mm"],
                        "kec_mae_ha": d["kec_mae_ha"], "kec_bias_ha": d["kec_bias_ha"],
                        "persist_mae_ha": d["persist_mae_ha"], "kec_mean_ha": d["kec_mean_ha"],
                        "percentiles": deciles,
                        "before": [round(float(d["before"][p - 1]), 3) for p in deciles],
                        "after": [round(float(d["after"][p - 1]), 3) for p in deciles]}
                       for d in dry],
        },
        "totals": totals,
        "kecamatan": {kid: {str(n): s for n, s in sc.items()} for kid, sc in per_kec.items()},
    }
    (WEB_DATA_DIR / "scenario.json").write_text(json.dumps(out, indent=1))

    for k, d in enumerate(dry, 1):
        print(f"\nDry month {k}: {d['pair']} (median rain {d['rain_mm']} mm); per-kec hindcast "
              f"Kuat+Ekstrem MAE {d['kec_mae_ha']} ha (no-change baseline {d['persist_mae_ha']}), bias {d['kec_bias_ha']:+} ha "
              f"(mean observed {d['kec_mean_ha']} ha)")
        for p in (10, 25, 50, 75, 90):
            print(f"  p{p}: {d['before'][p - 1]:6.2f} -> {d['after'][p - 1]:6.2f}")
    print("\nScenario totals (Kuat+Ekstrem ha | ha at risk | Awas/Siaga/Waspada):")
    for n, t in totals.items():
        st = [per_kec[k][int(n)]["status"] for k in per_kec]
        print(f"  N={n}: {t['class_ha']['4'] + t['class_ha']['5']:>8.0f} | {t['ha_at_risk']:>8.0f} | "
              f"{st.count('Awas')}/{st.count('Siaga')}/{st.count('Waspada')}")


if __name__ == "__main__":
    main()
