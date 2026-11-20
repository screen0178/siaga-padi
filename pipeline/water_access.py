"""Phase 3.2: satellite proxy for dry-season water access, validated against
the official irrigation tables.

Per kecamatan: the share of ESA cropland that carried a real rice canopy
(NDVI >= WATER_ACCESS["ndvi_min"]) in a deep-dry month. Compared across the
21 kecamatan with the official 2024 irrigated share and the share planted
with rice >= 3 times a year (water through the dry season).

Run: python pipeline/water_access.py --project ID
Writes data/irrigation/water_access_2026.csv and prints the validation.
"""

import argparse
import csv

import ee
import numpy as np
from scipy.stats import pearsonr, spearmanr

import irrigation
from config import ROOT, WATER_ACCESS
from gee_export import SCALE, load_kecamatan, month_ndvi

OUT = ROOT / "data" / "irrigation" / "water_access_2026.csv"


def dry_green(aoi, months, ndvi_min):
    """1 where cropland reached ndvi_min in any of the months, else 0."""
    peak = ee.ImageCollection([month_ndvi(aoi, s, e).select("NDVI") for s, e in months]).max()
    cropland = ee.ImageCollection("ESA/WorldCover/v200").first().eq(40)
    return peak.gte(ndvi_min).unmask(0).updateMask(cropland).rename("green")


def per_kecamatan(fc, img):
    area = ee.Image.pixelArea().divide(1e4)
    stack = area.updateMask(img.mask()).rename("crop").addBands(area.multiply(img).rename("green"))
    res = stack.reduceRegions(collection=fc, reducer=ee.Reducer.sum(), scale=SCALE, tileScale=4).getInfo()
    return {f["properties"]["kec_id"]: (f["properties"]["crop"], f["properties"]["green"]) for f in res["features"]}


def corr(x, y):
    x, y = np.asarray(x), np.asarray(y)
    return pearsonr(x, y)[0], spearmanr(x, y)[0]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--project", required=True)
    args = ap.parse_args()
    ee.Initialize(project=args.project)
    fc = load_kecamatan()
    aoi = fc.geometry()
    official = irrigation.load()
    if not official:
        raise SystemExit("Run pipeline/irrigation.py first.")

    main_stats = per_kecamatan(fc, dry_green(aoi, WATER_ACCESS["months"], WATER_ACCESS["ndvi_min"]))
    rows = []
    for kid, (crop, green) in main_stats.items():
        o = official[kid]
        rows.append({"kec_id": kid, "name": o["name"], "cropland_ha": round(crop, 1),
                     "dry_green_ha": round(green, 1), "dry_green_share": round(green / crop, 3) if crop else None,
                     "sawah_ha_official": o["sawah_ha"], "irrigated_share": o["irrigated_share"],
                     "rice3x_share": o["rice3x_share"]})
    rows.sort(key=lambda r: r["dry_green_share"])
    with OUT.open("w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=list(rows[0]))
        w.writeheader()
        w.writerows(rows)

    print(f"{OUT.name} (rule: NDVI >= {WATER_ACCESS['ndvi_min']} in Aug or Sep 2026)")
    print(f"  {'kecamatan':<15}{'ESA crop':>9}{'official':>9}{'dry-green':>10}{'irrig':>7}{'3x':>6}")
    for r in rows:
        print(f"  {r['name']:<15}{r['cropland_ha']:>9.0f}{r['sawah_ha_official']:>9.0f}"
              f"{r['dry_green_share']:>10.0%}{r['irrigated_share']:>7.0%}{r['rice3x_share']:>6.0%}")
    g = [r["dry_green_share"] for r in rows]
    for col in ("irrigated_share", "rice3x_share"):
        p, s = corr(g, [r[col] for r in rows])
        print(f"  dry-green share vs official {col:<16} Pearson r = {p:+.2f}, Spearman rho = {s:+.2f}")
    p, s = corr([r["cropland_ha"] for r in rows], [r["sawah_ha_official"] for r in rows])
    print(f"  ESA cropland ha vs official sawah ha: Pearson r = {p:+.2f}, Spearman rho = {s:+.2f}; "
          f"totals {sum(r['cropland_ha'] for r in rows):,.0f} vs {sum(r['sawah_ha_official'] for r in rows):,.0f} ha")

    print("Sensitivity (Spearman rho vs irrigated share / vs rice 3x share):")
    for name, (months, thr) in WATER_ACCESS["variants"].items():
        st = per_kecamatan(fc, dry_green(aoi, months or WATER_ACCESS["months"], thr))
        ids = [r["kec_id"] for r in rows]
        share = [st[k][1] / st[k][0] for k in ids]
        print(f"  {name:<14} " + " / ".join(
            f"{corr(share, [official[k][c] for k in ids])[1]:+.2f}" for c in ("irrigated_share", "rice3x_share"))
            + f"   (mean share {np.mean(share):.0%})")


if __name__ == "__main__":
    main()
