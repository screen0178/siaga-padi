"""Writes the data contract consumed by the web app (web/public/data/).

Contract (version 1):
  meta.json             run metadata, legend definitions, raster layer list
  kecamatan.json        boundaries + per-kecamatan statistics + scoring
  layers/<name>.png     colourised rasters, georeferenced by meta.bounds

Both make_placeholder.py and gee_export.py call write_run(), so the frontend
never needs to know which one produced the data.
"""

import json
from datetime import datetime, timezone

from config import (BOUNDARY_DIR, NDDI_CLASSES, PHENOLOGY_CLASSES, REGION,
                    STATUS_THRESHOLDS, WEB_DATA_DIR)
from scoring import score

CONTRACT_VERSION = 1


def _inf(v):
    return None if v in (float("inf"), float("-inf")) else v


def write_run(*, mode: str, period: dict, source: dict, bounds: list,
              layers: list[dict], stats: dict[str, dict], notes: list[str]):
    """stats: kec_id -> {"joint_ha": {...}, "mean_nddi": float,
    "mean_ndvi": float, "mean_ndmi": float, "cropland_ha": float}"""
    WEB_DATA_DIR.mkdir(parents=True, exist_ok=True)
    kec = json.loads((BOUNDARY_DIR / "pati_kecamatan.geojson").read_text())

    for f in kec["features"]:
        p = f["properties"]
        s = stats.get(p["id"], {})
        p.update({
            "mean_nddi": s.get("mean_nddi"),
            "mean_ndvi": s.get("mean_ndvi"),
            "mean_ndmi": s.get("mean_ndmi"),
            "cropland_ha": s.get("cropland_ha"),
            **score(s.get("joint_ha", {})),
        })

    ranked = sorted(kec["features"], key=lambda f: -f["properties"]["ha_at_risk"])
    for i, f in enumerate(ranked, 1):
        f["properties"]["rank"] = i

    meta = {
        "contract_version": CONTRACT_VERSION,
        "mode": mode,  # "placeholder" | "gee"
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "region": REGION,
        "period": period,
        "source": source,
        "bounds": bounds,  # [west, south, east, north]
        "layers": layers,
        "nddi_classes": [
            {"id": c, "min": _inf(lo), "max": _inf(hi), "label": lid, "label_en": len_, "color": col}
            for c, lo, hi, lid, len_, col in NDDI_CLASSES
        ],
        "stage_classes": [
            {"id": c, "min": _inf(lo), "max": _inf(hi), "label": lab, "active": act}
            for c, lo, hi, lab, act in PHENOLOGY_CLASSES
        ],
        "status_levels": [s for _, s in STATUS_THRESHOLDS],
        "totals": {
            "class_ha": {
                str(c): round(sum(float(f["properties"]["class_ha"].get(str(c), 0)) for f in kec["features"]), 1)
                for c in range(1, 6)
            },
            "active_ha": round(sum(f["properties"]["active_ha"] for f in kec["features"]), 1),
        },
        "notes": notes,
    }
    (WEB_DATA_DIR / "meta.json").write_text(json.dumps(meta, indent=1))
    (WEB_DATA_DIR / "kecamatan.json").write_text(json.dumps(kec))
    # Village outlines double as the offline basemap
    (WEB_DATA_DIR / "desa.json").write_text((BOUNDARY_DIR / "pati_desa.geojson").read_text())
    return meta
