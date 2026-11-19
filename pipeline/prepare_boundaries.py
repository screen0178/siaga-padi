"""Build kecamatan (and simplified desa) boundaries for Pati from BPS village
polygons (HDX-BPS-2020, via github.com/JfrAziz/indonesia-district).

Usage: python pipeline/prepare_boundaries.py
"""

import json
import math

from shapely.geometry import mapping, shape
from shapely.ops import unary_union

from config import BOUNDARY_DIR

RAW = BOUNDARY_DIR / "pati_desa_bps2020_raw.geojson"
SIMPLIFY_DEG = 0.0003  # ~33 m, enough for a regency-scale map


def area_ha(geom) -> float:
    """Approximate area in hectares (local equirectangular scaling).
    Good to <1% at Pati's latitude; GEE recomputes exact pixel areas."""
    lat = geom.centroid.y
    kx = 111_320 * math.cos(math.radians(lat))
    ky = 110_574
    return geom.area * kx * ky / 10_000


def round_coords(obj, nd=5):
    if isinstance(obj, (list, tuple)):
        if obj and isinstance(obj[0], (int, float)):
            return [round(v, nd) for v in obj]
        return [round_coords(o, nd) for o in obj]
    return obj


def to_feature(geom, props):
    g = mapping(geom)
    return {"type": "Feature", "properties": props,
            "geometry": {"type": g["type"], "coordinates": round_coords(g["coordinates"])}}


def main():
    raw = json.loads(RAW.read_text())
    by_kec: dict[str, dict] = {}
    desa = []
    for f in raw["features"]:
        p = f["properties"]
        geom = shape(f["geometry"]).buffer(0)
        k = by_kec.setdefault(p["district_code"], {"name": p["district"], "geoms": []})
        k["geoms"].append(geom)
        desa.append(to_feature(geom.simplify(SIMPLIFY_DEG, preserve_topology=True), {
            "id": p["village_code"], "name": p["village"],
            "kec_id": p["district_code"], "kec_name": p["district"],
        }))

    kec = []
    for code, k in sorted(by_kec.items()):
        merged = unary_union(k["geoms"]).buffer(0)
        c = merged.representative_point()
        kec.append(to_feature(merged.simplify(SIMPLIFY_DEG, preserve_topology=True), {
            "id": code, "name": k["name"], "area_ha": round(area_ha(merged), 1),
            "n_desa": len(k["geoms"]), "label_lon": round(c.x, 5), "label_lat": round(c.y, 5),
        }))

    src = {"source": "BPS 2020 via HDX (github.com/JfrAziz/indonesia-district)"}
    (BOUNDARY_DIR / "pati_kecamatan.geojson").write_text(json.dumps(
        {"type": "FeatureCollection", "metadata": src, "features": kec}))
    (BOUNDARY_DIR / "pati_desa.geojson").write_text(json.dumps(
        {"type": "FeatureCollection", "metadata": src, "features": desa}))
    total = sum(f["properties"]["area_ha"] for f in kec)
    print(f"{len(kec)} kecamatan, {len(desa)} desa, total {total:,.0f} ha")


if __name__ == "__main__":
    main()
