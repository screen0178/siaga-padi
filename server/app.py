"""SIAGA-Padi backend (Stage 3): shared action log, field reports, scheduled
pipeline refresh. Serves the data contract and the built web app too.

Run from the repo root (inside the pipeline venv):
  uvicorn server.app:app --port 8000
Environment:
  SIAGA_DB           SQLite path (default server/siaga.db)
  SIAGA_SCHEDULE=0   disable the scheduler
  SIAGA_EE_PROJECT   Earth Engine project; enables the weekly full refresh

Prototype identity: the client sends a name and a role (penyuluh / dinas)
with each write and the server enforces who may take which step. There is no
login yet, so this is accountability, not security.
"""

import asyncio
import csv
import io
import json
import os
from contextlib import asynccontextmanager
from functools import lru_cache
from pathlib import Path
from typing import Literal

from fastapi import FastAPI, HTTPException, Query
from fastapi.responses import PlainTextResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from .jobs import Runner, job_specs
from .store import Store

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "web" / "public" / "data"
DIST = ROOT / "web" / "dist"

# Mirrors web/src/workflow.ts
STEPS = ["open", "proposed", "approved", "sent", "done"]
STEP_ROLE = {"proposed": "penyuluh", "approved": "dinas", "sent": "penyuluh", "done": "penyuluh"}
ANSWERS = {"ok", "not_rice", "harvested", "irrigated", "puso", "gagal_tanam"}

Role = Literal["penyuluh", "dinas"]


class Actor(BaseModel):
    name: str = Field(min_length=2, max_length=60)
    role: Role


class StepIn(BaseModel):
    period_id: str
    kec_id: str
    from_step: str  # optimistic concurrency: the step the client saw
    to_step: str
    actor: Actor
    note: str | None = Field(default=None, max_length=500)


class ResetIn(BaseModel):
    period_id: str
    kec_id: str
    actor: Actor
    note: str | None = Field(default=None, max_length=500)


class ReportIn(BaseModel):
    kec_id: str
    desa_id: str | None = None
    answer: str
    note: str | None = Field(default=None, max_length=1000)
    actor: Actor


class RefreshIn(BaseModel):
    job: Literal["weather", "full"]
    actor: Actor


# ---------------------------------------------------------------- contract
@lru_cache(maxsize=4)
def _read(path: str, mtime: float):
    return json.loads(Path(path).read_text())


def read_json(name):
    p = DATA / name
    if not p.exists():
        return None
    return _read(str(p), p.stat().st_mtime)


def current_period() -> str:
    """Action logs belong to the run's current month."""
    m = read_json("meta.json")
    return m.get("current_period") or m["period"]["start"][:7]


def kec_ids() -> set[str]:
    return {f["properties"]["id"] for f in read_json("kecamatan.json")["features"]}


def desa_index() -> dict[str, dict]:
    return {f["properties"]["id"]: f["properties"] for f in read_json("desa.json")["features"]}


def check_kec(kec_id):
    if kec_id not in kec_ids():
        raise HTTPException(404, f"kecamatan tidak dikenal: {kec_id}")


def check_current(period_id):
    cur = current_period()
    if period_id != cur:
        raise HTTPException(409, f"periode {period_id} sudah lewat; tindakan hanya untuk periode berjalan {cur}")


# ---------------------------------------------------------------- app
store = Store(os.environ.get("SIAGA_DB", ROOT / "server" / "siaga.db"))
runner = Runner(store)
_tasks: set[asyncio.Task] = set()


@asynccontextmanager
async def lifespan(_app):
    if os.environ.get("SIAGA_SCHEDULE", "1") != "0":
        runner.start()
    yield
    await runner.stop()


app = FastAPI(title="SIAGA-Padi API", version="0.3.0", lifespan=lifespan)


@app.get("/api/health")
def health():
    return {"ok": True, "version": app.version, "current_period": current_period()}


def state_for(period_id):
    by_kec: dict[str, dict] = {}
    for e in store.events(period_id):
        s = by_kec.setdefault(e["kec_id"], {"step": "open", "log": []})
        s["step"] = "open" if e["kind"] == "reset" else e["step"]
        s["log"].append({"id": e["id"], "at": e["created_at"], "kind": e["kind"], "step": e["step"],
                         "actor": e["actor"], "role": e["role"], "note": e["note"]})
    return by_kec


@app.get("/api/state")
def state(period_id: str | None = Query(default=None)):
    """Workflow state for one period plus every field report (all periods)."""
    pid = period_id or current_period()
    desa = desa_index()
    reports: dict[str, list] = {}
    for r in store.reports():
        r["desa_name"] = desa.get(r["desa_id"] or "", {}).get("name")
        reports.setdefault(r["kec_id"], []).append(r)
    return {"period_id": pid, "current_period": current_period(), "kecamatan": state_for(pid), "reports": reports}


@app.post("/api/actions")
def take_step(body: StepIn):
    check_kec(body.kec_id)
    check_current(body.period_id)
    if body.to_step not in STEP_ROLE:
        raise HTTPException(422, f"langkah tidak dikenal: {body.to_step}")
    with store.conn(write=True) as c:
        cur = store.current_step(c, body.period_id, body.kec_id)
        if cur != body.from_step:
            raise HTTPException(409, f"status sudah berubah menjadi '{cur}' oleh pengguna lain")
        if STEPS.index(body.to_step) != STEPS.index(cur) + 1:
            raise HTTPException(422, f"tidak bisa lompat dari '{cur}' ke '{body.to_step}'")
        need = STEP_ROLE[body.to_step]
        if body.actor.role != need:
            raise HTTPException(403, f"langkah '{body.to_step}' hanya oleh {need}")
        store.add_event(c, body.period_id, body.kec_id, "step", body.to_step,
                        body.actor.name.strip(), body.actor.role, body.note)
    return state_for(body.period_id).get(body.kec_id)


@app.post("/api/actions/reset")
def reset(body: ResetIn):
    check_kec(body.kec_id)
    check_current(body.period_id)
    with store.conn(write=True) as c:
        cur = store.current_step(c, body.period_id, body.kec_id)
        if cur == "open":
            raise HTTPException(409, "belum ada tindakan untuk diatur ulang")
        # A penyuluh may withdraw their own proposal; anything approved needs Dinas
        if body.actor.role != "dinas" and cur != "proposed":
            raise HTTPException(403, "hanya Dinas Pertanian yang dapat membatalkan tindakan yang sudah disetujui")
        store.add_event(c, body.period_id, body.kec_id, "reset", cur,
                        body.actor.name.strip(), body.actor.role, body.note)
    return {"step": "open", "log": state_for(body.period_id).get(body.kec_id, {}).get("log", [])}


@app.post("/api/reports", status_code=201)
def add_report(body: ReportIn):
    check_kec(body.kec_id)
    if body.answer not in ANSWERS:
        raise HTTPException(422, f"jawaban tidak dikenal: {body.answer}")
    if body.desa_id:
        d = desa_index().get(body.desa_id)
        if not d or d["kec_id"] != body.kec_id:
            raise HTTPException(422, "desa tidak berada di kecamatan ini")
    r = store.add_report(current_period(), body.kec_id, body.desa_id, body.answer,
                         (body.note or "").strip() or None, body.actor.name.strip(), body.actor.role)
    r["desa_name"] = desa_index().get(body.desa_id or "", {}).get("name")
    return r


@app.get("/api/reports.csv", response_class=PlainTextResponse)
def reports_csv():
    """Field reports for calibration (TRAJECTORY thresholds, rice mask, Stage 4)."""
    rows = store.reports()
    desa = desa_index()
    buf = io.StringIO()
    cols = ["id", "created_at", "period_id", "kec_id", "desa_id", "desa_name", "answer", "note", "actor", "role"]
    w = csv.DictWriter(buf, fieldnames=cols, extrasaction="ignore")
    w.writeheader()
    for r in reversed(rows):
        w.writerow(r | {"desa_name": desa.get(r["desa_id"] or "", {}).get("name")})
    return PlainTextResponse(buf.getvalue(), media_type="text/csv; charset=utf-8")


@app.get("/api/status")
def status():
    def gen(name):
        d = read_json(name)
        return d.get("generated_at") if d else None

    jobs = {}
    for name, spec in job_specs().items():
        jobs[name] = {
            "label": spec["label"],
            "enabled": spec["enabled"],
            "interval_h": spec["interval"].total_seconds() / 3600,
            "running": runner.running == name,
            "last": store.last_run(name),
            "last_ok": (store.last_run(name, "ok") or {}).get("finished_at"),
            "next_due": runner.next_due(name, spec),
        }
    return {
        "data": {"meta": gen("meta.json"), "weather": gen("weather.json"), "scenario": gen("scenario.json")},
        "current_period": current_period(),
        "scheduler": os.environ.get("SIAGA_SCHEDULE", "1") != "0",
        "jobs": jobs,
    }


@app.post("/api/refresh", status_code=202)
async def refresh(body: RefreshIn):
    if body.actor.role != "dinas":
        raise HTTPException(403, "pembaruan data hanya oleh Dinas Pertanian")
    spec = job_specs()[body.job]
    if not spec["enabled"]:
        raise HTTPException(409, "pembaruan citra butuh SIAGA_EE_PROJECT di server")
    if runner.running or runner.lock.locked():
        raise HTTPException(409, f"pembaruan '{runner.running}' sedang berjalan")
    t = asyncio.create_task(runner.run(body.job, trigger=f"manual:{body.actor.name.strip()}"))
    _tasks.add(t)  # keep a reference until it finishes
    t.add_done_callback(_tasks.discard)
    return {"started": body.job}


# Data contract first (always fresh from the pipeline), then the built app
app.mount("/data", StaticFiles(directory=DATA), name="data")
if DIST.exists():
    app.mount("/", StaticFiles(directory=DIST, html=True), name="web")
