"""v2 Phase 4: impact in tonnes and rupiah, and action options with an
estimated effect (config.IMPACT, config.ACTION_OPTIONS).

  production at risk  ha_at_risk x yield (range: yield factor x price range)
  options             pump / water rotation / delay planting, each with the
                      target ha, equipment, and production / rupiah it could save

annotate() adds `impact` (and `options` for the current period) to the data
files in place, so it needs no Earth Engine. outputs.write_run and
scenario.py call it; run it alone after changing the assumptions:
  python pipeline/impact.py
"""

import json
import math

from config import ACTION_OPTIONS, CLASS_HAZARD, IMPACT, STAGE_VULNERABILITY, WEB_DATA_DIR

KUAT = CLASS_HAZARD[4]  # stressed ha in props are Kuat+Ekstrem; Kuat is the conservative weight


def value(ha_eq: float) -> dict:
    """Tonnes GKG and rupiah for hectare-equivalents of lost harvest: [low, mid, high]."""
    y, (f0, f1), (p0, p1) = IMPACT["yield_t_ha"], IMPACT["yield_factor"], IMPACT["price_rp_kg"]
    t = [ha_eq * y * f0, ha_eq * y, ha_eq * y * f1]
    rp = [t[0] * 1000 * p0, t[1] * 1000 * (p0 + p1) / 2, t[2] * 1000 * p1]
    return {"t": [round(v, 1) for v in t], "rp": [round(v, -6) for v in rp]}


def impact(ha_at_risk: float) -> dict:
    return {"ha_eq": round(ha_at_risk, 1), **value(ha_at_risk)}


def options(p: dict) -> list[dict]:
    """Action options for one kecamatan's current props."""
    a = ACTION_OPTIONS
    irr = (p.get("water") or {}).get("irrigated_share")
    irr = 0.5 if irr is None else irr
    st = p.get("stressed_stage_ha") or {}
    cs = p.get("cropland_stage_ha") or {}
    out = []

    def eq(stages, share):  # hectare-equivalents at risk on the targeted ha
        return sum(float(st.get(s, 0)) * STAGE_VULNERABILITY[int(s)] for s in stages) * KUAT * share

    def saved(stages, share, eff):
        e = eq(stages, share)
        lo, hi = value(e * eff[0]), value(e * eff[1])
        return {"ha_eq": [round(e * eff[0], 1), round(e * eff[1], 1)],
                "t": [lo["t"][0], hi["t"][2]], "rp": [lo["rp"][0], hi["rp"][2]]}

    pump = a["pump"]
    ha = sum(float(st.get(s, 0)) for s in pump["stages"]) * (1 - irr)
    if ha >= a["min_ha"]:
        n = [math.ceil(ha / pump["ha_per_pump"][1]), math.ceil(ha / pump["ha_per_pump"][0])]
        out.append({"id": "pump", "label": "Pompanisasi dari sumur dangkal / sungai / embung",
                    "target_ha": round(ha), "pumps": n,
                    "detail": f"Padi tercekam kuat fase vegetatif akhir–reproduktif di sawah tadah hujan; "
                              f"pompa 4 inci {pump['ha_per_pump'][0]}–{pump['ha_per_pump'][1]} ha per unit "
                              f"(diam / berpindah), efektivitas {int(pump['efficacy'][0] * 100)}–{int(pump['efficacy'][1] * 100)}%.",
                    "saves": saved(pump["stages"], 1 - irr, pump["efficacy"])})
    rot = a["rotation"]
    ha = sum(float(st.get(s, 0)) for s in rot["stages"]) * irr
    if ha >= a["min_ha"]:
        out.append({"id": "rotation", "label": "Gilir air dan koordinasi P3A / juru air",
                    "target_ha": round(ha), "pumps": None,
                    "detail": f"Padi tercekam kuat di sawah irigasi; membagi air saluran yang terbatas "
                              f"menurut fase tumbuh, efektivitas {int(rot['efficacy'][0] * 100)}–{int(rot['efficacy'][1] * 100)}%.",
                    "saves": saved(rot["stages"], irr, rot["efficacy"])})
    ha = sum(float(cs.get(s, 0)) for s in a["delay"]["stages"]) * (1 - irr)
    if ha >= a["min_ha"]:
        out.append({"id": "delay", "label": "Tunda tanam sampai hujan cukup, siapkan varietas genjah",
                    "target_ha": round(ha), "pumps": None,
                    "detail": "Sawah tadah hujan yang belum ditanam / tidak tumbuh: menunggu hujan mantap "
                              "(dasarian ≥ 50 mm) mencegah gagal tanam. Tanpa nilai rupiah: belum ada tanaman.",
                    "saves": None})
    return out


def annotate():
    """Add impact (all periods, scenario steps) and options (current period)."""
    kp, mp = WEB_DATA_DIR / "kecamatan.json", WEB_DATA_DIR / "meta.json"
    kec, meta = json.loads(kp.read_text()), json.loads(mp.read_text())
    tot = {}
    for f in kec["features"]:
        p = f["properties"]
        p["impact"] = impact(p.get("ha_at_risk") or 0)
        p["options"] = options(p)
        for pid, s in (p.get("series") or {}).items():
            s["impact"] = impact(s.get("ha_at_risk") or 0)
            tot[pid] = tot.get(pid, 0) + (s.get("ha_at_risk") or 0)
    meta["impact"] = {k: v for k, v in IMPACT.items()} | {"options": ACTION_OPTIONS}
    meta["totals"]["impact"] = impact(sum(f["properties"].get("ha_at_risk") or 0 for f in kec["features"]))
    for per in meta.get("periods", []):
        per["totals"]["impact"] = impact(tot.get(per["id"], 0))
    kp.write_text(json.dumps(kec))
    mp.write_text(json.dumps(meta, indent=1))

    sp = WEB_DATA_DIR / "scenario.json"
    if sp.exists():
        sc = json.loads(sp.read_text())
        for steps in sc["kecamatan"].values():
            for s in steps.values():
                s["impact"] = impact(s.get("ha_at_risk") or 0)
        for t in sc["totals"].values():
            t["impact"] = impact(t.get("ha_at_risk") or 0)
        sp.write_text(json.dumps(sc, indent=1))
    return meta, kec


if __name__ == "__main__":
    meta, kec = annotate()
    t = meta["totals"]["impact"]
    print(f"Current period: {t['ha_eq']:,.0f} ha-eq at risk -> {t['t'][0]:,.0f}-{t['t'][2]:,.0f} t GKG, "
          f"Rp {t['rp'][0] / 1e9:,.1f}-{t['rp'][2] / 1e9:,.1f} M")
    for per in meta.get("periods", []):
        i = per["totals"]["impact"]
        print(f"  {per['id']}: {i['t'][1]:>8,.0f} t, Rp {i['rp'][1] / 1e9:5.1f} M")
    rows = sorted(kec["features"], key=lambda f: f["properties"]["rank"])[:8]
    for f in rows:
        p = f["properties"]
        opts = "; ".join(f"{o['id']} {o['target_ha']} ha" + (f" {o['pumps'][0]}-{o['pumps'][1]} pompa" if o["pumps"] else "")
                         + (f" -> Rp {o['saves']['rp'][0] / 1e9:.1f}-{o['saves']['rp'][1] / 1e9:.1f} M" if o["saves"] else "")
                         for o in p["options"])
        print(f"  {p['name']:<12} Rp {p['impact']['rp'][1] / 1e9:4.1f} M | {opts}")
