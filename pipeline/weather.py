"""Stage 2: rainfall per kecamatan from Open-Meteo (no API key).

Two sources, both sampled at each kecamatan's label point:
  forecast API  past 92 days + 16-day forecast (best-match NWP models)
  archive API   ERA5-based reanalysis, ~5 days behind; used for monthly
                totals of the satellite series (calibration in scenario.py)

Rainfall is summarised in dasarian (10-day periods: days 1-10, 11-20,
21-end), the unit BMKG uses for drought monitoring, plus the current run of
days without rain (hari tanpa hujan, HTH: < 1 mm/day, BMKG criterion).

Run (no Earth Engine needed, safe to run daily):
  python pipeline/weather.py
Writes web/public/data/weather.json (optional contract extension).
"""

import json
import urllib.parse
import urllib.request
from datetime import date, datetime, timedelta, timezone

from config import BOUNDARY_DIR, WEATHER, WEB_DATA_DIR

FORECAST_URL = "https://api.open-meteo.com/v1/forecast"
ARCHIVE_URL = "https://archive-api.open-meteo.com/v1/archive"
BULAN3 = ["Jan", "Feb", "Mar", "Apr", "Mei", "Jun", "Jul", "Agu", "Sep", "Okt", "Nov", "Des"]


def kecamatan_points():
    """[(id, name, lat, lon)] from the boundary file's label points."""
    gj = json.loads((BOUNDARY_DIR / "pati_kecamatan.geojson").read_text())
    return [(f["properties"]["id"], f["properties"]["name"],
             f["properties"]["label_lat"], f["properties"]["label_lon"])
            for f in gj["features"]]


def _get(url, params):
    q = urllib.parse.urlencode(params)
    with urllib.request.urlopen(f"{url}?{q}", timeout=120) as r:
        d = json.load(r)
    return d if isinstance(d, list) else [d]


def daily_rain(points, *, past_days=None, forecast_days=None, start=None, end=None):
    """{kec_id: {iso_date: mm or None}} for all points in one request."""
    params = {
        "latitude": ",".join(f"{p[2]:.4f}" for p in points),
        "longitude": ",".join(f"{p[3]:.4f}" for p in points),
        "daily": "precipitation_sum",
        "timezone": "Asia/Jakarta",
    }
    if start:
        url = ARCHIVE_URL
        params |= {"start_date": start, "end_date": end}
    else:
        url = FORECAST_URL
        params |= {"past_days": past_days, "forecast_days": forecast_days}
    out = {}
    for p, loc in zip(points, _get(url, params)):
        d = loc["daily"]
        out[p[0]] = dict(zip(d["time"], d["precipitation_sum"]))
    return out


def dasarian_of(d: date):
    k = 0 if d.day <= 10 else 1 if d.day <= 20 else 2
    start = d.replace(day=1 + 10 * k)
    nxt = d.replace(day=28) + timedelta(days=4)
    end = start + timedelta(days=10) if k < 2 else nxt.replace(day=1)  # exclusive
    label = f"{BULAN3[d.month - 1]} {'I' * (k + 1) if k < 2 else 'III'}"
    return f"{d.year}-{d.month:02d}-d{k + 1}", start, end, label


def summarise(rain: dict[str, float | None], today: date, n_obs: int):
    """Dasarian totals around today plus HTH and forecast sums for one point.

    Days up to and including today count as observed (today is partly
    forecast); later days are forecast."""
    days = sorted(date.fromisoformat(k) for k, v in rain.items() if v is not None)
    by_das = {}
    for d in days:
        did, s, e, lab = dasarian_of(d)
        b = by_das.setdefault(did, {"id": did, "start": s.isoformat(), "end": e.isoformat(),
                                    "label": lab, "obs_mm": 0.0, "fc_mm": 0.0,
                                    "obs_days": 0, "fc_days": 0, "days": (e - s).days})
        key = "obs" if d <= today else "fc"
        b[f"{key}_mm"] += rain[d.isoformat()]
        b[f"{key}_days"] += 1
    das = [b for b in by_das.values() if b["obs_days"] + b["fc_days"] > 0]
    cur = dasarian_of(today)[0]
    i = next(k for k, b in enumerate(das) if b["id"] == cur)
    das = das[max(0, i - n_obs + 1):]
    for b in das:
        b["obs_mm"] = round(b["obs_mm"], 1)
        b["fc_mm"] = round(b["fc_mm"], 1)
        # A dasarian is complete when every day has a value
        b["complete"] = b["obs_days"] + b["fc_days"] == b["days"]

    # Hari tanpa hujan: consecutive days < threshold, ending today
    hth = 0
    d = today
    while d.isoformat() in rain and rain[d.isoformat()] is not None \
            and rain[d.isoformat()] < WEATHER["dry_day_mm"]:
        hth += 1
        d -= timedelta(days=1)
    fc = [rain[k] for k in sorted(rain) if date.fromisoformat(k) > today and rain[k] is not None]
    obs30 = sum(rain.get((today - timedelta(days=k)).isoformat()) or 0 for k in range(30))
    return {
        "dasarian": das,
        "hth": hth,
        "obs_30d_mm": round(obs30, 1),
        "fc_mm": round(sum(fc), 1),
        "fc_days": len(fc),
        "fc_rain_days": sum(1 for v in fc if v >= WEATHER["dry_day_mm"]),
    }


def hth_class(n: int) -> str:
    """BMKG classes for consecutive days without rain."""
    for upper, name in WEATHER["hth_classes"]:
        if n <= upper:
            return name
    return WEATHER["hth_classes"][-1][1]


def monthly_rain(points, months):
    """{kec_id: {period_id: mm}} from the archive, for calibration.
    months: [(id, start, end_exclusive)]. Months still running are summed
    over the days the archive already has."""
    start = months[0][1]
    end = min(date.fromisoformat(months[-1][2]) - timedelta(days=1),
              date.today() - timedelta(days=WEATHER["archive_lag_days"])).isoformat()
    daily = daily_rain(points, start=start, end=end)
    out = {}
    for kid, rain in daily.items():
        out[kid] = {}
        for pid, s, e in months:
            vals = [v for k, v in rain.items() if s <= k < e and v is not None]
            out[kid][pid] = round(sum(vals), 1) if vals else None
    return out


def run(today=None):
    today = today or date.today()
    points = kecamatan_points()
    rain = daily_rain(points, past_days=WEATHER["past_days"], forecast_days=WEATHER["forecast_days"])
    kec = {}
    for kid, name, *_ in points:
        s = summarise(rain[kid], today, WEATHER["obs_dasarian"])
        s["hth_class"] = hth_class(s["hth"])
        kec[kid] = s
    out = {
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "today": today.isoformat(),
        "source": "Open-Meteo forecast API (model best_match), titik label kecamatan",
        "dry_day_mm": WEATHER["dry_day_mm"],
        "dry_dasarian_mm": WEATHER["dry_dasarian_mm"],
        "kecamatan": kec,
    }
    WEB_DATA_DIR.mkdir(parents=True, exist_ok=True)
    (WEB_DATA_DIR / "weather.json").write_text(json.dumps(out, indent=1))
    return out


if __name__ == "__main__":
    w = run()
    names = {p[0]: p[1] for p in kecamatan_points()}
    print(f"weather.json for {w['today']}")
    for kid, s in sorted(w["kecamatan"].items(), key=lambda kv: kv[1]["fc_mm"]):
        das = " ".join(f"{b['label']}:{b['obs_mm'] + b['fc_mm']:.0f}" for b in s["dasarian"])
        print(f"  {names[kid]:<12} HTH {s['hth']:>2} | 30d {s['obs_30d_mm']:>5.0f} mm | "
              f"16d fc {s['fc_mm']:>5.0f} mm | {das}")
