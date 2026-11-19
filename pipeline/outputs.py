"""Writes the data contract consumed by the web app (web/public/data/).

Contract (version 1):
  meta.json             run metadata, legend definitions, raster layer list
  kecamatan.json        boundaries + per-kecamatan statistics + scoring
  layers/<name>.png     colourised rasters, georeferenced by meta.bounds

Optional time series (Stage 1, backward compatible: old readers ignore it):
  meta.periods          [{id, start, end, label, layers_dir, source, totals}]
  meta.current_period   id of the period mirrored in the top-level fields
  kecamatan.json        properties.series = {period_id: {stats + scoring}}
  periods/<id>/layers/<name>.png

Top-level meta.period / meta.totals / layers/ and the per-kecamatan top-level
properties always describe the current period, so a reader that knows nothing
about periods still sees a complete single-period dataset.

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


def score_period(kec_features: list[dict], stats: dict[str, dict]) -> dict[str, dict]:
    """kec_id -> stats + scoring + rank for one period."""
    out = {}
    for f in kec_features:
        kid = f["properties"]["id"]
        s = stats.get(kid, {})
        out[kid] = {
            "mean_nddi": s.get("mean_nddi"),
            "mean_ndvi": s.get("mean_ndvi"),
            "mean_ndmi": s.get("mean_ndmi"),
            "cropland_ha": s.get("cropland_ha"),
            # cropland ha per growth stage incl. non-active (6 bera, 7 panen)
            "cropland_stage_ha": s.get("cropland_stage_ha", {}),
            **score(s.get("joint_ha", {})),
        }
    for i, kid in enumerate(sorted(out, key=lambda k: -out[k]["ha_at_risk"]), 1):
        out[kid]["rank"] = i
    return out


def totals(scored: dict[str, dict]) -> dict:
    return {
        "class_ha": {
            str(c): round(sum(float(p["class_ha"].get(str(c), 0)) for p in scored.values()), 1)
            for c in range(1, 6)
        },
        "active_ha": round(sum(p["active_ha"] for p in scored.values()), 1),
        "cropland_stage_ha": {
            k: round(sum(float(p["cropland_stage_ha"].get(k, 0)) for p in scored.values()), 1)
            for k in sorted({k for p in scored.values() for k in p["cropland_stage_ha"]})
        },
    }


def write_run(*, mode: str, period: dict, source: dict, bounds: list,
              layers: list[dict], stats: dict[str, dict], notes: list[str],
              periods: list[dict] | None = None, current_period: str | None = None,
              extra_stage_classes: list[tuple] | None = None):
    """stats: kec_id -> {"joint_ha": {...}, "mean_nddi": float,
    "mean_ndvi": float, "mean_ndmi": float, "cropland_ha": float}

    periods (optional): [{"id", "start", "end", "label", "layers_dir",
    "source", "stats"}], where stats has the same shape as above. When given,
    `period`, `source` and `stats` must describe `current_period`.
    """
    WEB_DATA_DIR.mkdir(parents=True, exist_ok=True)
    kec = json.loads((BOUNDARY_DIR / "pati_kecamatan.geojson").read_text())

    current = score_period(kec["features"], stats)
    series = {p["id"]: score_period(kec["features"], p["stats"]) for p in periods or []}
    for f in kec["features"]:
        kid = f["properties"]["id"]
        f["properties"].update(current[kid])
        if series:
            f["properties"]["series"] = {pid: s[kid] for pid, s in series.items()}

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
            for c, lo, hi, lab, act in [*PHENOLOGY_CLASSES, *(extra_stage_classes or [])]
        ],
        "status_levels": [s for _, s in STATUS_THRESHOLDS],
        "totals": totals(current),
        "notes": notes,
    }
    if periods:
        meta["periods"] = [
            {k: p[k] for k in ("id", "start", "end", "label", "layers_dir", "source")}
            | {"totals": totals(series[p["id"]])}
            for p in periods
        ]
        meta["current_period"] = current_period
    (WEB_DATA_DIR / "meta.json").write_text(json.dumps(meta, indent=1))
    (WEB_DATA_DIR / "kecamatan.json").write_text(json.dumps(kec))
    # Village outlines double as the offline basemap
    (WEB_DATA_DIR / "desa.json").write_text((BOUNDARY_DIR / "pati_desa.geojson").read_text())
    return meta
