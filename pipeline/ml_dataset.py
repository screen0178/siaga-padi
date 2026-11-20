"""v2 Phase 2.1: training data for the NDDI forecast.

Unit: desa x Landsat acquisition date, 2013 onwards. Same masks and indices
as gee_export.py (TOA C2, QA cloud mask, ESA cropland, |NDDI| guard, NDVI
stages 2-4 = active rice, Artikanur NDDI classes), but per *date* instead of
per month: the model learns how the drought share moves between two
observations of the same desa a few weeks apart.

Per (desa, date), areas in ha:
  valid_ha   cloud-free cropland        active_ha  of which active rice
  c1..c5     active ha per NDDI class   s2..s4     active ha per growth stage
  bare_ha    cropland NDVI < -0.03      ripe_ha    cropland NDVI >= 0.65
and area-weighted sums (divide by active_ha / valid_ha for the mean):
  nddi_sum, ndvi_sum, ndmi_sum (active), ndvi_valid_sum (all valid cropland)
Plus once per desa: crop_ha (ESA cropland).

Rain: daily precipitation per kecamatan label point from the Open-Meteo
archive (ERA5-based), the same provider the forecast uses at run time
(CHIRPS would differ systematically from the inference-time source).

Run (long, resumable; re-running skips dates already done):
  python pipeline/ml_dataset.py --project scourge-earth
  python pipeline/ml_dataset.py --project X --years 2024 2025 --workers 6
  python pipeline/ml_dataset.py --rain-only
Writes data/ml/obs_<year>.csv, data/ml/obs_done.txt, data/ml/desa_static.csv,
data/ml/rain_daily.csv (all git-ignored, rebuilt from the sources).
"""

import argparse
import csv
import json
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import date, timedelta

import ee

from config import BOUNDARY_DIR, NDDI_ABS_GUARD, NDDI_CLASSES, ROOT, WEATHER

ML_DIR = ROOT / "data" / "ml"
FIRST = "2013-04-01"   # Landsat 8 operational
MAX_SCENE_CLOUD = 70   # scene filter; pixels are cloud-masked anyway
MIN_DATE_VALID = 0.05  # skip a date when < 5 % of Pati cropland is clear
SCALE = 30
COLS = ["date", "desa_id", "valid_ha", "active_ha", "c1", "c2", "c3", "c4", "c5", "s2", "s3", "s4",
        "bare_ha", "ripe_ha", "nddi_sum", "ndvi_sum", "ndmi_sum", "ndvi_valid_sum"]

_lock = threading.Lock()


def desa_fc():
    gj = json.loads((BOUNDARY_DIR / "pati_desa.geojson").read_text())
    return ee.FeatureCollection([ee.Feature(f["geometry"], {"desa_id": f["properties"]["id"]})
                                 for f in gj["features"]])


def cropland():
    return ee.ImageCollection("ESA/WorldCover/v200").first().eq(40)


def collection(aoi, start, end):
    return (ee.ImageCollection("LANDSAT/LC08/C02/T1_TOA")
            .merge(ee.ImageCollection("LANDSAT/LC09/C02/T1_TOA"))
            .filterBounds(aoi).filterDate(start, end)
            .filter(ee.Filter.lt("CLOUD_COVER", MAX_SCENE_CLOUD)))


def list_dates(aoi, start, end):
    return sorted(set(collection(aoi, start, end).aggregate_array("DATE_ACQUIRED").getInfo()))


def date_image(aoi, d: str):
    """Multiband image of areas (ha) and weighted sums for one acquisition date."""
    from gee_export import cloud_mask_l89_toa
    nxt = (date.fromisoformat(d) + timedelta(days=1)).isoformat()
    m = collection(aoi, d, nxt).map(cloud_mask_l89_toa).mosaic()
    ndvi = m.normalizedDifference(["B5", "B4"])
    ndmi = m.normalizedDifference(["B5", "B6"])
    nddi = ndvi.subtract(ndmi).divide(ndvi.add(ndmi))
    crop = cropland()
    valid = crop.And(nddi.abs().lt(NDDI_ABS_GUARD)).And(ndvi.mask()).unmask(0).And(crop)
    active = valid.And(ndvi.gte(-0.03)).And(ndvi.lt(0.65))
    ha = ee.Image.pixelArea().divide(1e4)
    bands = {"valid_ha": valid, "active_ha": active,
             "bare_ha": valid.And(ndvi.lt(-0.03)), "ripe_ha": valid.And(ndvi.gte(0.65)),
             "s2": active.And(ndvi.lt(0.25)), "s3": active.And(ndvi.gte(0.25)).And(ndvi.lt(0.45)),
             "s4": active.And(ndvi.gte(0.45))}
    for cid, lo, hi, *_ in NDDI_CLASSES:
        c = active
        if lo != float("-inf"):
            c = c.And(nddi.gte(lo))
        if hi != float("inf"):
            c = c.And(nddi.lt(hi))
        bands[f"c{cid}"] = c
    imgs = [ha.updateMask(v).unmask(0).rename(k) for k, v in bands.items()]
    a = ha.updateMask(active)
    imgs += [nddi.multiply(a).unmask(0).rename("nddi_sum"), ndvi.multiply(a).unmask(0).rename("ndvi_sum"),
             ndmi.multiply(a).unmask(0).rename("ndmi_sum"),
             ndvi.multiply(ha.updateMask(valid)).unmask(0).rename("ndvi_valid_sum")]
    return ee.Image.cat(imgs).toFloat()


def date_rows(aoi, fc, d: str, crop_total: float):
    img = date_image(aoi, d)
    # Cheap check first: is any of Pati's cropland clear on this date?
    v = img.select("valid_ha").reduceRegion(ee.Reducer.sum(), aoi, SCALE * 4, tileScale=4,
                                            maxPixels=1e9).get("valid_ha").getInfo() or 0
    v *= 16  # sampled at 4x the pixel size
    if v < MIN_DATE_VALID * crop_total:
        return []
    out = img.reduceRegions(collection=fc, reducer=ee.Reducer.sum(), scale=SCALE, tileScale=4).getInfo()
    rows = []
    for f in out["features"]:
        p = f["properties"]
        if (p.get("valid_ha") or 0) < 0.5:
            continue
        rows.append([d, p["desa_id"], *(round(p.get(c) or 0, 3) for c in COLS[2:])])
    return rows


def static(fc):
    """Cropland ha per desa (ESA, does not change over time)."""
    path = ML_DIR / "desa_static.csv"
    if path.exists():
        return {r["desa_id"]: float(r["crop_ha"]) for r in csv.DictReader(path.open())}
    ha = ee.Image.pixelArea().divide(1e4).updateMask(cropland()).unmask(0).rename("crop_ha")
    dem = ee.Image("USGS/SRTMGL1_003").rename("elev")
    out = ha.addBands(dem).reduceRegions(collection=fc, reducer=ee.Reducer.sum().combine(
        ee.Reducer.mean(), sharedInputs=True), scale=SCALE, tileScale=4).getInfo()
    rows = {f["properties"]["desa_id"]: (f["properties"].get("crop_ha_sum") or 0, f["properties"].get("elev_mean"))
            for f in out["features"]}
    gj = json.loads((BOUNDARY_DIR / "pati_desa.geojson").read_text())
    kec = {f["properties"]["id"]: f["properties"]["kec_id"] for f in gj["features"]}
    with path.open("w", newline="") as fh:
        w = csv.writer(fh)
        w.writerow(["desa_id", "kec_id", "crop_ha", "elev_m"])
        for did, (c, e) in sorted(rows.items()):
            w.writerow([did, kec[did], round(c, 2), round(e, 1) if e is not None else ""])
    return {k: v[0] for k, v in rows.items()}


def done_dates():
    p = ML_DIR / "obs_done.txt"
    return set(p.read_text().split()) if p.exists() else set()


def record(d, rows):
    with _lock:
        path = ML_DIR / f"obs_{d[:4]}.csv"
        new = not path.exists()
        with path.open("a", newline="") as fh:
            w = csv.writer(fh)
            if new:
                w.writerow(COLS)
            w.writerows(rows)
        with (ML_DIR / "obs_done.txt").open("a") as fh:
            fh.write(d + "\n")


def export_landsat(years, workers):
    from gee_export import local_bbox
    aoi = ee.Geometry.Rectangle(local_bbox())
    fc = desa_fc()
    crop = static(fc)
    crop_total = sum(crop.values())
    done = done_dates()
    start = f"{min(years)}-01-01" if years else FIRST
    end = f"{max(years) + 1}-01-01" if years else (date.today() + timedelta(days=1)).isoformat()
    todo = [d for d in list_dates(aoi, max(start, FIRST), end) if d not in done]
    print(f"{len(todo)} dates to export ({len(done)} already done)", flush=True)
    t0 = time.time()

    def job(d):
        for attempt in range(4):
            try:
                return d, date_rows(aoi, fc, d, crop_total)
            except ee.EEException as e:
                if attempt == 3:
                    raise
                print(f"  {d}: retry after {e}", flush=True)
                time.sleep(10 * (attempt + 1))

    n = 0
    with ThreadPoolExecutor(workers) as ex:
        for fut in as_completed([ex.submit(job, d) for d in todo]):
            try:
                d, rows = fut.result()
            except Exception as e:  # keep going; the date stays undone for the next run
                print(f"  failed: {e}", flush=True)
                continue
            record(d, rows)
            n += 1
            if n % 10 == 0 or n == len(todo):
                el = time.time() - t0
                print(f"  {n}/{len(todo)} dates, {el / 60:.1f} min, ~{el / n * (len(todo) - n) / 60:.0f} min left "
                      f"(last {d}: {len(rows)} desa)", flush=True)


def export_rain():
    """Daily archive rain per kecamatan, 2013 to the archive's lag."""
    from weather import daily_rain, kecamatan_points
    pts = kecamatan_points()
    end = (date.today() - timedelta(days=WEATHER["archive_lag_days"])).isoformat()
    rain = {}
    # Year by year keeps each response small
    for y in range(2013, date.today().year + 1):
        s, e = f"{y}-01-01", min(f"{y}-12-31", end)
        for kid, days in daily_rain(pts, start=s, end=e).items():
            rain.setdefault(kid, {}).update(days)
        print(f"  rain {y}", flush=True)
        time.sleep(1)
    with (ML_DIR / "rain_daily.csv").open("w", newline="") as fh:
        w = csv.writer(fh)
        w.writerow(["kec_id", "date", "mm"])
        for kid, days in sorted(rain.items()):
            for d, v in sorted(days.items()):
                if v is not None:
                    w.writerow([kid, d, v])


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--project")
    ap.add_argument("--years", type=int, nargs="*")
    ap.add_argument("--workers", type=int, default=6)
    ap.add_argument("--rain-only", action="store_true")
    ap.add_argument("--no-rain", action="store_true")
    a = ap.parse_args()
    ML_DIR.mkdir(parents=True, exist_ok=True)
    if not a.no_rain:
        export_rain()
    if a.rain_only:
        return
    ee.Initialize(project=a.project)
    export_landsat(a.years, a.workers)


if __name__ == "__main__":
    sys.exit(main())
