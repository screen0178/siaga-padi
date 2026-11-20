"""Phase 3.1: official irrigation statistics per kecamatan (capacity layer).

Source: Dinas Pertanian Kab. Pati via opendata.patikab.go.id (CC-BY),
"Luas Penggunaan Lahan Sawah Irigasi / Tadah Hujan menurut Kecamatan, 2024".
Both tables split sawah by how often it is planted with rice per year
(1x, 2x, >= 3x) or not planted with rice (other crops / nothing).

Derived per kecamatan:
  irrigated_ha, rainfed_ha, sawah_ha       official areas
  irrigated_share = irrigated / sawah      used as capacity in scoring
  rice3x_share    = irrigated rice >= 3x / sawah: water through the dry
                    season; the closest official match to the satellite
                    proxy (fields green in Jul-Sep)

Run: python pipeline/irrigation.py
Writes data/irrigation/irigasi_2024_per_kecamatan.csv (committed), which the
exporter reads; the XLSX files are only needed to regenerate it.
"""

import csv
import json
import re

from config import BOUNDARY_DIR, ROOT

DIR = ROOT / "data" / "irrigation"
XLSX = {
    "irrigated": "luas-penggunaan-lahan-sawah-irigasi-menurut-kecamatan-di-kabupaten-pati-tahun-2024.xlsx",
    "rainfed": "luas-penggunaan-lahan-sawah-tadah-hujan-menurut-kecamatan-di-kabupaten-pati-tahun-2024.xlsx",
}
OUT = DIR / "irigasi_2024_per_kecamatan.csv"
COLS = ["rice_1x", "rice_2x", "rice_3x", "other_crops", "unplanted", "total"]


def norm(name: str) -> str:
    """'Gunungwungkal' and 'Gunung Wungkal' -> 'gunungwungkal'."""
    return re.sub(r"[^a-z]", "", name.lower())


def kecamatan_ids():
    gj = json.loads((BOUNDARY_DIR / "pati_kecamatan.geojson").read_text())
    return {norm(f["properties"]["name"]): (f["properties"]["id"], f["properties"]["name"])
            for f in gj["features"]}


def num(v) -> float:
    return 0.0 if v in (None, "-", "") else float(v)


def read_table(path):
    import openpyxl  # only needed to regenerate the CSV
    ws = openpyxl.load_workbook(path, read_only=True, data_only=True).worksheets[0]
    out = {}
    for row in ws.iter_rows(values_only=True):
        no, name, *vals = row
        # Data rows start with "1.", "2.", ...; skip titles, headers, totals, source
        if not (isinstance(no, str) and re.fullmatch(r"\d+\.", no.strip())):
            continue
        out[norm(name)] = dict(zip(COLS, map(num, vals[:6])))
    return out


def build():
    ids = kecamatan_ids()
    irr = read_table(DIR / XLSX["irrigated"])
    rf = read_table(DIR / XLSX["rainfed"])
    missing = set(ids) - set(irr) | set(ids) - set(rf)
    if missing or len(irr) != 21 or len(rf) != 21:
        raise SystemExit(f"Kecamatan mismatch: {sorted(missing)}")
    rows = []
    for key, (kid, name) in sorted(ids.items(), key=lambda kv: kv[1][0]):
        i, r = irr[key], rf[key]
        sawah = i["total"] + r["total"]
        rows.append({
            "kec_id": kid, "name": name,
            "irrigated_ha": round(i["total"], 1), "rainfed_ha": round(r["total"], 1),
            "sawah_ha": round(sawah, 1),
            "irrigated_share": round(i["total"] / sawah, 3) if sawah else None,
            "rice3x_share": round((i["rice_3x"] + r["rice_3x"]) / sawah, 3) if sawah else None,
            "irrigated_rice_2x_plus_ha": round(i["rice_2x"] + i["rice_3x"], 1),
        })
    with OUT.open("w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=list(rows[0]))
        w.writeheader()
        w.writerows(rows)
    return rows


def load() -> dict[str, dict]:
    """{kec_id: row} from the committed CSV; {} if it was never built."""
    if not OUT.exists():
        return {}
    with OUT.open() as f:
        return {r["kec_id"]: {k: (float(v) if k not in ("kec_id", "name") and v != "" else v)
                              for k, v in r.items()} for r in csv.DictReader(f)}


if __name__ == "__main__":
    rows = build()
    tot_i = sum(r["irrigated_ha"] for r in rows)
    tot_r = sum(r["rainfed_ha"] for r in rows)
    print(f"{OUT.name}: irrigated {tot_i:,.1f} ha, rainfed {tot_r:,.1f} ha "
          f"(tables: 35,408.3 / 21,976.2)")
    for r in sorted(rows, key=lambda r: r["irrigated_share"]):
        print(f"  {r['name']:<15} sawah {r['sawah_ha']:>7.0f}  irigasi {r['irrigated_share']:>4.0%}  "
              f"padi 3x {r['rice3x_share']:>4.0%}")
