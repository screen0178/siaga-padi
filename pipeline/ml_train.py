"""v2 Phase 2.2: train the 8-40 day drought forecast and measure it honestly.

Targets (per desa, at the next observation d1 = d0 + h):
  share45  share of active rice in Kuat+Ekstrem NDDI   -> ha at risk
  hazard   hazard index H (same weights as scoring)     -> status
Model: gradient-boosted trees with quantile loss (scikit-learn
HistGradientBoostingRegressor), one model per target and quantile
(P10/P50/P90). LightGBM was the plan, but its macOS wheel needs a system
libomp; scikit-learn's implementation is the same algorithm and ships its own.

Split by time, never at random (neighbouring dates leak):
  train  d1 < 2023        validate  2023        test  d0 >= 2024
Pairs that straddle a boundary are dropped. Baselines: persistence
("no change") and desa climatology (mean share for the calendar month of d1
in the training years). The rain in the target window is observed in
training but forecast at run time, so test skill is also reported with that
rain replaced by climatology: the lower bound of real use.

The production model is refit on all years with the settings chosen on
validation; the metrics come from the held-out model.

Run:  python pipeline/ml_train.py
Writes data/ml/models/<run_id>/{model.pkl, metrics.json, MODEL_CARD.md}
and data/ml/models/LATEST.
"""

import json
import pickle
from datetime import datetime, timezone

import numpy as np
import pandas as pd
from sklearn.ensemble import HistGradientBoostingRegressor

from config import STATUS_THRESHOLDS
from ml_common import (FEATURES, GROUPS, H_MAX, H_MIN, MODELS_DIR, Rain, build_pairs, load_obs,
                       load_static, obs_features, status_of)

QUANTILES = (0.1, 0.5, 0.9)
TARGETS = ("share45", "hazard")
ITERS = (100, 200, 400, 800)
# Lower bound of Siaga on H = upper bound of the level below it
SIAGA = next(STATUS_THRESHOLDS[i - 1][0] for i, (_, n) in enumerate(STATUS_THRESHOLDS) if n == "Siaga")


def model(q, iters):
    return HistGradientBoostingRegressor(loss="quantile", quantile=q, max_iter=iters, learning_rate=0.05,
                                         max_leaf_nodes=31, min_samples_leaf=40, l2_regularization=1.0,
                                         early_stopping=False, random_state=0)


def pinball(y, p, q):
    d = y - p
    return float(np.mean(np.maximum(q * d, (q - 1) * d)))


def split(p: pd.DataFrame):
    y0, y1 = p["date"].dt.year, p["d1"].dt.year
    return {"train": p[y1 <= 2022], "val": p[(y0 == 2023) & (y1 == 2023)], "test": p[y0 >= 2024]}


def fit_set(train, iters):
    return {(t, q): model(q, iters).fit(train[FEATURES], train[f"y_{t}"]) for t in TARGETS for q in QUANTILES}


def predict(models, X):
    """{target: array (n, 3)} with quantiles sorted and clipped to [0, 1]."""
    out = {}
    for t in TARGETS:
        a = np.column_stack([models[(t, q)].predict(X) for q in QUANTILES])
        out[t] = np.clip(np.sort(a, axis=1), 0, 1)
    return out


def climatology(train):
    """Mean target per (desa, month of d1), with kecamatan and global fallbacks."""
    t = train.assign(m=train["d1"].dt.month)
    return {lvl: t.groupby(keys)[[f"y_{x}" for x in TARGETS]].mean()
            for lvl, keys in (("desa", ["desa_id", "m"]), ("kec", ["kec_id", "m"]), ("all", ["m"]))}


def clim_predict(clim, df, target):
    m = df["d1"].dt.month
    col = f"y_{target}"
    v = pd.Series(np.nan, index=df.index)
    for lvl, keys in (("desa", ["desa_id"]), ("kec", ["kec_id"]), ("all", [])):
        idx = pd.MultiIndex.from_arrays([df[k] for k in keys] + [m]) if keys else m
        look = clim[lvl][col].reindex(idx).to_numpy()
        v = v.fillna(pd.Series(look, index=df.index))
    return v.to_numpy()


def rain_clim(rain: Rain, train_years=(2013, 2022)):
    """Mean daily rain per (kec, month) over the training years."""
    rows = []
    for kid, v in rain.vals.items():
        d = pd.date_range(rain.start[kid], periods=len(v))
        s = pd.Series(v, index=d)
        s = s[(s.index.year >= train_years[0]) & (s.index.year <= train_years[1])]
        for m, mm in s.groupby(s.index.month).mean().items():
            rows.append((kid, m, mm))
    return pd.DataFrame(rows, columns=["kec_id", "m", "mm_day"]).set_index(["kec_id", "m"])["mm_day"]


def with_clim_rain(df, rc):
    mid = df["date"] + pd.to_timedelta(df["h"] / 2, unit="D")
    per_day = rc.reindex(pd.MultiIndex.from_arrays([df["kec_id"], mid.dt.month])).to_numpy()
    out = df.copy()
    out["rain_win"] = per_day * out["h"]
    out["rain_win_per_day"] = per_day
    return out


# ---------------------------------------------------------------- metrics
def desa_metrics(df, pred, persist, clim):
    y = df["y_share45"].to_numpy()
    p = pred["share45"]
    return {
        "n": int(len(df)),
        "mae_share": {"model": float(np.mean(np.abs(y - p[:, 1]))), "persistence": float(np.mean(np.abs(y - persist))),
                      "climatology": float(np.nanmean(np.abs(y - clim)))},
        "pinball": {f"p{int(q * 100)}": pinball(y, p[:, k], q) for k, q in enumerate(QUANTILES)},
        "coverage_p10_p90": float(np.mean((y >= p[:, 0]) & (y <= p[:, 2]))),
        "mean_width_p10_p90": float(np.mean(p[:, 2] - p[:, 0])),
    }


def kec_metrics(df, pred, persist_share, persist_h, clim_share):
    """Aggregate desa to kecamatan per (d0, d1): Kuat+Ekstrem ha on the d0
    active area, and the active-weighted hazard index -> status."""
    a = df["active_ha"].to_numpy()
    k = df.assign(
        t=df["y_share45"] * a, p10=pred["share45"][:, 0] * a, p50=pred["share45"][:, 1] * a,
        p90=pred["share45"][:, 2] * a, per=persist_share * a, cli=clim_share * a,
        th=df["y_hazard"] * a, ph=pred["hazard"][:, 1] * a, pph=persist_h * a, w=a,
    ).groupby(["kec_id", "date", "d1"])[["t", "p10", "p50", "p90", "per", "cli", "th", "ph", "pph", "w"]].sum()
    k = k[k["w"] >= 50]  # at least 50 ha of observed active rice in the kecamatan
    th, ph, pph = k["th"] / k["w"], k["ph"] / k["w"], k["pph"] / k["w"]

    def contingency(pred_h):
        ev, fc = th >= SIAGA, pred_h >= SIAGA
        hits, miss, fa = int((ev & fc).sum()), int((ev & ~fc).sum()), int((~ev & fc).sum())
        return {"events": int(ev.sum()), "hit_rate": hits / (hits + miss) if hits + miss else None,
                "false_alarm_ratio": fa / (hits + fa) if hits + fa else None}

    return {
        "n": int(len(k)),
        "mae_ha": {"model": float(np.mean(np.abs(k["t"] - k["p50"]))), "persistence": float(np.mean(np.abs(k["t"] - k["per"]))),
                   "climatology": float(np.nanmean(np.abs(k["t"] - k["cli"])))},
        "coverage_p10_p90": float(np.mean((k["t"] >= k["p10"]) & (k["t"] <= k["p90"]))),
        "status_match": {"model": float(np.mean([status_of(a) == status_of(b) for a, b in zip(th, ph)])),
                         "persistence": float(np.mean([status_of(a) == status_of(b) for a, b in zip(th, pph)]))},
        "siaga_or_awas": {"model": contingency(ph), "persistence": contingency(pph)},
    }


def evaluate(models, df, clim):
    pred = predict(models, df[FEATURES])
    persist_s, persist_h = df["share45"].to_numpy(), df["hazard"].to_numpy()
    cs = clim_predict(clim, df, "share45")
    return {"desa": desa_metrics(df, pred, persist_s, cs),
            "kecamatan": kec_metrics(df, pred, persist_s, persist_h, cs)}


def by_horizon(models, df):
    out = {}
    for lo, hi in ((8, 16), (17, 28), (29, 40)):
        s = df[(df["h"] >= lo) & (df["h"] <= hi)]
        if len(s):
            p = predict(models, s[FEATURES])["share45"][:, 1]
            out[f"{lo}-{hi}"] = {"n": int(len(s)), "mae_model": float(np.mean(np.abs(s["y_share45"] - p))),
                                 "mae_persistence": float(np.mean(np.abs(s["y_share45"] - s["share45"])))}
    return out


def importance(models, df, n=4000, seed=0):
    """Group importance on the test set: rise in P50 MAE when a feature group
    is shuffled together."""
    s = df.sample(min(n, len(df)), random_state=seed)
    m = models[("share45", 0.5)]
    base = np.mean(np.abs(s["y_share45"] - np.clip(m.predict(s[FEATURES]), 0, 1)))
    rng = np.random.default_rng(seed)
    out = {}
    for g, cols in {**GROUPS, "horizon": ["h"]}.items():
        x = s[FEATURES].copy()
        perm = rng.permutation(len(x))
        x[cols] = x[cols].to_numpy()[perm]
        out[g] = float(np.mean(np.abs(s["y_share45"] - np.clip(m.predict(x), 0, 1))) - base)
    return dict(sorted(out.items(), key=lambda kv: -kv[1]))


def main():
    obs = load_obs()
    static = load_static()
    o = obs_features(obs, static)
    rain = Rain.from_csv()
    pairs = build_pairs(o, rain).dropna(subset=["rain_win"])
    sets = split(pairs)
    print(f"{len(obs):,} desa-dates, {obs['date'].nunique()} dates, {len(pairs):,} pairs: "
          + ", ".join(f"{k} {len(v):,}" for k, v in sets.items()), flush=True)
    clim = climatology(sets["train"])

    # Pick the number of trees on validation (P50 of the drought share)
    val_loss = {}
    for it in ITERS:
        m = model(0.5, it).fit(sets["train"][FEATURES], sets["train"]["y_share45"])
        val_loss[it] = pinball(sets["val"]["y_share45"].to_numpy(),
                               np.clip(m.predict(sets["val"][FEATURES]), 0, 1), 0.5)
        print(f"  iters {it}: val pinball {val_loss[it]:.4f}", flush=True)
    iters = min(val_loss, key=val_loss.get)

    held = fit_set(pd.concat([sets["train"], sets["val"]]), iters)
    rc = rain_clim(rain)
    test = sets["test"]
    metrics = {
        "split": {"train": "d1 <= 2022", "val": "2023 (picks trees; then joins training)", "test": "d0 >= 2024"},
        "n_pairs": {k: int(len(v)) for k, v in sets.items()},
        "iters": iters, "val_pinball": {str(k): v for k, v in val_loss.items()},
        "horizon_days": [H_MIN, H_MAX],
        "test": evaluate(held, test, clim),
        "test_rain_climatology": evaluate(held, with_clim_rain(test, rc), clim),
        "test_by_horizon": by_horizon(held, test),
        "group_importance": importance(held, test),
        "test_period": [str(test["date"].min().date()), str(test["d1"].max().date())],
    }

    final = fit_set(pairs, iters)
    run_id = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M")
    out = MODELS_DIR / run_id
    out.mkdir(parents=True, exist_ok=True)
    medians = pairs[FEATURES].median(numeric_only=True).to_dict()
    with (out / "model.pkl").open("wb") as fh:
        pickle.dump({"models": final, "features": FEATURES, "groups": GROUPS, "quantiles": QUANTILES,
                     "medians": medians, "rain_clim": rc.to_dict(), "run_id": run_id}, fh)
    meta = {"run_id": run_id, "trained_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "data": {"dates": int(obs["date"].nunique()), "first": str(obs["date"].min().date()),
                     "last": str(obs["date"].max().date()), "desa": int(obs["desa_id"].nunique())},
            "metrics": metrics}
    (out / "metrics.json").write_text(json.dumps(meta, indent=1))
    (out / "MODEL_CARD.md").write_text(model_card(meta))
    (MODELS_DIR / "LATEST").write_text(run_id + "\n")
    print(json.dumps(metrics, indent=1))
    print(f"saved {out}")


def model_card(meta):
    m = meta["metrics"]
    t, tc = m["test"], m["test_rain_climatology"]
    d, k = t["desa"], t["kecamatan"]
    pct = lambda v: "-" if v is None else f"{100 * v:.0f} %"
    sa = k["siaga_or_awas"]
    return f"""# SIAGA-Padi drought forecast, run {meta['run_id']}

Predicts, for one desa observed by Landsat on d0, the share of active rice in
Kuat+Ekstrem NDDI (and the hazard index H) on d1 = d0 + h, h = {m['horizon_days'][0]}-{m['horizon_days'][1]} days,
as P10 / P50 / P90. Gradient-boosted trees with quantile loss (scikit-learn).

## Data
- Landsat 8/9 TOA C2, {meta['data']['dates']} acquisition dates {meta['data']['first']} .. {meta['data']['last']},
  {meta['data']['desa']} desa; same masks as the map (ESA cropland, NDVI stages 2-4 active).
- Rain: Open-Meteo archive (ERA5-based), daily, at each kecamatan's label point.
- Static: official irrigated / rice-3x share 2024 (kecamatan), SRTM elevation.
- Pairs: {m['n_pairs']['train']:,} train, {m['n_pairs']['val']:,} validation, {m['n_pairs']['test']:,} test.

## Split
Train d1 <= 2022, validation 2023 (chooses {m['iters']} trees, then joins
training), test d0 >= 2024 ({m['test_period'][0]} .. {m['test_period'][1]}). Never random.

## Test results (held-out years)
| | model | persistence | climatology |
|---|---|---|---|
| MAE share, desa | {d['mae_share']['model']:.3f} | {d['mae_share']['persistence']:.3f} | {d['mae_share']['climatology']:.3f} |
| MAE ha Kuat+Ekstrem, kecamatan | {k['mae_ha']['model']:.0f} | {k['mae_ha']['persistence']:.0f} | {k['mae_ha']['climatology']:.0f} |
| Status matches | {pct(k['status_match']['model'])} | {pct(k['status_match']['persistence'])} | |
| Siaga/Awas hit rate | {pct(sa['model']['hit_rate'])} | {pct(sa['persistence']['hit_rate'])} | |
| Siaga/Awas false alarm ratio | {pct(sa['model']['false_alarm_ratio'])} | {pct(sa['persistence']['false_alarm_ratio'])} | |

P10-P90 coverage: desa {pct(d['coverage_p10_p90'])}, kecamatan {pct(k['coverage_p10_p90'])}
(target 80 %; kecamatan bands add desa quantiles, which assumes desa move together).

With future rain replaced by climatology (what the model gets without a
skilful rain forecast): MAE share {tc['desa']['mae_share']['model']:.3f}, kecamatan MAE
{tc['kecamatan']['mae_ha']['model']:.0f} ha.

## Limitations
- Single-date stages (not the map's 4-month trajectory): harvest and fallow
  fields are not separated, so the model forecasts the share, and the app
  applies it to the map's active area.
- Rain at one point per kecamatan from a reanalysis; at run time a forecast.
- Kuat+Ekstrem is an NDDI class, not observed crop loss.
"""


if __name__ == "__main__":
    main()
