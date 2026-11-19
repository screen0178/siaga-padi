"""Impact scoring: turns per-kecamatan drought statistics into a status,
a priority and a recommended action.

Input per kecamatan is `joint_ha`: hectares of *active* rice (growth stages
2-4) broken down by NDDI class and growth stage, keyed "c{class}s{stage}".
Both the GEE exporter and the placeholder generator produce this shape, so the
scoring logic is identical for sample and real data.
"""

from config import CLASS_HAZARD, STAGE_VULNERABILITY, STATUS_THRESHOLDS

STAGE_NAMES = {2: "vegetatif awal", 3: "vegetatif akhir", 4: "reproduktif"}


def _status(h: float) -> str:
    for upper, name in STATUS_THRESHOLDS:
        if h < upper:
            return name
    return STATUS_THRESHOLDS[-1][1]


def score(joint_ha: dict[str, float]) -> dict:
    total = sum(joint_ha.values())
    if total <= 0:
        return {
            "active_ha": 0, "hazard_index": 0, "ha_at_risk": 0,
            "status": "Tidak ada data", "class_ha": {}, "stage_ha": {},
            "stressed_stage_ha": {}, "action": None,
        }

    class_ha = {c: 0.0 for c in range(1, 6)}
    stage_ha = {s: 0.0 for s in STAGE_VULNERABILITY}
    stressed_stage_ha = {s: 0.0 for s in STAGE_VULNERABILITY}  # class >= 4
    hazard_sum = 0.0
    at_risk = 0.0
    for key, ha in joint_ha.items():
        c, s = int(key[1]), int(key[3])
        class_ha[c] += ha
        stage_ha[s] += ha
        hazard_sum += CLASS_HAZARD[c] * ha
        at_risk += CLASS_HAZARD[c] * STAGE_VULNERABILITY[s] * ha
        if c >= 4:
            stressed_stage_ha[s] += ha

    h = hazard_sum / total
    status = _status(h)
    return {
        "active_ha": round(total, 1),
        "hazard_index": round(h, 3),
        "ha_at_risk": round(at_risk, 1),
        "status": status,
        "class_ha": {str(k): round(v, 1) for k, v in class_ha.items()},
        "stage_ha": {str(k): round(v, 1) for k, v in stage_ha.items()},
        "stressed_stage_ha": {str(k): round(v, 1) for k, v in stressed_stage_ha.items()},
        "action": recommend(status, stressed_stage_ha),
    }


def recommend(status: str, stressed_stage_ha: dict[int, float]) -> dict | None:
    """Rule-based recommendation for the extension officer (penyuluh).

    Deliberately simple and explainable (P13: explanations must be easy to
    understand during a crisis). Wording to be validated with real penyuluh.
    """
    if status == "Normal":
        return None
    stressed_total = sum(stressed_stage_ha.values())
    if stressed_total <= 0:
        dominant = None
    else:
        dominant = max(stressed_stage_ha, key=stressed_stage_ha.get)

    repro_ha = round(stressed_stage_ha.get(4, 0))
    repro_share = repro_ha / stressed_total if stressed_total else 0
    # Reproductive stress is the costliest, so it wins even when not dominant
    # as long as it is a substantial share.
    if dominant == 4 or repro_share >= 0.35:
        headline = "Prioritaskan air untuk padi fase reproduktif"
        steps = [
            f"Sekitar {repro_ha} ha padi fase bunting/berbunga mengalami cekaman kering kuat.",
            "Koordinasikan gilir air irigasi atau pompa ke blok tersebut minggu ini.",
            "Cek lapangan: pastikan lahan memang padi sawah (bukan jagung/tebu).",
        ]
    elif dominant == 3:
        headline = "Hemat air dan siapkan pompa untuk vegetatif akhir"
        steps = [
            "Terapkan pengairan berselang (basah-kering) agar air cukup sampai fase bunting.",
            "Inventarisasi pompa dan sumur dangkal di wilayah kelompok tani.",
            "Cek lapangan blok yang ditandai merah.",
        ]
    else:
        headline = "Pertimbangkan tunda tanam / pantau persemaian"
        steps = [
            "Tanaman masih muda; cekaman sekarang berisiko berlanjut ke fase bunting.",
            "Diskusikan dengan Gapoktan opsi menunda tanam susulan satu dasarian.",
            "Pantau ulang setelah citra satelit berikutnya.",
        ]
    urgency = {"Waspada": "minggu ini", "Siaga": "3 hari ke depan", "Awas": "segera"}[status]
    return {"headline": headline, "steps": steps, "urgency": urgency}
