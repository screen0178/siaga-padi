"""Stage 0: generate realistic *sample* data so the app can be built and
demoed before the Earth Engine export has been run.

The numbers are seeded from the NgabubuGIS #2 findings for Pati, August 2024
(Tambakromo highest, mean NDDI ~2.65; then Batangan, Pucakwangi, Winong;
Cluwak lowest, ~0.3; ~11,000 ha in class Kuat). Pixels are synthetic. The app
labels this mode clearly as SAMPLE DATA.

Usage: python pipeline/make_placeholder.py
"""

import json

import numpy as np
from matplotlib.path import Path as MplPath
from PIL import Image
from scipy.ndimage import gaussian_filter

from config import BOUNDARY_DIR, NDDI_CLASSES, PHENOLOGY_CLASSES, WEB_DATA_DIR
from outputs import write_run

RES = 0.0005  # degrees per pixel (~55 m)
SEED = 20240815

# kec name -> (mean NDDI target, cropland fraction, stage mix weights v_awal/v_akhir/repro/matang)
PROFILE = {
    "Tambakromo": (2.65, 0.22, (0.10, 0.25, 0.50, 0.15)),
    "Batangan": (2.30, 0.20, (0.15, 0.30, 0.40, 0.15)),
    "Pucakwangi": (2.20, 0.20, (0.15, 0.40, 0.30, 0.15)),
    "Winong": (2.10, 0.20, (0.20, 0.30, 0.35, 0.15)),
    "Jaken": (1.80, 0.22, (0.25, 0.40, 0.20, 0.15)),
    "Jakenan": (1.60, 0.26, (0.20, 0.25, 0.40, 0.15)),
    "Kayen": (1.55, 0.20, (0.45, 0.25, 0.15, 0.15)),
    "Sukolilo": (1.45, 0.16, (0.50, 0.20, 0.10, 0.20)),
    "Gabus": (1.40, 0.26, (0.20, 0.45, 0.20, 0.15)),
    "Juwana": (1.30, 0.14, (0.30, 0.30, 0.25, 0.15)),
    "Pati": (1.10, 0.16, (0.30, 0.30, 0.25, 0.15)),
    "Margorejo": (1.00, 0.18, (0.35, 0.35, 0.15, 0.15)),
    "Wedarijaksa": (1.05, 0.22, (0.25, 0.25, 0.35, 0.15)),
    "Trangkil": (0.95, 0.20, (0.30, 0.40, 0.15, 0.15)),
    "Margoyoso": (0.90, 0.18, (0.40, 0.30, 0.15, 0.15)),
    "Tayu": (0.85, 0.18, (0.30, 0.30, 0.25, 0.15)),
    "Dukuhseti": (0.80, 0.16, (0.45, 0.25, 0.15, 0.15)),
    "Tlogowungu": (0.60, 0.12, (0.30, 0.40, 0.15, 0.15)),
    "Gembong": (0.45, 0.10, (0.30, 0.40, 0.15, 0.15)),
    "Gunung Wungkal": (0.40, 0.10, (0.30, 0.30, 0.25, 0.15)),
    "Cluwak": (0.30, 0.10, (0.30, 0.30, 0.25, 0.15)),
}


def smooth_noise(rng, shape, sigma):
    n = gaussian_filter(rng.standard_normal(shape), sigma)
    return (n - n.mean()) / (n.std() + 1e-9)


def classify(values, classes):
    out = np.zeros(values.shape, dtype=np.uint8)
    for cid, lo, hi, *_ in classes:
        out[(values >= lo) & (values < hi)] = cid
    return out


def hex_rgb(h):
    return tuple(int(h[i:i + 2], 16) for i in (1, 3, 5))


def save_png(rgba, path, colors=None):
    img = Image.fromarray(rgba)
    if colors:
        img = img.quantize(colors=colors, method=Image.Quantize.FASTOCTREE)
    img.save(path, optimize=True)


def ramp(values, stops, mask):
    """Linear colour ramp. stops: [(value, '#hex'), ...]"""
    rgba = np.zeros(values.shape + (4,), dtype=np.uint8)
    xs = np.array([s[0] for s in stops])
    cols = np.array([hex_rgb(s[1]) for s in stops], dtype=float)
    v = np.clip(np.nan_to_num(values, nan=xs[0]), xs[0], xs[-1])
    for ch in range(3):
        rgba[..., ch] = np.interp(v, xs, cols[:, ch]).astype(np.uint8)
    rgba[..., 3] = np.where(mask, 230, 0)
    return rgba


def main():
    rng = np.random.default_rng(SEED)
    kec = json.loads((BOUNDARY_DIR / "pati_kecamatan.geojson").read_text())

    # Grid over the regency
    from shapely.geometry import shape
    geoms = {f["properties"]["id"]: shape(f["geometry"]) for f in kec["features"]}
    names = {f["properties"]["id"]: f["properties"]["name"] for f in kec["features"]}
    w = min(g.bounds[0] for g in geoms.values()) - 0.005
    s = min(g.bounds[1] for g in geoms.values()) - 0.005
    e = max(g.bounds[2] for g in geoms.values()) + 0.005
    n = max(g.bounds[3] for g in geoms.values()) + 0.005
    nx, ny = int((e - w) / RES), int((n - s) / RES)
    e, s = w + nx * RES, n - ny * RES  # snap so pixels are exact
    lon = w + (np.arange(nx) + 0.5) * RES
    lat = n - (np.arange(ny) + 0.5) * RES
    LON, LAT = np.meshgrid(lon, lat)
    pts = np.column_stack([LON.ravel(), LAT.ravel()])

    kec_idx = np.zeros((ny, nx), dtype=np.int16)  # 0 = outside
    ids = list(geoms)
    for i, kid in enumerate(ids, 1):
        g = geoms[kid]
        polys = getattr(g, "geoms", [g])
        inside = np.zeros(len(pts), bool)
        for poly in polys:
            inside |= MplPath(np.asarray(poly.exterior.coords)).contains_points(pts)
        kec_idx[inside.reshape(ny, nx) & (kec_idx == 0)] = i

    # Fields: blocky smooth noise thresholded per kecamatan cropland fraction
    field_noise = smooth_noise(rng, (ny, nx), 2.0)
    stage_noise = smooth_noise(rng, (ny, nx), 3.0)
    nddi_noise = smooth_noise(rng, (ny, nx), 4.0)

    cropland = np.zeros((ny, nx), bool)
    stage = np.zeros((ny, nx), np.uint8)
    nddi = np.full((ny, nx), np.nan)
    for i, kid in enumerate(ids, 1):
        m = kec_idx == i
        mean_d, frac, mix = PROFILE[names[kid]]
        thr = np.quantile(field_noise[m], 1 - frac)
        cropland |= m & (field_noise >= thr)
        # assign stage by quantiles of stage noise -> spatially clustered fields
        cm = m & cropland
        q = np.cumsum(mix)[:-1]
        cuts = np.quantile(stage_noise[cm], q)
        st = np.digitize(stage_noise, cuts) + 2  # 2..5
        stage[cm] = st[cm]
        nddi[cm] = mean_d + 0.75 * nddi_noise[cm] + 0.25 * rng.standard_normal(cm.sum())

    # NDVI by stage, NDMI back-solved from NDDI = (V - M) / (V + M)
    stage_ndvi = {2: 0.15, 3: 0.36, 4: 0.55, 5: 0.72}
    ndvi = np.full((ny, nx), np.nan)
    for st, v in stage_ndvi.items():
        mm = stage == st
        ndvi[mm] = v + 0.05 * rng.standard_normal(mm.sum())
    ndmi = ndvi * (1 - nddi) / (1 + nddi)

    active = cropland & np.isin(stage, [2, 3, 4])
    dclass = classify(np.nan_to_num(nddi, nan=-999), NDDI_CLASSES)

    # Pixel area in ha (equirectangular approximation, fine for sample data)
    px_ha = (RES * 111_320 * np.cos(np.radians(LAT))) * (RES * 110_574) / 10_000

    stats = {}
    for i, kid in enumerate(ids, 1):
        m = kec_idx == i
        am = m & active
        joint = {}
        for c in range(1, 6):
            for st in (2, 3, 4):
                ha = float(px_ha[am & (dclass == c) & (stage == st)].sum())
                if ha > 0:
                    joint[f"c{c}s{st}"] = ha
        stats[kid] = {
            "joint_ha": joint,
            "mean_nddi": round(float(np.nanmean(nddi[am])), 3),
            "mean_ndvi": round(float(np.nanmean(ndvi[am])), 3),
            "mean_ndmi": round(float(np.nanmean(ndmi[am])), 3),
            "cropland_ha": round(float(px_ha[m & cropland].sum()), 1),
        }

    # Rasters -----------------------------------------------------------
    layers_dir = WEB_DATA_DIR / "layers"
    layers_dir.mkdir(parents=True, exist_ok=True)

    rgba = np.zeros((ny, nx, 4), np.uint8)
    for cid, *_, col in NDDI_CLASSES:
        mm = active & (dclass == cid)
        rgba[mm, :3] = hex_rgb(col)
        rgba[mm, 3] = 235
    Image.fromarray(rgba).save(layers_dir / "nddi_class.png", optimize=True)

    save_png(ramp(nddi, [(-1, "#2b83ba"), (0.7, "#abdda4"), (1.25, "#fdae61"),
                                (3, "#e8553d"), (4, "#8b0a1a")], active), layers_dir / "nddi.png", 48)
    save_png(ramp(ndvi, [(0, "#8c5a2b"), (0.25, "#d9c36a"), (0.45, "#8fcf5a"),
                                (0.7, "#1a7f37")], cropland), layers_dir / "ndvi.png", 48)
    save_png(ramp(ndmi, [(-0.8, "#8c3b1a"), (-0.3, "#e0a050"), (0, "#f2efc7"),
                                (0.3, "#5bb0d9"), (0.6, "#1f4e9c")], cropland), layers_dir / "ndmi.png", 48)

    stage_cols = {2: "#c7e9a0", 3: "#6cc04a", 4: "#f2c94c", 5: "#a0785a"}
    rgba = np.zeros((ny, nx, 4), np.uint8)
    for st, col in stage_cols.items():
        mm = cropland & (stage == st)
        rgba[mm, :3] = hex_rgb(col)
        rgba[mm, 3] = 230
    Image.fromarray(rgba).save(layers_dir / "stage.png", optimize=True)

    layers = [
        {"id": "nddi_class", "file": "layers/nddi_class.png", "label": "Kelas kekeringan (NDDI)", "legend": "nddi_classes"},
        {"id": "nddi", "file": "layers/nddi.png", "label": "NDDI kontinu", "legend": "nddi_ramp"},
        {"id": "ndvi", "file": "layers/ndvi.png", "label": "NDVI (kehijauan)", "legend": "ndvi_ramp"},
        {"id": "ndmi", "file": "layers/ndmi.png", "label": "NDMI (kelembapan)", "legend": "ndmi_ramp"},
        {"id": "stage", "file": "layers/stage.png", "label": "Fase tumbuh padi", "legend": "stage_classes"},
    ]
    meta = write_run(
        mode="placeholder",
        period={"start": "2024-08-01", "end": "2024-08-31", "label": "Agustus 2024 (musim kemarau)"},
        source={"imagery": "SAMPEL SINTETIS (bukan citra)", "landcover": "-", "boundaries": "BPS 2020 via HDX"},
        bounds=[round(w, 6), round(s, 6), round(e, 6), round(n, 6)],
        layers=layers,
        stats=stats,
        notes=["Data sampel untuk pengembangan antarmuka. Jalankan pipeline/gee_export.py untuk data citra nyata."],
    )
    print("grid", nx, "x", ny, "| class totals (ha):", meta["totals"]["class_ha"], "| active", meta["totals"]["active_ha"])


if __name__ == "__main__":
    main()
