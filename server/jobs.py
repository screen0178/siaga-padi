"""Scheduled pipeline refresh.

Two jobs, run one at a time as subprocesses of the existing pipeline scripts
(the pipeline stays the single source of truth; the server only schedules it):

  weather  weather.py (+ forecast.py once a model     every 6 h (cheap, no Earth Engine)
           is trained)
  full     gee_export.py --last-months 6, then       every 7 days (Landsat 8+9 together
           scenario.py, then weather.py              revisit about every 8 days); needs
                                                     SIAGA_EE_PROJECT and EE credentials

Due-ness is computed from the runs table, so a restart does not re-run
everything. A failed job is retried after RETRY instead of the full interval.
"""

import asyncio
import os
import subprocess
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

PIPELINE = Path(__file__).resolve().parents[1] / "pipeline"
RETRY = timedelta(hours=1)
TICK_S = 300


def forecast_ready() -> bool:
    """A trained model and the Landsat observations it starts from (v2 Phase 2)."""
    ml = PIPELINE.parent / "data" / "ml"
    return (ml / "models" / "LATEST").exists() and any(ml.glob("obs_*.csv"))


def job_specs():
    py = sys.executable  # the server runs in the pipeline's venv
    project = os.environ.get("SIAGA_EE_PROJECT")
    months = os.environ.get("SIAGA_LAST_MONTHS", "6")
    fc = forecast_ready()
    return {
        "weather": {
            "label": "Curah hujan (Open-Meteo)" + (" + prakiraan" if fc else ""),
            "interval": timedelta(hours=float(os.environ.get("SIAGA_WEATHER_HOURS", 6))),
            "enabled": True,
            # New rain forecast -> new drought forecast
            "steps": [[py, "weather.py"]] + ([[py, "forecast.py"]] if fc else []),
        },
        "full": {
            "label": "Citra Landsat + skenario (Earth Engine)",
            "interval": timedelta(days=float(os.environ.get("SIAGA_FULL_DAYS", 7))),
            "enabled": bool(project),
            "steps": [
                [py, "gee_export.py", "--project", str(project), "--last-months", months],
                [py, "scenario.py", "--project", str(project)],
                [py, "weather.py"],
                # Adds the new Landsat dates to the training observations, then forecasts
                *([[py, "forecast.py", "--project", str(project)]] if fc else []),
            ],
        },
    }


class Runner:
    def __init__(self, store):
        self.store = store
        self.lock = asyncio.Lock()
        self.running: str | None = None
        self.task: asyncio.Task | None = None

    def due(self, name, spec, now=None) -> bool:
        if not spec["enabled"]:
            return False
        now = now or datetime.now(timezone.utc)
        ok = self.store.last_run(name, "ok")
        last = self.store.last_run(name)
        if ok and now - datetime.fromisoformat(ok["started_at"]) < spec["interval"]:
            return False
        # Back off after a failure instead of hammering a broken source
        if last and last["status"] == "failed" and now - datetime.fromisoformat(last["started_at"]) < RETRY:
            return False
        return True

    def next_due(self, name, spec):
        if not spec["enabled"]:
            return None
        ok = self.store.last_run(name, "ok")
        return (datetime.fromisoformat(ok["started_at"]) + spec["interval"]).isoformat() if ok else None

    async def run(self, name, trigger="schedule"):
        spec = job_specs()[name]
        async with self.lock:
            self.running = name
            run_id = self.store.start_run(name, trigger)
            log, ok = [], True
            try:
                for cmd in spec["steps"]:
                    log.append(f"$ {' '.join(Path(c).name if i == 0 else c for i, c in enumerate(cmd))}")
                    r = await asyncio.to_thread(subprocess.run, cmd, cwd=PIPELINE, capture_output=True,
                                                text=True, timeout=3 * 3600)
                    log.append((r.stdout + r.stderr).strip()[-3000:])
                    if r.returncode != 0:
                        ok = False
                        log.append(f"[exit {r.returncode}]")
                        break
            except Exception as e:  # timeout, missing interpreter, ...
                ok = False
                log.append(f"[error] {e!r}")
            finally:
                self.store.finish_run(run_id, ok, "\n".join(log)[-6000:])
                self.running = None
            return ok

    async def loop(self):
        while True:
            for name, spec in job_specs().items():
                if self.due(name, spec):
                    await self.run(name)
            await asyncio.sleep(TICK_S)

    def start(self):
        self.task = asyncio.create_task(self.loop())

    async def stop(self):
        if self.task:
            self.task.cancel()
