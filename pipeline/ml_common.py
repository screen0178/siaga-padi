"""v2 Phase 2: features shared by training (ml_train.py) and inference
(forecast.py), so both build exactly the same columns.

A row = one desa observed at d0, forecast for d1 = d0 + h days:
  state at d0     drought share, hazard index, mean NDDI/NDVI/NDMI, stage and
                  land shares, cloud-free coverage
  trend           change since the previous observation of the same desa
  rain            kecamatan rain over the 10/30/60 days up to d0, days
                  without rain at d0, and rain over (d0, d1] (observed in
                  training, observed + forecast at run time)
  static          official irrigated and rice-3x share (kecamatan),
                  elevation, cropland ha
  season          month of d1 as sin/cos, and h itself
"""

import csv
from datetime import date

import numpy as np
import pandas as pd

from config import CLASS_HAZARD, ROOT, STATUS_THRESHOLDS, WEATHER

ML_DIR = ROOT / "data" / "ml"
MODELS_DIR = ML_DIR / "models"

H_MIN, H_MAX = 8, 40           # horizon range in days (one Landsat-8+9 step .. ~5)
MIN_ACTIVE_HA = 5              # desa needs this much active rice to be a sample
MIN_VALID_D0, MIN_VALID_D1 = 0.3, 0.5  # cloud-free share of desa cropland
PREV_MAX_GAP = 48              # previous observation used for the trend if this recent

FEATURES = [
    "share45", "hazard", "mean_nddi", "mean_ndvi", "mean_ndmi", "share_s2", "share_s4",
    "active_frac", "ripe_frac", "bare_frac", "valid_frac",
    "d_share45", "d_ndvi", "d_nddi", "prev_gap",
    "rain10", "rain30", "rain60", "hth", "rain_win", "rain_win_per_day",
    "irrigated_share", "rice3x_share", "elev_m", "crop_ha",
    "month_sin", "month_cos", "h",
]

# Feature groups used for the plain-language reasons (occlusion per group)
GROUPS = {
    "rain_future": ["rain_win", "rain_win_per_day"],
    "rain_past": ["rain10", "rain30", "rain60", "hth"],
    "state": ["share45", "hazard", "mean_nddi", "mean_ndmi"],
    "trend": ["d_share45", "d_ndvi", "d_nddi", "prev_gap"],
    "stage": ["mean_ndvi", "share_s2", "share_s4", "active_frac", "ripe_frac", "bare_frac"],
    "water": ["irrigated_share", "rice3x_share"],
    "season": ["month_sin", "month_cos"],
}


def status_of(h: float) -> str:
    for upper, name in STATUS_THRESHOLDS:
        if h < upper:
            return name
    return STATUS_THRESHOLDS[-1][1]


# ---------------------------------------------------------------- observations
def load_obs() -> pd.DataFrame:
    files = sorted(ML_DIR.glob("obs_*.csv"))
    if not files:
        raise SystemExit("No data/ml/obs_*.csv: run pipeline/ml_dataset.py first")
    obs = pd.concat([pd.read_csv(f, dtype={"desa_id": str}) for f in files], ignore_index=True)
    obs["date"] = pd.to_datetime(obs["date"])
    return obs.drop_duplicates(["desa_id", "date"]).sort_values(["desa_id", "date"]).reset_index(drop=True)


def load_static() -> pd.DataFrame:
    import irrigation
    st = pd.read_csv(ML_DIR / "desa_static.csv", dtype={"desa_id": str, "kec_id": str})
    irr = irrigation.load()
    st["irrigated_share"] = st["kec_id"].map(lambda k: irr.get(k, {}).get("irrigated_share", np.nan))
    st["rice3x_share"] = st["kec_id"].map(lambda k: irr.get(k, {}).get("rice3x_share", np.nan))
    return st


def obs_features(obs: pd.DataFrame, static: pd.DataFrame) -> pd.DataFrame:
    """Per (desa, date) state, plus the trend versus the desa's previous
    usable observation."""
    o = obs.merge(static, on="desa_id", how="left")
    act = o["active_ha"].where(o["active_ha"] > 0)
    val = o["valid_ha"].where(o["valid_ha"] > 0)
    o["share45"] = (o["c4"] + o["c5"]) / act
    o["hazard"] = sum(CLASS_HAZARD[k] * o[f"c{k}"] for k in CLASS_HAZARD) / act
    o["mean_nddi"] = o["nddi_sum"] / act
    o["mean_ndvi"] = o["ndvi_sum"] / act
    o["mean_ndmi"] = o["ndmi_sum"] / act
    o["share_s2"] = o["s2"] / act
    o["share_s4"] = o["s4"] / act
    o["active_frac"] = o["active_ha"] / val
    o["ripe_frac"] = o["ripe_ha"] / val
    o["bare_frac"] = o["bare_ha"] / val
    o["valid_frac"] = (o["valid_ha"] / o["crop_ha"].where(o["crop_ha"] > 0)).clip(upper=1)
    o["usable"] = (o["active_ha"] >= MIN_ACTIVE_HA) & (o["valid_frac"] >= MIN_VALID_D0)
    # Trend: previous usable observation of the same desa
    u = o[o["usable"]].sort_values(["desa_id", "date"])
    g = u.groupby("desa_id")
    prev = pd.DataFrame({
        "prev_date": g["date"].shift(), "p_share45": g["share45"].shift(),
        "p_ndvi": g["mean_ndvi"].shift(), "p_nddi": g["mean_nddi"].shift()}, index=u.index)
    o = o.join(prev)
    gap = (o["date"] - o["prev_date"]).dt.days
    ok = gap <= PREV_MAX_GAP
    o["prev_gap"] = gap.where(ok)
    o["d_share45"] = (o["share45"] - o["p_share45"]).where(ok)
    o["d_ndvi"] = (o["mean_ndvi"] - o["p_ndvi"]).where(ok)
    o["d_nddi"] = (o["mean_nddi"] - o["p_nddi"]).where(ok)
    return o


# ---------------------------------------------------------------- rain
class Rain:
    """Daily rain per kecamatan with O(1) window sums."""

    def __init__(self, daily: dict[str, dict[str, float]]):
        self.start = {}
        self.cum = {}
        self.vals = {}
        for kid, days in daily.items():
            ds = sorted(days)
            d0 = date.fromisoformat(ds[0])
            n = (date.fromisoformat(ds[-1]) - d0).days + 1
            v = np.full(n, np.nan)
            for d, mm in days.items():
                if mm is not None:
                    v[(date.fromisoformat(d) - d0).days] = mm
            self.start[kid] = d0
            self.vals[kid] = v
            self.cum[kid] = np.concatenate([[0], np.cumsum(np.nan_to_num(v))])

    @classmethod
    def from_csv(cls, path=None):
        daily: dict[str, dict[str, float]] = {}
        with open(path or ML_DIR / "rain_daily.csv") as fh:
            for r in csv.DictReader(fh):
                daily.setdefault(r["kec_id"], {})[r["date"]] = float(r["mm"])
        return cls(daily)

    def _i(self, kid, d: date):
        return (d - self.start[kid]).days

    def window(self, kid, end: date, days: int):
        """Sum over the `days` days ending at `end` (inclusive). NaN if outside the record."""
        if kid not in self.cum:
            return np.nan
        j = self._i(kid, end) + 1
        i = j - days
        if i < 0 or j > len(self.vals[kid]):
            return np.nan
        return float(self.cum[kid][j] - self.cum[kid][i])

    def between(self, kid, d0: date, d1: date):
        """Sum over (d0, d1]."""
        return self.window(kid, d1, (d1 - d0).days)

    def hth(self, kid, end: date):
        """Days without rain (< dry_day_mm) ending at `end`."""
        if kid not in self.vals:
            return np.nan
        v, i, n = self.vals[kid], self._i(kid, end), 0
        if i < 0 or i >= len(v):
            return np.nan
        while i >= 0 and not np.isnan(v[i]) and v[i] < WEATHER["dry_day_mm"]:
            n += 1
            i -= 1
        return n


def add_rain(df: pd.DataFrame, rain: Rain, d0_col="date", d1_col="d1") -> pd.DataFrame:
    """Past-rain and target-window rain columns (row-wise; fine for ~1e5 rows)."""
    k = df["kec_id"].to_numpy()
    d0 = [x.date() for x in df[d0_col]]
    d1 = [x.date() for x in df[d1_col]]
    df["rain10"] = [rain.window(a, b, 10) for a, b in zip(k, d0)]
    df["rain30"] = [rain.window(a, b, 30) for a, b in zip(k, d0)]
    df["rain60"] = [rain.window(a, b, 60) for a, b in zip(k, d0)]
    df["hth"] = [rain.hth(a, b) for a, b in zip(k, d0)]
    df["rain_win"] = [rain.between(a, b, c) for a, b, c in zip(k, d0, d1)]
    df["rain_win_per_day"] = df["rain_win"] / df["h"]
    return df


def add_season(df: pd.DataFrame, d1_col="d1") -> pd.DataFrame:
    m = df[d1_col].dt.month + df[d1_col].dt.day / 31
    df["month_sin"] = np.sin(2 * np.pi * m / 12)
    df["month_cos"] = np.cos(2 * np.pi * m / 12)
    return df


# ---------------------------------------------------------------- training pairs
def build_pairs(o: pd.DataFrame, rain: Rain) -> pd.DataFrame:
    """Every (d0, d1) pair of usable observations of a desa, H_MIN <= h <= H_MAX."""
    u = o[o["usable"]]
    tgt = o[(o["active_ha"] >= MIN_ACTIVE_HA) & (o["valid_frac"] >= MIN_VALID_D1)][
        ["desa_id", "date", "share45", "hazard", "active_ha"]].rename(
        columns={"date": "d1", "share45": "y_share45", "hazard": "y_hazard", "active_ha": "active_d1"})
    p = u.merge(tgt, on="desa_id")
    p["h"] = (p["d1"] - p["date"]).dt.days
    p = p[(p["h"] >= H_MIN) & (p["h"] <= H_MAX)].copy()
    p = add_season(add_rain(p, rain))
    return p.reset_index(drop=True)
