"""Stage 0/1: compute agricultural drought (NDDI) for Pati with Google Earth
Engine and export it in the web app's data contract.

Method follows NgabubuGIS #2 (Izzuddin Muhammad, 2026):
  Landsat 8/9 TOA, <30% cloud, QA cloud mask, median mosaic
  NDVI = ND(NIR, Red); NDMI = ND(NIR, SWIR1); NDDI = (NDVI-NDMI)/(NDVI+NDMI)
  ESA WorldCover v200 class 40 (cropland) mask
  NDVI growth-stage classes, keep active stages 2-4
  NDDI null guard, 5-class reclassification (Artikanur et al., 2022)
  Per-kecamatan zonal stats at 30 m, areas from ee.Image.pixelArea()

Setup (once):
  pip install -r pipeline/requirements.txt
  earthengine authenticate
Run:
  python pipeline/gee_export.py --project YOUR_GCP_PROJECT
  python pipeline/gee_export.py --project X --start 2026-08-01 --end 2026-08-31
  python pipeline/gee_export.py --project X --last-months 6   # operational: rolling 6 months to today
  python pipeline/gee_export.py --project X --series 2024-05:2024-10   # fixed monthly series
"""

import argparse
import json
import shutil
import urllib.request
from datetime import date, timedelta

import ee

from config import (BOUNDARY_DIR, DEFAULT_END, DEFAULT_START, MAX_CLOUD_PCT,
                    NDDI_ABS_GUARD, NDDI_CLASSES, PHENOLOGY_CLASSES, TRAJECTORY,
                    TRAJECTORY_CLASSES, WEB_DATA_DIR)
from outputs import write_run

SCALE = 30
THUMB_PX = 1600  # longest side of exported PNG layers

# Reference values from the video, used only for the verification printout
VIDEO_REFERENCE = {"Tambakromo": 2.647, "Cluwak": 0.3}


def cloud_mask_l89_toa(img):
    qa = img.select("QA_PIXEL")
    dilated, cloud, shadow = 1 << 1, 1 << 3, 1 << 4
    clear = (qa.bitwiseAnd(dilated).eq(0)
             .And(qa.bitwiseAnd(cloud).eq(0))
             .And(qa.bitwiseAnd(shadow).eq(0)))
    return img.updateMask(clear)


def classify(img, classes):
    """Reclassify a continuous band with half-open [lo, hi) bins."""
    out = ee.Image(0)
    for cid, lo, hi, *_ in classes:
        cond = ee.Image(1)
        if lo != float("-inf"):
            cond = cond.And(img.gte(lo))
        if hi != float("inf"):
            cond = cond.And(img.lt(hi))
        out = out.where(cond, cid)
    return out.updateMask(img.mask()).rename("class").toByte()


def load_kecamatan():
    gj = json.loads((BOUNDARY_DIR / "pati_kecamatan.geojson").read_text())
    feats = [ee.Feature(f["geometry"], {"kec_id": f["properties"]["id"],
                                        "name": f["properties"]["name"]})
             for f in gj["features"]]
    return ee.FeatureCollection(feats)


def local_bbox(pad=0.005):
    gj = json.loads((BOUNDARY_DIR / "pati_kecamatan.geojson").read_text())
    xs, ys = [], []

    def walk(c):
        if isinstance(c[0], (int, float)):
            xs.append(c[0]); ys.append(c[1])
        else:
            for x in c:
                walk(x)
    for f in gj["features"]:
        walk(f["geometry"]["coordinates"])
    return [round(min(xs) - pad, 6), round(min(ys) - pad, 6),
            round(max(xs) + pad, 6), round(max(ys) + pad, 6)]


def landsat(aoi, start, end):
    return (ee.ImageCollection("LANDSAT/LC08/C02/T1_TOA")
            .merge(ee.ImageCollection("LANDSAT/LC09/C02/T1_TOA"))
            .filterBounds(aoi)
            .filterDate(start, end)
            .filter(ee.Filter.lt("CLOUD_COVER", MAX_CLOUD_PCT)))


def month_ndvi(aoi, start, end):
    """Monthly median NDVI; fully masked if the month has no usable scene."""
    col = landsat(aoi, start, end).map(cloud_mask_l89_toa)
    empty = ee.Image.constant(0).toFloat().updateMask(0).rename("NDVI")
    ndvi = col.median().normalizedDifference(["B5", "B4"]).rename("NDVI").toFloat()
    return ee.Image(ee.Algorithms.If(col.size().gt(0), ndvi, empty))


def trajectory_stage(ndvi, history):
    """Growth stage from the NDVI trajectory (see config.TRAJECTORY).
    history: monthly NDVI images before this period, oldest first."""
    t = TRAJECTORY
    win = [*history, ndvi.toFloat()]
    peak = ee.ImageCollection(win).max()
    # Which month held the peak (0 .. len(win)-1)
    peak_idx = ee.ImageCollection(
        [w.addBands(ee.Image.constant(k).toFloat().rename("k")) for k, w in enumerate(win)]
    ).qualityMosaic("NDVI").select("k")
    prev = history[-1].unmask(ndvi)  # no data last month -> treat as flat
    delta = ndvi.subtract(prev)
    rising = delta.gte(t["trend_eps"])
    falling = delta.lte(-t["trend_eps"]).And(peak.gte(t["harvest_peak_min"]))

    stage = (ee.Image(2)
             .where(ndvi.gte(0.30), 3)
             .where(ndvi.gte(0.50), 4)
             .where(ndvi.gte(0.50).And(rising), 3)
             .where(falling, 4))
    harvested = (peak.gte(t["harvest_peak_min"])
                 .And(peak_idx.lt(len(win) - 1))
                 .And(ndvi.lte(peak.subtract(t["harvest_drop"])))
                 .And(ndvi.lt(t["harvest_ndvi_max"])))
    stage = (stage.where(harvested, 7)
             .where(peak.lt(t["fallow_peak_max"]), 6)
             .where(ndvi.lt(-0.03), 1))  # open water / flooded, as in single-date mode
    return stage.updateMask(ndvi.mask()).rename("class").toByte()


def build(aoi, start, end, history=None):
    """history: previous monthly NDVI images (oldest first). When given, the
    growth stage comes from the NDVI trajectory; otherwise from single-date
    NDVI thresholds (the video's method, used for the Aug 2024 check)."""
    col = landsat(aoi, start, end)
    mosaic = col.map(cloud_mask_l89_toa).median().clip(aoi)

    ndvi = mosaic.normalizedDifference(["B5", "B4"]).rename("NDVI")
    ndmi = mosaic.normalizedDifference(["B5", "B6"]).rename("NDMI")
    # .expression, not .normalizedDifference: inputs are themselves signed
    nddi = mosaic.expression("(NDVI - NDMI) / (NDVI + NDMI)",
                             {"NDVI": ndvi, "NDMI": ndmi}).rename("NDDI")
    nddi = nddi.updateMask(nddi.abs().lt(NDDI_ABS_GUARD))  # null guard

    cropland = ee.ImageCollection("ESA/WorldCover/v200").first().eq(40)
    stage = (trajectory_stage(ndvi, history) if history else classify(ndvi, PHENOLOGY_CLASSES))
    stage = stage.updateMask(cropland).rename("stage")
    active = stage.gte(2).And(stage.lte(4))

    dclass = classify(nddi, NDDI_CLASSES).rename("dclass")
    valid = active.And(dclass.mask())
    joint = dclass.multiply(10).add(stage).updateMask(valid).rename("joint")

    return {
        "collection": col, "ndvi": ndvi, "ndmi": ndmi, "nddi": nddi,
        "cropland": cropland, "stage": stage, "active": valid,
        "dclass": dclass.updateMask(valid), "joint": joint,
    }


def zonal_stats(fc, L):
    area_ha = ee.Image.pixelArea().divide(1e4)

    joint = area_ha.updateMask(L["joint"].mask()).addBands(L["joint"]).reduceRegions(
        collection=fc, reducer=ee.Reducer.sum().group(groupField=1, groupName="code"),
        scale=SCALE, tileScale=4).getInfo()

    means = (ee.Image.cat([L["nddi"], L["ndvi"], L["ndmi"]])
             .updateMask(L["active"])
             .reduceRegions(collection=fc, reducer=ee.Reducer.mean(),
                            scale=SCALE, tileScale=4)).getInfo()

    crop = (area_ha.updateMask(L["cropland"].selfMask()).rename("crop_ha")
            .reduceRegions(collection=fc, reducer=ee.Reducer.sum(),
                           scale=SCALE, tileScale=4)).getInfo()

    # Cropland area per growth stage, incl. non-active ones (fallow, harvested)
    by_stage = area_ha.updateMask(L["stage"].mask()).addBands(L["stage"]).reduceRegions(
        collection=fc, reducer=ee.Reducer.sum().group(groupField=1, groupName="stage"),
        scale=SCALE, tileScale=4).getInfo()

    stats = {}
    for f in joint["features"]:
        p = f["properties"]
        jha = {}
        for g in p.get("groups", []):
            code = int(g["code"])
            c, s = code // 10, code % 10
            if 1 <= c <= 5 and 2 <= s <= 4:
                jha[f"c{c}s{s}"] = float(g["sum"])
        stats[p["kec_id"]] = {"joint_ha": jha}

    def rnd(v):
        return None if v is None else round(float(v), 3)

    for f in means["features"]:
        p = f["properties"]
        stats[p["kec_id"]].update({"mean_nddi": rnd(p.get("NDDI")),
                                   "mean_ndvi": rnd(p.get("NDVI")),
                                   "mean_ndmi": rnd(p.get("NDMI"))})
    for f in crop["features"]:
        p = f["properties"]
        stats[p["kec_id"]]["cropland_ha"] = round(float(p.get("sum") or 0), 1)
    for f in by_stage["features"]:
        p = f["properties"]
        stats[p["kec_id"]]["cropland_stage_ha"] = {
            str(int(g["stage"])): round(float(g["sum"]), 1) for g in p.get("groups", [])}
    return stats


def export_layers(L, bbox, out):
    out.mkdir(parents=True, exist_ok=True)
    region = ee.Geometry.Rectangle(bbox, proj="EPSG:4326", geodesic=False)

    class_palette = [c[5].lstrip("#") for c in NDDI_CLASSES]
    # stages 2..7: veg awal, veg akhir, reproduktif, pematangan, bera, panen
    stage_palette = ["c7e9a0", "6cc04a", "f2c94c", "a0785a", "5b6170", "d4b483"]
    vis = {
        "nddi_class": L["dclass"].visualize(min=1, max=5, palette=class_palette),
        "nddi": L["nddi"].updateMask(L["active"]).visualize(
            min=-1, max=4, palette=["2b83ba", "abdda4", "fdae61", "e8553d", "8b0a1a"]),
        "ndvi": L["ndvi"].updateMask(L["cropland"]).visualize(
            min=0, max=0.7, palette=["8c5a2b", "d9c36a", "8fcf5a", "1a7f37"]),
        "ndmi": L["ndmi"].updateMask(L["cropland"]).visualize(
            min=-0.8, max=0.6, palette=["8c3b1a", "e0a050", "f2efc7", "5bb0d9", "1f4e9c"]),
        "stage": L["stage"].updateMask(L["stage"].gte(2)).visualize(
            min=2, max=7, palette=stage_palette),
    }
    for name, img in vis.items():
        url = img.getThumbURL({"region": region, "dimensions": THUMB_PX,
                               "format": "png", "crs": "EPSG:4326"})
        with urllib.request.urlopen(url) as r:
            (out / f"{name}.png").write_bytes(r.read())
        print(f"  layer {name}.png")


BULAN = ["Januari", "Februari", "Maret", "April", "Mei", "Juni", "Juli",
         "Agustus", "September", "Oktober", "November", "Desember"]


def month_periods(spec):
    """'2024-05:2024-10' -> [(id, start, end_exclusive, label), ...]"""
    a, b = spec.split(":")
    y, m = map(int, a.split("-"))
    y2, m2 = map(int, b.split("-"))
    out = []
    while (y, m) <= (y2, m2):
        ny, nm = (y + 1, 1) if m == 12 else (y, m + 1)
        out.append((f"{y}-{m:02d}", f"{y}-{m:02d}-01", f"{ny}-{nm:02d}-01",
                    f"{BULAN[m - 1]} {y}"))
        y, m = ny, nm
    return out


def last_months(n, today=None):
    """Rolling window: the last n calendar months up to and including the
    current (partial) month. The partial month ends tomorrow and is labelled
    as running ("berjalan")."""
    today = today or date.today()
    y, m = today.year, today.month - (n - 1)
    while m < 1:
        y, m = y - 1, m + 12
    out = month_periods(f"{y}-{m:02d}:{today.year}-{today.month:02d}")
    pid, start, _, label = out[-1]
    out[-1] = (pid, start, (today + timedelta(days=1)).isoformat(),
               f"{label} (s.d. {today.day} {BULAN[today.month - 1][:3]}, berjalan)")
    return out


def run_period(fc, aoi, bbox, start, end, layers_out, history=None):
    """Compute one composite: zonal stats + PNG layers. None if no scenes."""
    L = build(aoi, start, end, history)
    n = L["collection"].size().getInfo()
    if n == 0:
        return None
    dates = sorted(set(L["collection"].aggregate_array("DATE_ACQUIRED").getInfo()))
    print(f"  {n} scenes: {dates}")
    print("  zonal statistics ...")
    stats = zonal_stats(fc, L)
    print("  raster layers ...")
    export_layers(L, bbox, layers_out)
    source = {"imagery": f"Landsat 8/9 TOA C2, {n} scene, awan <{MAX_CLOUD_PCT}%",
              "scenes": dates,
              "landcover": "ESA WorldCover v200 (peta 2021), kelas 40 Cropland",
              "boundaries": "BPS 2020 via HDX"}
    return stats, source


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--project", required=True, help="Earth Engine Cloud project id")
    ap.add_argument("--start", default=DEFAULT_START)
    ap.add_argument("--end", default=DEFAULT_END)
    ap.add_argument("--series", help="monthly series YYYY-MM:YYYY-MM, e.g. 2024-05:2024-10 "
                                     "(overrides --start/--end)")
    ap.add_argument("--last-months", type=int, metavar="N",
                    help="rolling monthly series: the last N months up to today "
                         "(operational mode; overrides --series and --start/--end)")
    ap.add_argument("--current", help="period id shown by default (series mode; "
                                      "default: last period with data)")
    args = ap.parse_args()

    ee.Initialize(project=args.project)
    fc = load_kecamatan()
    aoi = fc.geometry()
    bbox = local_bbox()  # [west, south, east, north]

    periods = None
    current_id = None
    if args.last_months or args.series:
        plan = last_months(args.last_months) if args.last_months else month_periods(args.series)
        periods = []
        # Monthly NDVI for the trajectory window: context months before the
        # first period (not exported) + every period in the plan
        n_ctx = TRAJECTORY["window_months"] - 1
        y, m = map(int, plan[0][0].split("-"))
        m -= n_ctx
        while m < 1:
            y, m = y - 1, m + 12
        ctx = month_periods(f"{y}-{m:02d}:{plan[0][0]}")[:-1]
        ndvi_by_month = [month_ndvi(aoi, s, e) for _, s, e, _ in ctx + plan]
        for i, (pid, start, end, label) in enumerate(plan):
            print(f"{label} ({start} .. {end})")
            layers_dir = f"periods/{pid}/layers"
            history = ndvi_by_month[i:i + n_ctx]
            res = run_period(fc, aoi, bbox, start, end, WEB_DATA_DIR / layers_dir, history)
            if res is None:
                print("  no scenes, skipped")
                continue
            stats_p, source_p = res
            periods.append({"id": pid, "start": start, "end": end, "label": label,
                            "layers_dir": layers_dir, "source": source_p, "stats": stats_p})
        if not periods:
            raise SystemExit("No Landsat scenes in any period of the series.")
        cur = next((p for p in periods if p["id"] == args.current), periods[-1])
        current_id = cur["id"]
        # Mirror the current period at the top level (contract v1 readers)
        top = WEB_DATA_DIR / "layers"
        top.mkdir(parents=True, exist_ok=True)
        for png in (WEB_DATA_DIR / cur["layers_dir"]).glob("*.png"):
            shutil.copyfile(png, top / png.name)
        stats, source = cur["stats"], cur["source"]
        period = {"start": cur["start"], "end": cur["end"], "label": cur["label"]}
        # Retention: drop raster folders of periods outside this run
        keep = {p["id"] for p in periods}
        for d in (WEB_DATA_DIR / "periods").glob("*"):
            if d.is_dir() and d.name not in keep:
                shutil.rmtree(d)
                print(f"  removed old period {d.name}")
    else:
        res = run_period(fc, aoi, bbox, args.start, args.end, WEB_DATA_DIR / "layers")
        if res is None:
            raise SystemExit("No Landsat scenes match; widen --start/--end or the cloud limit.")
        stats, source = res
        period = {"start": args.start, "end": args.end, "label": f"{args.start} s.d. {args.end}"}

    layers = [
        {"id": "nddi_class", "file": "layers/nddi_class.png", "label": "Kelas kekeringan (NDDI)", "legend": "nddi_classes"},
        {"id": "nddi", "file": "layers/nddi.png", "label": "NDDI kontinu", "legend": "nddi_ramp"},
        {"id": "ndvi", "file": "layers/ndvi.png", "label": "NDVI (kehijauan)", "legend": "ndvi_ramp"},
        {"id": "ndmi", "file": "layers/ndmi.png", "label": "NDMI (kelembapan)", "legend": "ndmi_ramp"},
        {"id": "stage", "file": "layers/stage.png", "label": "Fase tumbuh padi", "legend": "stage_classes"},
    ]
    meta = write_run(
        mode="gee", period=period, source=source,
        bounds=bbox, layers=layers, stats=stats,
        notes=["Ambang fase tumbuh (NDVI) masih provisional, lihat config.py.",
               *(["Fase tumbuh dari lintasan NDVI 4 bulan: lahan yang tidak pernah hijau dihitung "
                  "sebagai bera, yang sudah turun ke tanah terbuka setelah puncak sebagai panen. "
                  "Keduanya tidak dihitung sebagai padi aktif; mohon cek lapangan."] if periods else []),
               "Lahan pertanian ESA tidak membedakan padi sawah dan palawija."],
        periods=periods, current_period=current_id,
        extra_stage_classes=TRAJECTORY_CLASSES if periods else None,
    )
    if periods:
        print("\nPeriods:", ", ".join(f"{p['id']} ({len(p['source']['scenes'])} dates)" for p in periods),
              f"| current {current_id}")

    print("\nTotal ha per class:", meta["totals"]["class_ha"])
    if period["start"][:7] != "2024-08":
        return
    # Verification against the video's published numbers (Aug 2024 only)
    print("Video reference:",
          "(video: Kuat ~11,000 ha, Normal ~19 ha)")
    kec = json.loads((WEB_DATA_DIR / "kecamatan.json").read_text())
    for f in kec["features"]:
        p = f["properties"]
        if p["name"] in VIDEO_REFERENCE:
            print(f"  {p['name']}: mean NDDI {p['mean_nddi']} (video {VIDEO_REFERENCE[p['name']]})")


if __name__ == "__main__":
    main()
