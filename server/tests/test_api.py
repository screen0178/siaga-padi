"""API rules: role gates, step order, optimistic concurrency, reports.
Run from the repo root: .venv/bin/python -m pytest server/tests -q"""

import os
import tempfile

os.environ["SIAGA_SCHEDULE"] = "0"
os.environ["SIAGA_DB"] = os.path.join(tempfile.mkdtemp(), "test.db")

from fastapi.testclient import TestClient  # noqa: E402

from server.app import app, current_period, kec_ids, desa_index  # noqa: E402

c = TestClient(app)
P = current_period()
K = sorted(kec_ids())[0]
PENY = {"name": "Sri Penyuluh", "role": "penyuluh"}
DINAS = {"name": "Budi Dinas", "role": "dinas"}


def step(frm, to, actor, kec=K, period=P):
    return c.post("/api/actions", json={"period_id": period, "kec_id": kec, "from_step": frm,
                                        "to_step": to, "actor": actor})


def test_full_flow_and_roles():
    assert step("open", "approved", DINAS).status_code == 422          # no skipping
    assert step("open", "proposed", DINAS).status_code == 403          # penyuluh proposes
    r = step("open", "proposed", PENY)
    assert r.status_code == 200 and r.json()["step"] == "proposed"
    assert step("proposed", "approved", PENY).status_code == 403       # only Dinas approves
    assert step("proposed", "approved", DINAS).status_code == 200
    assert step("approved", "sent", PENY).status_code == 200
    assert step("sent", "done", PENY).status_code == 200
    s = c.get("/api/state").json()["kecamatan"][K]
    assert s["step"] == "done" and [e["step"] for e in s["log"]] == ["proposed", "approved", "sent", "done"]
    assert s["log"][1]["actor"] == "Budi Dinas"


def test_stale_client_gets_409():
    k = sorted(kec_ids())[1]
    assert step("open", "proposed", PENY, kec=k).status_code == 200
    assert step("open", "proposed", PENY, kec=k).status_code == 409    # second officer, stale view


def test_reset_rules():
    k = sorted(kec_ids())[2]
    step("open", "proposed", PENY, kec=k)
    assert c.post("/api/actions/reset", json={"period_id": P, "kec_id": k, "actor": PENY}).status_code == 200
    step("open", "proposed", PENY, kec=k)
    step("proposed", "approved", DINAS, kec=k)
    assert c.post("/api/actions/reset", json={"period_id": P, "kec_id": k, "actor": PENY}).status_code == 403
    assert c.post("/api/actions/reset", json={"period_id": P, "kec_id": k, "actor": DINAS}).status_code == 200
    assert c.get("/api/state").json()["kecamatan"][k]["step"] == "open"


def test_past_period_is_read_only():
    assert step("open", "proposed", PENY, period="2000-01").status_code == 409
    assert c.get("/api/state", params={"period_id": "2000-01"}).json()["kecamatan"] == {}


def test_bad_input():
    assert step("open", "proposed", PENY, kec="nope").status_code == 404
    assert step("open", "proposed", {"name": "x", "role": "penyuluh"}).status_code == 422  # name too short
    assert step("open", "proposed", {"name": "Ana", "role": "admin"}).status_code == 422


def test_reports():
    desa = next(d for d in desa_index().values() if d["kec_id"] == K)
    other = next(d for d in desa_index().values() if d["kec_id"] != K)
    base = {"kec_id": K, "answer": "not_rice", "note": "tebu", "actor": PENY}
    r = c.post("/api/reports", json=base | {"desa_id": desa["id"]})
    assert r.status_code == 201 and r.json()["desa_name"] == desa["name"] and r.json()["period_id"] == P
    assert c.post("/api/reports", json=base | {"desa_id": other["id"]}).status_code == 422
    assert c.post("/api/reports", json=base | {"answer": "maybe"}).status_code == 422
    assert c.get("/api/state").json()["reports"][K][0]["answer"] == "not_rice"
    csv = c.get("/api/reports.csv").text.splitlines()
    assert csv[0].startswith("id,created_at") and "tebu" in csv[1]


def test_status_and_refresh_gate():
    s = c.get("/api/status").json()
    assert s["data"]["meta"] and set(s["jobs"]) == {"weather", "full"}
    assert c.post("/api/refresh", json={"job": "weather", "actor": PENY}).status_code == 403


def test_serves_data_contract():
    assert c.get("/data/meta.json").json()["contract_version"] == 1
