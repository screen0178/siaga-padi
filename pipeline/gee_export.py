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
"""

import argparse
import json
import urllib.request

import ee

from config import (BOUNDARY_DIR, DEFAULT_END, DEFAULT_START, MAX_CLOUD_PCT,
                    NDDI_ABS_GUARD, NDDI_CLASSES, PHENOLOGY_CLASSES, WEB_DATA_DIR)
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


def build(aoi, start, end):
    col = (ee.ImageCollection("LANDSAT/LC08/C02/T1_TOA")
           .merge(ee.ImageCollection("LANDSAT/LC09/C02/T1_TOA"))
           .filterBounds(aoi)
           .filterDate(start, end)
           .filter(ee.Filter.lt("CLOUD_COVER", MAX_CLOUD_PCT)))
    mosaic = col.map(cloud_mask_l89_toa).median().clip(aoi)

    ndvi = mosaic.normalizedDifference(["B5", "B4"]).rename("NDVI")
    ndmi = mosaic.normalizedDifference(["B5", "B6"]).rename("NDMI")
    # .expression, not .normalizedDifference: inputs are themselves signed
    nddi = mosaic.expression("(NDVI - NDMI) / (NDVI + NDMI)",
                             {"NDVI": ndvi, "NDMI": ndmi}).rename("NDDI")
    nddi = nddi.updateMask(nddi.abs().lt(NDDI_ABS_GUARD))  # null guard

    cropland = ee.ImageCollection("ESA/WorldCover/v200").first().eq(40)
    stage = classify(ndvi, PHENOLOGY_CLASSES).updateMask(cropland).rename("stage")
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
    return stats


def export_layers(L, bbox):
    out = WEB_DATA_DIR / "layers"
    out.mkdir(parents=True, exist_ok=True)
    region = ee.Geometry.Rectangle(bbox, proj="EPSG:4326", geodesic=False)

    class_palette = [c[5].lstrip("#") for c in NDDI_CLASSES]
    stage_palette = ["c7e9a0", "6cc04a", "f2c94c", "a0785a"]
    vis = {
        "nddi_class": L["dclass"].visualize(min=1, max=5, palette=class_palette),
        "nddi": L["nddi"].updateMask(L["active"]).visualize(
            min=-1, max=4, palette=["2b83ba", "abdda4", "fdae61", "e8553d", "8b0a1a"]),
        "ndvi": L["ndvi"].updateMask(L["cropland"]).visualize(
            min=0, max=0.7, palette=["8c5a2b", "d9c36a", "8fcf5a", "1a7f37"]),
        "ndmi": L["ndmi"].updateMask(L["cropland"]).visualize(
            min=-0.8, max=0.6, palette=["8c3b1a", "e0a050", "f2efc7", "5bb0d9", "1f4e9c"]),
        "stage": L["stage"].updateMask(L["stage"].gte(2)).visualize(
            min=2, max=5, palette=stage_palette),
    }
    for name, img in vis.items():
        url = img.getThumbURL({"region": region, "dimensions": THUMB_PX,
                               "format": "png", "crs": "EPSG:4326"})
        with urllib.request.urlopen(url) as r:
            (out / f"{name}.png").write_bytes(r.read())
        print(f"  layer {name}.png")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--project", required=True, help="Earth Engine Cloud project id")
    ap.add_argument("--start", default=DEFAULT_START)
    ap.add_argument("--end", default=DEFAULT_END)
    args = ap.parse_args()

    ee.Initialize(project=args.project)
    fc = load_kecamatan()
    aoi = fc.geometry()
    bbox = local_bbox()  # [west, south, east, north]

    L = build(aoi, args.start, args.end)
    n = L["collection"].size().getInfo()
    if n == 0:
        raise SystemExit("No Landsat scenes match; widen --start/--end or the cloud limit.")
    dates = L["collection"].aggregate_array("DATE_ACQUIRED").getInfo()
    print(f"{n} scenes: {sorted(set(dates))}")

    print("zonal statistics ...")
    stats = zonal_stats(fc, L)
    print("raster layers ...")
    export_layers(L, bbox)

    layers = [
        {"id": "nddi_class", "file": "layers/nddi_class.png", "label": "Kelas kekeringan (NDDI)", "legend": "nddi_classes"},
        {"id": "nddi", "file": "layers/nddi.png", "label": "NDDI kontinu", "legend": "nddi_ramp"},
        {"id": "ndvi", "file": "layers/ndvi.png", "label": "NDVI (kehijauan)", "legend": "ndvi_ramp"},
        {"id": "ndmi", "file": "layers/ndmi.png", "label": "NDMI (kelembapan)", "legend": "ndmi_ramp"},
        {"id": "stage", "file": "layers/stage.png", "label": "Fase tumbuh padi", "legend": "stage_classes"},
    ]
    meta = write_run(
        mode="gee",
        period={"start": args.start, "end": args.end, "label": f"{args.start} s.d. {args.end}"},
        source={"imagery": f"Landsat 8/9 TOA C2, {n} scene, awan <{MAX_CLOUD_PCT}%",
                "scenes": sorted(set(dates)),
                "landcover": "ESA WorldCover v200 (peta 2021), kelas 40 Cropland",
                "boundaries": "BPS 2020 via HDX"},
        bounds=bbox, layers=layers, stats=stats,
        notes=["Ambang fase tumbuh (NDVI) masih provisional, lihat config.py.",
               "Lahan pertanian ESA tidak membedakan padi sawah dan palawija."],
    )

    # Verification against the video's published numbers
    print("\nTotal ha per class:", meta["totals"]["class_ha"],
          "(video: Kuat ~11,000 ha, Normal ~19 ha)")
    kec = json.loads((WEB_DATA_DIR / "kecamatan.json").read_text())
    for f in kec["features"]:
        p = f["properties"]
        if p["name"] in VIDEO_REFERENCE:
            print(f"  {p['name']}: mean NDDI {p['mean_nddi']} (video {VIDEO_REFERENCE[p['name']]})")


if __name__ == "__main__":
    main()
