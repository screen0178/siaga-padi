"""Impact scoring: turns per-kecamatan drought statistics into a status,
a priority and a recommended action.

Input per kecamatan is `joint_ha`: hectares of *active* rice (growth stages
2-4) broken down by NDDI class and growth stage, keyed "c{class}s{stage}".
Both the GEE exporter and the placeholder generator produce this shape, so the
scoring logic is identical for sample and real data.
"""

from config import CAPACITY, CLASS_HAZARD, STAGE_VULNERABILITY, STATUS_THRESHOLDS

STAGE_NAMES = {2: "vegetatif awal", 3: "vegetatif akhir", 4: "reproduktif"}


def _status(h: float) -> str:
    for upper, name in STATUS_THRESHOLDS:
        if h < upper:
            return name
    return STATUS_THRESHOLDS[-1][1]


def water_source(irrigated_share: float | None) -> str | None:
    if irrigated_share is None:
        return None
    if irrigated_share >= CAPACITY["irrigated_min"]:
        return "irigasi"
    if 1 - irrigated_share >= CAPACITY["rainfed_min"]:
        return "tadah hujan"
    return "campuran"


def score(joint_ha: dict[str, float], irrigated_share: float | None = None) -> dict:
    """irrigated_share (official, 0..1) lowers the priority, not the status,
    and picks water-source-specific recommendation steps."""
    factor = 1.0 if irrigated_share is None else 1 - CAPACITY["weight"] * irrigated_share
    src = water_source(irrigated_share)
    total = sum(joint_ha.values())
    if total <= 0:
        return {
            "active_ha": 0, "hazard_index": 0, "ha_at_risk": 0, "priority": 0,
            "capacity_factor": round(factor, 3), "water_source": src,
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
        "priority": round(at_risk * factor, 1),
        "capacity_factor": round(factor, 3),
        "water_source": src,
        "status": status,
        "class_ha": {str(k): round(v, 1) for k, v in class_ha.items()},
        "stage_ha": {str(k): round(v, 1) for k, v in stage_ha.items()},
        "stressed_stage_ha": {str(k): round(v, 1) for k, v in stressed_stage_ha.items()},
        "action": recommend(status, stressed_stage_ha, src),
    }


# Water steps per source; "campuran" gets both. Wording to be checked with penyuluh.
WATER_STEPS = {
    "repro": {
        "irigasi": "Koordinasikan gilir air dengan P3A / juru air agar blok bunting mendapat giliran minggu ini.",
        "tadah hujan": "Tidak ada air irigasi: siapkan pompa dari sumur dangkal atau embung untuk blok bunting minggu ini.",
    },
    "late": {
        "irigasi": "Terapkan pengairan berselang (basah-kering) dan sepakati jadwal gilir dengan P3A.",
        "tadah hujan": "Inventarisasi pompa, sumur dangkal dan embung di wilayah kelompok tani.",
    },
    "early": {
        "irigasi": "Sesuaikan jadwal tanam susulan dengan jadwal gilir air irigasi.",
        "tadah hujan": "Tunda tanam susulan sampai hujan cukup; siapkan benih varietas genjah.",
    },
}


def _water(kind: str, src: str | None, fallback: str) -> list[str]:
    steps = WATER_STEPS[kind]
    if src in steps:
        return [steps[src]]
    if src == "campuran":
        return [f"Blok irigasi: {steps['irigasi'][0].lower()}{steps['irigasi'][1:]}",
                f"Blok tadah hujan: {steps['tadah hujan'][0].lower()}{steps['tadah hujan'][1:]}"]
    return [fallback]


def recommend(status: str, stressed_stage_ha: dict[int, float], src: str | None = None) -> dict | None:
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
            *_water("repro", src, "Koordinasikan gilir air irigasi atau pompa ke blok tersebut minggu ini."),
            "Cek lapangan: pastikan lahan memang padi sawah (bukan jagung/tebu).",
        ]
    elif dominant == 3:
        headline = "Hemat air dan siapkan pompa untuk vegetatif akhir"
        steps = [
            "Hemat air agar cukup sampai fase bunting.",
            *_water("late", src, "Inventarisasi pompa dan sumur dangkal di wilayah kelompok tani."),
            "Cek lapangan blok yang ditandai merah.",
        ]
    else:
        headline = "Pertimbangkan tunda tanam / pantau persemaian"
        steps = [
            "Tanaman masih muda; cekaman sekarang berisiko berlanjut ke fase bunting.",
            *_water("early", src, "Diskusikan dengan Gapoktan opsi menunda tanam susulan satu dasarian."),
            "Pantau ulang setelah citra satelit berikutnya.",
        ]
    urgency = {"Waspada": "minggu ini", "Siaga": "3 hari ke depan", "Awas": "segera"}[status]
    return {"headline": headline, "steps": steps, "urgency": urgency}
