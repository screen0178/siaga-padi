import "./style.css";
import { createMap, type MapApi } from "./map";
import { cockpitHtml } from "./cockpit";
import { impactSection } from "./impact";
import { verificationPage, type Verification } from "./verify";
import { forecastCard, forecastSentence, modelPage, tgl } from "./forecast";
import { daysSince, freshness, latestScene, renderFresh } from "./fresh";
import { composeMessage } from "./message";
import { renderStrip, renderTrend, shortLabel } from "./timeline";
import { startTour, tourSeen } from "./tour";
import { tourSteps } from "./tourSteps";
import { drawLegend } from "./legend";
import { VERIFY_MIN_HA, feedbackExplainer, inactiveSection, reportCheck, reportSummary, verifyHa, verifySection, waterSection } from "./sections";
import { BULAN3, BULAN_PANJANG, esc, fmt, slug, when } from "./util";
import { STAGE_COLOR, STATUS_COLOR, type Anomaly, type Forecast, type KecFeature, type KecProps, type Meta, type Feedback, type Scenario, type Weather } from "./types";
import { renderRain, renderScenarioCurve } from "./weather";
import {
  FEEDBACK, ROLE_LABEL, STEPS, addReport, advance, canReset, canStep, feedbackLabel, getActor, getMode, getReports,
  ApiError, getReviews, getState, initStore, requestRefresh, resetStep, reviewForecast, serverStatus, setActor, stepLabel, sync,
  type Actor, type Review, type Role, type ServerStatus,
} from "./workflow";

const DATA = "./data";
const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector(sel) as T;

let meta: Meta;
let feats: KecFeature[];
let api: MapApi;
let selected: string | null = null;
let periodId: string | null = null; // null = single-period data (no time series)
let playTimer: number | null = null;
let weather: Weather | null = null; // Stage 2, optional
let scenario: Scenario | null = null; // Stage 2, optional
let scenN = 0; // dasarian without rain in the what-if (0 = observed)
let desaByKec: Record<string, { id: string; name: string }[]> = {};
let actor: Actor | null = getActor();
let status: ServerStatus | null = null; // Stage 3, server mode only
let fb: Feedback | null = null; // Stage 3: field reports as seen by the last pipeline run
let forecast: Forecast | null = null; // v2 Phase 2, optional
let fcStep: string | null = null; // forecast step on the map/ranking (null = observed)
let reviews: Record<string, Review> = {}; // Dinas verdicts on the current forecast
let anomaly: Anomaly | null = null; // v2 5.2, optional
let layerId = "status";
let verification: Verification | null = null; // v2 5.1, optional

/** Optional data file: null when missing or malformed. */
const optional = <T,>(file: string) =>
  fetch(`${DATA}/${file}`).then((r) => (r.ok ? (r.json() as Promise<T>) : null)).catch(() => null);

async function boot() {
  const [m, kec, desa, w, sc, f, fc, an, ver] = await Promise.all([
    fetch(`${DATA}/meta.json`).then((r) => r.json()),
    fetch(`${DATA}/kecamatan.json`).then((r) => r.json()),
    fetch(`${DATA}/desa.json`).then((r) => r.json()),
    optional<Weather>("weather.json"),
    optional<Scenario>("scenario.json"),
    optional<Feedback>("feedback.json"),
    optional<Forecast>("forecast.json"),
    optional<Anomaly>("anomaly.json"),
    optional<Verification>("verification.json"),
  ]);
  anomaly = an;
  verification = ver;
  fb = f;
  meta = m;
  forecast = fc && meta.periods?.length ? fc : null;
  weather = w;
  // A scenario only makes sense for the period it was computed from
  scenario = sc && meta.periods?.some((p) => p.id === sc.period_id) ? sc : null;
  feats = (kec.features as KecFeature[]).slice().sort((a, b) => a.properties.rank - b.properties.rank);
  for (const f of desa.features as { properties: { id: string; name: string; kec_id: string } }[])
    (desaByKec[f.properties.kec_id] ??= []).push({ id: f.properties.id, name: f.properties.name });
  Object.values(desaByKec).forEach((l) => l.sort((a, b) => a.name.localeCompare(b.name)));
  // Action log stays tied to the run's current month, not the month being viewed
  await initStore(meta.current_period ?? meta.period.start.slice(0, 7));
  if (forecast) reviews = await getReviews(forecast.generated_at);
  if (meta.periods?.length) {
    periodId = meta.current_period ?? meta.periods[meta.periods.length - 1].id;
    document.body.classList.add("has-periods");
  }

  renderTopbar();
  renderFresh($("#fresh"), freshness(meta, weather, forecast));
  renderScenarioControl();
  renderRanking();
  renderLayerbar();
  renderTimeline();
  // Side panels end above the bottom bar, whatever it currently holds
  const lb = document.querySelector<HTMLElement>(".layerbar")!;
  new ResizeObserver(() => document.documentElement.style.setProperty("--lb-h", `${lb.offsetHeight}px`)).observe(lb);

  api = await createMap($("#map"), meta, kec, desa, DATA);
  api.onSelect((id) => openDetail(id, false));
  $("#loading").remove();
  renderWho();
  startSync();
  startFreshClock();

  const hash = location.hash.slice(1);
  const fromHash = feats.find((f) => slug(f.properties.name) === hash);
  if (fromHash) openDetail(fromHash.properties.id, true);
  $("#tour-btn").onclick = runTour;
  $("#cockpit-btn").onclick = openCockpit;
  if (verification) {
    $("#fresh").classList.add("clickable");
    $("#fresh").onclick = openVerification;
  }
  // Links rendered inside panels and dialogs
  document.addEventListener("click", (e) => {
    if ((e.target as Element).closest?.("[data-open=verify]")) { e.preventDefault(); openVerification(); }
  });
  // First visit: start the tour, unless the link points at a kecamatan
  if (!fromHash && !tourSeen()) runTour();
}

// ---------------------------------------------------------------- guided tour (v2 1.2)
function runTour() {
  const wasSelected = selected;
  const top = feats[0]?.properties;
  const openTop = () => { if (top && selected !== top.id) openDetail(top.id, true); };
  const steps = tourSteps({ meta, forecast, anomaly, verification, top, openTop });
  startTour(steps, () => {
    if (!wasSelected && selected) closeDetail();
  });
}


// ---------------------------------------------------------------- periods
const curPeriodId = () => meta.current_period ?? meta.periods!.at(-1)!.id;

async function setPeriod(id: string) {
  const p = meta.periods?.find((x) => x.id === id);
  if (!p) return;
  if (id === periodId) {
    if (fcStep) setForecastStep(null); // clicking the month leaves the forecast view
    return;
  }
  periodId = id;
  scenN = 0; // the what-if belongs to one period; leaving it shows observed data
  fcStep = null;
  document.body.classList.remove("scen-on", "fc-on");
  meta.period = { start: p.start, end: p.end, label: p.label };
  meta.totals = p.totals;
  for (const f of feats) {
    const s = f.properties.series?.[id];
    if (s) Object.assign(f.properties, s);
  }
  feats.sort((a, b) => a.properties.rank - b.properties.rank);
  renderTopbar();
  renderScenarioControl();
  renderRanking();
  renderTimeline();
  const f = selected ? feats.find((x) => x.properties.id === selected) : null;
  if (f) renderDetail(f.properties, false);
  await api.setPeriod(p.layers_dir);
  if (layerId === "anomaly") { api.setDesaValues(anomalyZ()); renderLegend("anomaly"); }
}

// ---------------------------------------------------------------- NDDI anomaly (v2 5.2)
const anomPeriod = () => (anomaly && periodId ? anomaly.periods[periodId] : undefined);
function anomalyZ(): Record<string, number> | null {
  const a = anomPeriod();
  return a ? Object.fromEntries(Object.entries(a.desa).map(([k, v]) => [k, v.z])) : null;
}
function anomalyLine(p: KecProps) {
  const a = anomPeriod()?.kecamatan[p.id];
  if (!a || !periodId) return "";
  const word = a.z >= 1 ? "lebih kering dari biasanya" : a.z <= -1 ? "lebih basah dari biasanya" : "mendekati biasanya";
  const cls = a.z >= 1 ? "dry" : a.z <= -1 ? "wet" : "";
  return `<p class="anom ${cls}" title="Rata-rata NDDI padi aktif bulan ini dibanding bulan yang sama ${anomaly!.baseline_years.join("–")} (${a.desa} desa dengan ≥ ${anomaly!.min_years} tahun data). z = selisih dibagi simpangan baku antar-tahun.">Dibanding ${BULAN_PANJANG[Number(periodId.slice(5, 7)) - 1]} ${anomaly!.baseline_years.join("–")}: <b>${word}</b> <span>z ${a.z > 0 ? "+" : ""}${fmt(a.z, 1)} · NDDI ${a.diff > 0 ? "+" : ""}${fmt(a.diff, 2)}</span></p>`;
}

function stepPeriod(dir: 1 | -1) {
  const ps = meta.periods;
  if (!ps || !periodId) return false;
  const i = ps.findIndex((p) => p.id === periodId) + dir;
  if (i < 0 || i >= ps.length) return false;
  void setPeriod(ps[i].id);
  return true;
}

function togglePlay() {
  if (playTimer != null) {
    clearInterval(playTimer);
    playTimer = null;
  } else {
    const ps = meta.periods!;
    if (periodId === ps[ps.length - 1].id) void setPeriod(ps[0].id);
    playTimer = window.setInterval(() => {
      if (!stepPeriod(1)) togglePlay();
    }, 1400);
  }
  renderTimeline();
}

function renderTimeline() {
  const el = $("#timeline");
  if (!meta.periods?.length || !periodId) return;
  el.hidden = false;
  const scene = latestScene(meta);
  const fr = freshness(meta, weather, forecast).find((f) => f.key === "scene");
  const d = new Date();
  const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  renderStrip(el, meta, periodId, (id) => void setPeriod(id), togglePlay, playTimer != null, {
    today, scene, days: scene ? daysSince(scene) : null, level: fr?.level ?? "ok",
    onPick: () => void setPeriod(curPeriodId()),
    forecast: forecast ? {
      steps: forecast.steps.map((st) => ({ ...st, ha: forecast!.totals[st.id]?.ha ?? [0, 0, 0] })),
      selected: fcStep, onPick: (id) => void setForecastStep(fcStep === id ? null : id),
    } : undefined,
  });
}

// ---------------------------------------------------------------- what-if
const monthName = (id: string) => BULAN3[Number(id.slice(5, 7)) - 1] ?? id;
/** Observed values of the scenario's period (props are mutated in place). */
const observed = (p: KecProps): KecProps => ({ ...p, ...(periodId ? p.series?.[periodId] : undefined) });
const viewIsModel = () => scenN > 0 || fcStep != null;

function setScenario(n: number) {
  if (!scenario || periodId !== scenario.period_id) return;
  scenN = Math.max(0, Math.min(scenario.max_dasarian, n));
  if (scenN > 0 && fcStep) { fcStep = null; document.body.classList.remove("fc-on"); renderTimeline(); }
  const period = meta.periods!.find((p) => p.id === scenario!.period_id)!;
  for (const f of feats) {
    const p = f.properties;
    Object.assign(p, p.series?.[period.id]); // back to observed first
    const s = scenario.kecamatan[p.id]?.[String(scenN)];
    if (scenN > 0 && s) Object.assign(p, s);
  }
  const t = scenario.totals[String(scenN)];
  meta.totals = scenN > 0 ? { ...period.totals, class_ha: t.class_ha, active_ha: t.active_ha } : period.totals;
  document.body.classList.toggle("scen-on", scenN > 0);
  feats.sort((a, b) => a.properties.rank - b.properties.rank);
  renderTopbar();
  renderScenarioControl();
  renderRanking();
  const f = selected ? feats.find((x) => x.properties.id === selected) : null;
  if (f) renderDetail(f.properties, false);
  api?.refresh();
}

/** v2 1.1: the what-if is entered from the detail panel ("Uji skenario") and
 * shown as a bar above the timeline while it is on, so it never looks like
 * part of the observed data. */
function renderScenarioControl() {
  const el = $("#scenario");
  if (!scenario || scenN === 0 || periodId !== scenario.period_id) { el.hidden = true; el.innerHTML = ""; return; }
  el.hidden = false;
  const max = scenario.max_dasarian;
  const months = scenario.calibration.months.map((m) => monthName(m.pair.split(">")[1]));
  const t0 = scenario.totals["0"], tn = scenario.totals[String(scenN)];
  const st = (t: { class_ha: Record<string, number> }) => (t.class_ha["4"] ?? 0) + (t.class_ha["5"] ?? 0);
  const fcVals = weather ? Object.values(weather.kecamatan).map((k) => k.fc_mm).sort((a, b) => a - b) : [];
  const fcMed = fcVals.length ? fcVals[Math.floor(fcVals.length / 2)] : null;
  const fcDays = weather ? Object.values(weather.kecamatan)[0]?.fc_days : 0;
  el.innerHTML = `
    <div class="scen-h"><b>Uji skenario: tanpa hujan</b>
      <span class="scen-v">${scenN} dasarian (±${scenN * 10} hari)</span>
      <button class="ghost" id="scen-off">✕ Kembali ke data teramati</button></div>
    <div class="scen-row">
      <input id="scen-range" type="range" min="1" max="${max}" step="1" value="${scenN}"
        aria-label="Jumlah dasarian tanpa hujan" aria-valuetext="${scenN} dasarian" />
      <p class="scen-eff">Cekaman kuat–ekstrem <b>${fmt(st(t0))} → ${fmt(st(tn))} ha</b> · ha berisiko ${fmt(t0.ha_at_risk)} → ${fmt(tn.ha_at_risk)}</p>
    </div>
    <p class="fine">Skenario uji, bukan prakiraan${fcMed != null ? `: prakiraan ${fcDays} hari ke depan justru ±${fmt(fcMed)} mm (median kecamatan)` : ""}. Laju pengeringan diulang dari bulan kering 2026 (${months.join(", ")}); fase tumbuh dan luas dianggap tetap. Peta raster tetap citra terakhir.</p>`;
  const r = el.querySelector<HTMLInputElement>("#scen-range")!;
  r.oninput = () => setScenario(Number(r.value));
  el.querySelector<HTMLButtonElement>("#scen-off")!.onclick = () => setScenario(0);
}

// ---------------------------------------------------------------- forecast view (v2 Phase 2)
const fcOf = (p: KecProps) => (forecast && fcStep ? forecast.kecamatan[p.id]?.steps[fcStep] : undefined);

/** Show a forecast step on the map and the ranking (null = back to observed).
 * Only status, H and the order change; the detail panel keeps observed data. */
function setForecastStep(id: string | null) {
  if (!forecast || !meta.periods) return;
  if (id && periodId !== curPeriodId()) void setPeriod(curPeriodId()); // forecasts start from the current month
  if (scenN > 0) setScenario(0);
  fcStep = id;
  for (const f of feats) {
    const p = f.properties;
    Object.assign(p, p.series?.[periodId!]);
    const s = fcOf(p);
    if (s) { p.status = s.status; p.hazard_index = s.hazard[1]; }
  }
  if (id) {
    // Rank by forecast Kuat+Ekstrem ha, discounted by irrigation as on the map
    const key = (p: KecProps) => (fcOf(p)?.ha[1] ?? -1) * (p.capacity_factor ?? 1);
    feats.sort((a, b) => key(b.properties) - key(a.properties));
    feats.forEach((f, i) => (f.properties.rank = i + 1));
  } else {
    feats.sort((a, b) => a.properties.rank - b.properties.rank);
  }
  document.body.classList.toggle("fc-on", id != null);
  renderTopbar();
  renderRanking();
  renderTimeline();
  const f = selected ? feats.find((x) => x.properties.id === selected) : null;
  if (f) renderDetail(f.properties, false);
  api?.refresh();
}

/** Change in ha-at-risk versus the previous period, for the ranking list. */
function deltaHtml(p: KecProps) {
  const s = fcOf(p);
  if (s) {
    const obs = (p.class_ha["4"] ?? 0) + (p.class_ha["5"] ?? 0);
    const d = s.ha[1] - obs;
    if (Math.abs(d) < 0.5) return `<span class="delta">= vs peta</span>`;
    return `<span class="delta ${d > 0 ? "up" : "down"}">${d > 0 ? "▲" : "▼"} ${fmt(Math.abs(d))} vs peta</span>`;
  }
  if (scenN > 0 && scenario) {
    const obs = p.series?.[scenario.period_id];
    if (!obs) return "";
    const d = p.ha_at_risk - obs.ha_at_risk;
    if (Math.abs(d) < 0.5) return `<span class="delta">= vs teramati</span>`;
    return `<span class="delta ${d > 0 ? "up" : "down"}">${d > 0 ? "▲" : "▼"} ${fmt(Math.abs(d))} vs teramati</span>`;
  }
  const ps = meta.periods;
  if (!ps || !periodId || !p.series) return "";
  const i = ps.findIndex((x) => x.id === periodId);
  const prev = i > 0 ? p.series[ps[i - 1].id] : undefined;
  if (!prev) return "";
  const d = p.ha_at_risk - prev.ha_at_risk;
  if (Math.abs(d) < 0.5) return `<span class="delta">= vs ${shortLabel(ps[i - 1])}</span>`;
  return `<span class="delta ${d > 0 ? "up" : "down"}">${d > 0 ? "▲" : "▼"} ${fmt(Math.abs(d))} vs ${shortLabel(ps[i - 1])}</span>`;
}

// ---------------------------------------------------------------- top bar
function renderTopbar() {
  const t = meta.totals.class_ha;
  const stressed = (t["4"] ?? 0) + (t["5"] ?? 0);
  const cs = meta.totals.cropland_stage_ha;
  const NA = ["6", "7", "8", "9", "10"];
  const inactive = cs && NA.some((k) => k in cs) ? NA.reduce((a, k) => a + (cs[k] ?? 0), 0) : null;
  const count = (s: string) => feats.filter((f) => f.properties.status === s).length;
  const fst = forecast && fcStep ? forecast.steps.find((x) => x.id === fcStep) : undefined;
  $("#region").innerHTML = `${esc(meta.region.name)} · ${fst ? `<span class="fc-tag">PRAKIRAAN ${esc(fst.label)} · ${tgl(fst.date)}</span>` : esc(meta.period.label)}${scenN > 0 ? ` <span class="scen-tag">Skenario: tanpa hujan ${scenN} dasarian</span>` : ""}`;
  const ft = fst ? forecast!.totals[fst.id] : undefined;
  $("#summary").innerHTML = `
    <div class="chip"><span class="k">Padi aktif</span><span class="v">${fmt(meta.totals.active_ha)} ha</span></div>
    ${ft ? `<div class="chip fc" title="Prakiraan model, kisaran P10–P90 ${fmt(ft.ha[0])}–${fmt(ft.ha[2])} ha (peta: ${fmt(stressed)} ha)"><span class="k">Kuat–ekstrem · prakiraan</span><span class="v" style="color:#ff8a7a">${fmt(ft.ha[1])} ha <small>${fmt(ft.ha[0])}–${fmt(ft.ha[2])}</small></span></div>`
      : `<div class="chip"><span class="k">Cekaman kuat–ekstrem</span><span class="v" style="color:#ff8a7a">${fmt(stressed)} ha</span></div>`}
    ${inactive != null ? `<div class="chip" title="Sawah yang tidak dihitung sebagai padi aktif: bera / tidak tumbuh, sudah panen, atau bukan padi menurut laporan lapangan. Perlu cek lapangan."><span class="k">Sawah tidak aktif</span><span class="v">${fmt(inactive)} ha</span></div>` : ""}
    <div class="chip"><span class="k">Kecamatan</span><span class="v">
      <i style="--c:${STATUS_COLOR.Awas}"></i>${count("Awas")}
      <i style="--c:${STATUS_COLOR.Siaga}"></i>${count("Siaga")}
      <i style="--c:${STATUS_COLOR.Waspada}"></i>${count("Waspada")}
      <i style="--c:${STATUS_COLOR.Normal}"></i>${count("Normal")}</span></div>`;
  if (meta.mode === "placeholder") {
    $("#banner").innerHTML = `<b>DATA SAMPEL</b> Angka dan piksel di peta ini sintetis (meniru hasil NgabubuGIS #2). Jalankan <code>pipeline/gee_export.py</code> untuk data Landsat nyata.`;
    $("#banner").hidden = false;
  }
}

// ---------------------------------------------------------------- ranking
function classBar(p: KecProps) {
  const total = Object.values(p.class_ha).reduce((a, b) => a + b, 0) || 1;
  return `<div class="cbar">${meta.nddi_classes
    .map((c) => {
      const v = p.class_ha[String(c.id)] ?? 0;
      return v > 0 ? `<span style="width:${(100 * v) / total}%;background:${c.color}" title="${c.label}: ${fmt(v)} ha"></span>` : "";
    })
    .join("")}</div>`;
}

function renderRanking() {
  $("#rank-list").innerHTML = feats
    .map(({ properties: p }) => {
      const st = getState(p.id);
      const stepLabel = STEPS.find((s) => s.id === st.step)!.label;
      return `
      <li data-id="${p.id}" class="${selected === p.id ? "sel" : ""}">
        <div class="r-num">${p.rank}</div>
        <div class="r-body">
          <div class="r-top"><span class="r-name">${esc(p.name)}</span>
            <span class="pill" style="--c:${STATUS_COLOR[p.status]}">${p.status}</span></div>
          ${classBar(p)}
          <div class="r-meta"><span>${fcOf(p) ? `<b>${fmt(fcOf(p)!.ha[1])}</b> ha kuat–ekstrem <span class="r-conf">${fcOf(p)!.confidence}</span>` : `<b>${fmt(p.ha_at_risk)}</b> ha berisiko`} ${deltaHtml(p)}${p.water_source ? ` <span class="r-water ${p.water_source === "tadah hujan" ? "rf" : ""}" title="Sumber air dominan (data resmi 2024)">${p.water_source}</span>` : ""}</span>
            <span class="r-step ${st.step}">${stepLabel}</span></div>
          ${p.action ? `<div class="r-act">${esc(p.action.headline)}</div>` : ""}
          ${verifyHa(p) >= VERIFY_MIN_HA ? `<div class="r-verify" title="Panen atau puso? ${fmt(p.cropland_stage_ha?.["9"] ?? 0)} ha · gagal tanam? ${fmt(p.cropland_stage_ha?.["10"] ?? 0)} ha">⚠ ${fmt(verifyHa(p))} ha perlu cek lapangan (puso? / gagal tanam?)</div>` : ""}
        </div>
      </li>`;
    })
    .join("");
  $("#rank-list").querySelectorAll("li").forEach((li) =>
    li.addEventListener("click", () => openDetail(li.dataset.id!, true)),
  );
}

// ---------------------------------------------------------------- detail
/** One line: when does this kecamatan first change status without rain? */
function scenarioSentence(id: string) {
  const s = scenario!.kecamatan[id];
  const st0 = s["0"].status;
  for (let n = 1; n <= scenario!.max_dasarian; n++) {
    if (s[String(n)].status !== st0)
      return `Tanpa hujan, status berubah dari <b>${st0}</b> ke <b>${s[String(n)].status}</b> setelah ±${n} dasarian (${n * 10} hari). Ha berisiko setelah ${scenario!.max_dasarian} dasarian: ${fmt(s[String(scenario!.max_dasarian)].ha_at_risk)} ha (sekarang ${fmt(s["0"].ha_at_risk)}).`;
  }
  return `Status tetap <b>${st0}</b> sampai ${scenario!.max_dasarian} dasarian tanpa hujan; ha berisiko ${fmt(s["0"].ha_at_risk)} → ${fmt(s[String(scenario!.max_dasarian)].ha_at_risk)} ha.`;
}

function openDetail(id: string, fly: boolean) {
  selected = id;
  const f = feats.find((x) => x.properties.id === id);
  if (!f) return;
  api.select(id, fly);
  renderDetail(f.properties);
  renderRanking();
  try { history.replaceState(null, "", `#${slug(f.properties.name)}`); } catch { /* sandboxed */ }
}

function closeDetail() {
  selected = null;
  api.select(null);
  $("#detail").classList.remove("open");
  renderRanking();
  try { history.replaceState(null, "", location.pathname); } catch { /* sandboxed */ }
}

function renderDetail(p: KecProps, resetScroll = true) {
  const el = $("#detail");
  const st = getState(p.id);
  const stepIdx = STEPS.findIndex((s) => s.id === st.step);
  const next = STEPS[stepIdx + 1];
  const stressed = p.stressed_stage_ha;
  const stressedTotal = Object.values(stressed).reduce((a, b) => a + b, 0) || 1;
  const kw = weather?.kecamatan[p.id];
  // Messages to farmers always use observed data (never the what-if); a
  // forecast sentence is added only when confident or accepted by Dinas
  const obsP = viewIsModel() ? observed(p) : p;
  const fcLine = forecast && periodId === curPeriodId() ? forecastSentence(forecast, p.id, reviews[p.id]) : null;
  const msg = composeMessage(obsP, meta, kw, fcLine);
  const obs = scenN > 0 ? observed(p) : null;
  const fs = fcOf(p);
  const totalClass = Object.values(p.class_ha).reduce((a, b) => a + b, 0) || 1;
  const reps = getReports(p.id);

  el.innerHTML = `
    <header>
      <div>
        <div class="d-kicker">Kecamatan · peringkat ${p.rank} dari ${feats.length}${obs ? ` · skenario ${scenN} dasarian tanpa hujan` : ""}${fs ? ` · prakiraan ${forecast!.steps.find((x) => x.id === fcStep)!.label}` : ""}</div>
        <h2>${esc(p.name)}</h2>
      </div>
      <button class="icon" id="d-close" aria-label="Tutup">✕</button>
    </header>
    <div class="d-status" style="--c:${STATUS_COLOR[p.status]}">
      <span class="dot"></span><b>${p.status}</b>
      <span class="d-why">${fs ? `prakiraan model, H = ${fmt(fs.hazard[1], 2)} · keyakinan ${fs.confidence.toLowerCase()} · peta ${observed(p).status}` : `indeks bahaya H = ${fmt(p.hazard_index, 2)}`}${obs ? ` · teramati ${obs.status} (${fmt(obs.hazard_index, 2)})` : ""}</span>
    </div>

    <div class="kpis">
      <div><span>NDDI rata-rata${obs ? " (teramati)" : ""}</span><b>${fmt(p.mean_nddi, 2)}</b></div>
      <div><span>Padi aktif</span><b>${fmt(p.active_ha)} <small>ha</small></b></div>
      <div><span>Berisiko (terbobot)</span><b>${fmt(p.ha_at_risk)} <small>ha${obs ? ` · teramati ${fmt(obs.ha_at_risk)}` : ""}</small></b></div>
      <div><span>NDVI / NDMI</span><b>${fmt(p.mean_ndvi, 2)} / ${fmt(p.mean_ndmi, 2)}</b></div>
    </div>

    ${anomalyLine(observed(p))}

    ${forecast && periodId === curPeriodId() ? forecastCard(forecast, p.id, observed(p).status, fcStep, reviews[p.id], {
      canReview: actor?.role === "dinas" && getMode() === "server", serverMode: getMode() === "server",
      obsLabel: curPeriodLabel().split(" (")[0],
    }) : ""}

    ${periodId && p.series ? `
    <section>
      <h3>Tren NDDI rata-rata <span class="h3-note">titik bawah = status</span></h3>
      <div id="d-trend" class="trend"></div>
    </section>` : ""}

    ${kw ? `
    <section>
      <h3>Hujan per dasarian <span class="h3-note">Open-Meteo, mm</span></h3>
      <div class="rain-facts">
        <div><span>Hari tanpa hujan</span><b>${kw.hth}</b><small>${kw.hth_class}</small></div>
        <div><span>30 hari terakhir</span><b>${fmt(kw.obs_30d_mm)}</b><small>mm</small></div>
        <div><span>Prakiraan ${kw.fc_days} hari</span><b>${fmt(kw.fc_mm)}</b><small>mm · ${kw.fc_rain_days} hari hujan</small></div>
      </div>
      <div id="d-rain" class="trend"></div>
    </section>` : ""}

    ${scenario && periodId === scenario.period_id && scenario.kecamatan[p.id] ? `
    <section>
      <h3>Jika tidak hujan <span class="h3-note">ha berisiko per dasarian · klik titik</span></h3>
      <div id="d-scen" class="trend"></div>
      <p class="fine">${scenarioSentence(p.id)}</p>
      ${scenN === 0 ? `<button class="ghost" id="d-scen-on">Uji skenario untuk semua kecamatan</button>` : ""}
    </section>` : ""}

    <section>
      <h3>Sebaran kelas kekeringan</h3>
      ${classBar(p)}
      <ul class="legend-rows">${meta.nddi_classes
        .map((c) => `<li><i style="--c:${c.color}"></i>${c.label}<span>${fmt(p.class_ha[String(c.id)] ?? 0)} ha · ${fmt((100 * (p.class_ha[String(c.id)] ?? 0)) / totalClass)}%</span></li>`)
        .join("")}</ul>
    </section>

    ${impactSection(p.impact, periodId === curPeriodId() ? observed(p).options ?? [] : null, meta, {
      label: scenN > 0 ? `skenario ${scenN} dasarian` : fcStep ? "data teramati" : curPeriodLabel() === meta.period.label ? "bulan berjalan" : meta.period.label.split(" (")[0],
      fcRainMm: kw?.fc_mm, fcDays: kw?.fc_days,
      optsNote: scenN > 0 ? "Opsi dihitung dari data teramati, bukan skenario." : undefined,
    })}
    ${verifySection(p)}
    ${waterSection(p)}
    ${inactiveSection(p, meta, fb)}

    <section>
      <h3>Fase tumbuh pada lahan tercekam kuat</h3>
      <div class="cbar">${["2", "3", "4"]
        .map((s) => (stressed[s] ?? 0) > 0 ? `<span style="width:${(100 * stressed[s]) / stressedTotal}%;background:${STAGE_COLOR[s]}"></span>` : "")
        .join("")}</div>
      <ul class="legend-rows">${meta.stage_classes
        .filter((s) => s.active)
        .map((s) => `<li><i style="--c:${STAGE_COLOR[String(s.id)]}"></i>${s.label}<span>${fmt(stressed[String(s.id)] ?? 0)} ha</span></li>`)
        .join("")}</ul>
    </section>

    ${p.action ? `
    <section class="reco">
      <h3>Rekomendasi untuk penyuluh${obs ? " (skenario)" : ""} <span class="urg">${p.action.urgency}</span></h3>
      <p class="reco-h">${esc(p.action.headline)}</p>
      <ol>${p.action.steps.map((s) => `<li>${esc(s)}</li>`).join("")}</ol>
    </section>` : `<section class="reco ok"><h3>Rekomendasi</h3><p>Tidak ada tindakan khusus. Lanjutkan pemantauan rutin.</p></section>`}

    <section>
      <h3>Alur tindakan <span class="h-note">${getMode() === "server" ? "bersama" : "lokal"} · ${esc(curPeriodLabel())}</span></h3>
      <ol class="stepper">${STEPS.slice(1)
        .map((s, i) => `<li class="${i + 1 <= stepIdx ? "done" : i + 1 === stepIdx + 1 ? "next" : ""}"><b>${s.label}</b><span>${s.who}</span></li>`)
        .join("")}</ol>
      <div class="row">
        ${!next ? `<span class="muted">Selesai ditindaklanjuti.</span>`
          : !actor ? `<button class="primary" id="d-who">Masuk untuk mencatat tindakan</button>`
          : canStep(next.id, actor) ? `<button class="primary" id="d-advance">Tandai: ${next.label}</button>`
          : `<span class="muted">Menunggu ${next.who}: ${next.label.toLowerCase()}</span>`}
        ${canReset(st.step, actor) ? `<button class="ghost" id="d-reset">${actor!.role === "dinas" ? "Batalkan" : "Tarik usulan"}</button>` : ""}
      </div>
      <p class="wf-err" id="d-wf-err" hidden></p>
      ${st.log.length ? `<ul class="log">${st.log.slice().reverse().map((l) => `<li><time>${when(l.at)}</time> ${l.kind === "reset" ? `↺ dibatalkan (dari ${esc(stepLabel(l.step))})` : `→ ${esc(stepLabel(l.step))}`}${l.actor ? ` <span class="who-tag">${esc(l.actor)}${l.role ? ` · ${ROLE_LABEL[l.role]}` : ""}</span>` : ""}${l.note ? ` <em>${esc(l.note)}</em>` : ""}</li>`).join("")}</ul>` : ""}
    </section>

    <section>
      <h3>Pesan untuk Gapoktan</h3>
      <pre class="msg">${esc(msg)}</pre>
      <div class="row">
        <button class="primary" id="d-copy">Salin pesan</button>
        <a class="ghost btn" href="https://wa.me/?text=${encodeURIComponent(msg)}" target="_blank" rel="noopener">Buka WhatsApp</a>
      </div>
    </section>

    <section>
      <h3>Laporan cek lapangan</h3>
      ${reportSummary(reps)}
      <form id="d-fb">
        <p class="ask">Lahan yang ditandai: <b>panen biasa / bera</b>, <b>puso</b>, atau <b>gagal tanam</b>?</p>
        ${FEEDBACK.map((o, i) => `<label class="radio"><input type="radio" name="fb" value="${o.id}" ${i === 0 ? "checked" : ""}> ${o.label}</label>`).join("")}
        <select name="desa"><option value="">Desa (opsional)</option>${(desaByKec[p.id] ?? []).map((d) => `<option value="${d.id}">${esc(d.name)}</option>`).join("")}</select>
        <input type="text" name="note" maxlength="1000" placeholder="Catatan (opsional): blok, komoditas, foto…" />
        <button class="ghost" type="submit">${actor ? "Kirim laporan" : "Masuk lalu kirim laporan"}</button>
        <p class="wf-err" id="d-fb-err" hidden></p>
      </form>
      <ul class="log">${reps
        .map((r) => `<li><time>${when(r.created_at)}</time> 📍 ${esc(feedbackLabel(r.answer))}${r.desa_name ? ` · ${esc(r.desa_name)}` : ""}${r.actor ? ` <span class="who-tag">${esc(r.actor)}</span>` : ""}${r.note ? ` <em>${esc(r.note)}</em>` : ""}${reportCheck(r, fb)}</li>`)
        .join("") || `<li class="muted">Belum ada laporan.</li>`}</ul>
      <p class="fine">${getMode() === "server"
        ? "Laporan tersimpan di server dan terlihat oleh semua pengguna. Jawaban \"Bukan padi\" dan \"Sudah panen / bera\" dipakai untuk mengoreksi masker padi dan ambang lintasan NDVI."
        : "Server tidak terhubung: laporan dan alur tindakan hanya tersimpan di peramban ini."}</p>
    </section>

    <details class="fine">
      <summary>Bagaimana status dihitung?</summary>
      <p>H = rata-rata bobot bahaya kelas NDDI pada padi aktif (Normal 0, Ringan 0,1, Sedang 0,5, Kuat 0,85, Ekstrem 1). Status: H &lt; 0,40 Normal, &lt; 0,60 Waspada, &lt; 0,75 Siaga, selebihnya Awas. Ha berisiko = luas × bobot bahaya × kerentanan fase (reproduktif 1,0; vegetatif akhir 0,7; vegetatif awal 0,5). Peringkat memakai ha berisiko × (1 − 0,3 × pangsa sawah irigasi): kapasitas air menurunkan prioritas, bukan status. Bobot bersifat provisional, mengikuti logika indeks H-MHEWS, dan dikalibrasi dengan laporan lapangan.</p>
      ${scenario ? `<p><b>Skenario tanpa hujan</b></p><p>Distribusi NDDI tiap kecamatan digeser mengikuti perubahan persentil NDDI padi aktif pada bulan kering 2026 (${scenario.calibration.months.map((m) => `${m.pair.split(">").map(monthName).join("→")}, hujan ${fmt(m.rain_mm)} mm`).join("; ")}), lalu dinilai ulang dengan aturan yang sama. Uji balik per kecamatan: galat rata-rata ${scenario.calibration.months.map((m) => `${fmt(m.kec_mae_ha)} ha`).join(" / ")} vs ${scenario.calibration.months.map((m) => `${fmt(m.persist_mae_ha)} ha`).join(" / ")} bila diasumsikan tidak berubah. Fase tumbuh, luas padi aktif, dan irigasi dianggap tetap.</p>` : ""}
      ${feedbackExplainer(fb)}
      ${verification ? `<p><button class="link" data-open="verify">Verifikasi data dan model: semua uji, termasuk yang belum lolos →</button></p>` : ""}
      ${meta.notes.length ? `<p><b>Catatan data</b></p><ul>${meta.notes.map((n) => `<li>${esc(n)}</li>`).join("")}</ul>` : ""}
    </details>`;

  el.classList.add("open");
  if (resetScroll) el.scrollTop = 0;
  const trend = document.getElementById("d-trend");
  if (trend && periodId) renderTrend(trend, p, meta, periodId, (id) => void setPeriod(id));
  const rain = document.getElementById("d-rain");
  if (rain && kw && weather) renderRain(rain, kw, weather.dry_dasarian_mm, weather.today);
  const sc = document.getElementById("d-scen");
  if (sc && scenario) renderScenarioCurve(sc, p.id, p.name, scenario, scenN, setScenario);
  $("#d-close").onclick = closeDetail;
  bindForecastCard(p);
  const scOn = document.getElementById("d-scen-on");
  if (scOn) scOn.onclick = () => setScenario(3);
  const adv = document.getElementById("d-advance") as HTMLButtonElement | null;
  if (adv) adv.onclick = () => act(adv, "d-wf-err", () => advance(p.id, actor!));
  const rst = document.getElementById("d-reset") as HTMLButtonElement | null;
  if (rst) rst.onclick = () => act(rst, "d-wf-err", () => resetStep(p.id, actor!));
  const ver = document.getElementById("d-verify");
  if (ver) ver.onclick = () => {
    const f = $("#d-fb") as HTMLFormElement;
    f.classList.add("ask-puso");
    f.querySelectorAll<HTMLInputElement>("input[name=fb]").forEach((i) => (i.checked = false));
    f.scrollIntoView({ behavior: "smooth", block: "center" });
  };
  const who = document.getElementById("d-who");
  if (who) who.onclick = () => openWho();
  $("#d-copy").onclick = async (ev) => {
    const b = ev.currentTarget as HTMLButtonElement;
    try {
      await navigator.clipboard.writeText(msg);
      b.textContent = "Tersalin ✓";
    } catch {
      b.textContent = "Salin manual dari kotak di atas";
    }
    setTimeout(() => (b.textContent = "Salin pesan"), 2000);
  };
  ($("#d-fb") as HTMLFormElement).onsubmit = (ev) => {
    ev.preventDefault();
    if (!actor) return openWho();
    const form = ev.target as HTMLFormElement;
    const fd = new FormData(form);
    void act(form.querySelector("button")!, "d-fb-err", () =>
      addReport(p.id, String(fd.get("fb")), String(fd.get("note") || "").trim(), String(fd.get("desa") || "") || null, actor!));
  };
}

function bindForecastCard(p: KecProps) {
  document.querySelectorAll<HTMLElement>(".fc-rows li[data-fc]").forEach((li) =>
    (li.onclick = () => setForecastStep(li.dataset.fc!)));
  const about = document.getElementById("fc-about");
  if (about) about.onclick = openModelPage;
  const send = (verdict: "accept" | "reject") => async (ev: Event) => {
    const note = (document.getElementById("fc-note") as HTMLInputElement | null)?.value.trim() ?? "";
    await act(ev.currentTarget as HTMLElement, "fc-err", async () => {
      const r = await reviewForecast(p.id, forecast!.generated_at, verdict, note, actor!);
      reviews[p.id] = r;
    });
  };
  const ok = document.getElementById("fc-accept"), no = document.getElementById("fc-reject");
  if (ok) ok.onclick = send("accept");
  if (no) no.onclick = send("reject");
}

// ---------------------------------------------------------------- Dinas cockpit (v2 Phase 4.3)
function openCockpit() {
  const cur = curPeriodId();
  const ps = meta.periods ?? [];
  const i = ps.findIndex((x) => x.id === cur);
  const prev = i > 0 ? ps[i - 1] : null;
  const curMeta = { ...meta, totals: ps[i]?.totals ?? meta.totals };
  const dlg = $("#cockpit-dlg") as HTMLDialogElement;
  const draw = () => {
    dlg.innerHTML = cockpitHtml({
      meta: curMeta,
      kec: feats.map((f) => ({ ...f.properties, ...f.properties.series?.[cur] })),
      prevStressedHa: prev ? (prev.totals.class_ha["4"] ?? 0) + (prev.totals.class_ha["5"] ?? 0) : null,
      prevLabel: prev ? shortLabel(prev) : null,
      forecast: forecast && meta.periods?.length ? forecast : null,
      periodLabel: curPeriodLabel(),
    });
    dlg.querySelectorAll<HTMLTableRowElement>("tr[data-kec]").forEach((tr) => (tr.onclick = () => {
      dlg.close();
      openDetail(tr.dataset.kec!, true);
    }));
  };
  draw();
  dlg.showModal();
}

function openVerification() {
  if (!verification) return;
  const dlg = $("#verify-dlg") as HTMLDialogElement;
  dlg.innerHTML = verificationPage(verification);
  for (const d of document.querySelectorAll<HTMLDialogElement>("dialog[open]")) if (d !== dlg) d.close();
  dlg.showModal();
  dlg.scrollTop = 0;
}

function openModelPage() {
  if (!forecast) return;
  const dlg = $("#model-dlg") as HTMLDialogElement;
  dlg.innerHTML = modelPage(forecast);
  dlg.showModal();
  dlg.scrollTop = 0;
}

// ---------------------------------------------------------------- workflow (Stage 3)

function curPeriodLabel() {
  const id = meta.current_period;
  return (id && meta.periods?.find((x) => x.id === id)?.label) || meta.period.label;
}


function rerender() {
  renderRanking();
  const f = selected ? feats.find((x) => x.properties.id === selected) : null;
  if (f) renderDetail(f.properties, false);
}

/** Run a workflow write, then redraw; errors (e.g. someone else was faster) shown inline. */
async function act(btn: HTMLElement, errId: string, fn: () => Promise<unknown>) {
  (btn as HTMLButtonElement).disabled = true;
  try {
    await fn();
    rerender();
  } catch (e) {
    rerender(); // a 409 has already pulled the newer state
    const el = document.getElementById(errId);
    if (el) {
      el.textContent = `Gagal: ${(e as Error).message}.${e instanceof ApiError && e.status === 409 ? " Tampilan sudah diperbarui." : ""}`;
      el.hidden = false;
    }
  }
}

function renderWho() {
  const m = getMode();
  $("#who").innerHTML = `
    <button class="who-btn" title="${m === "server" ? "Tersambung ke server: alur tindakan dan laporan dipakai bersama" : "Server tidak terhubung: data hanya di peramban ini"}">
      <i class="dot ${m}"></i>${actor ? `${esc(actor.name)} <span>${ROLE_LABEL[actor.role]}</span>` : "Masuk"}
    </button>`;
  $("#who").querySelector("button")!.onclick = () => openWho();
}

function ago(iso: string | null) {
  if (!iso) return "belum pernah";
  const h = (Date.now() - new Date(iso).getTime()) / 3.6e6;
  return h < 1 ? `${Math.max(1, Math.round(h * 60))} menit lalu` : h < 48 ? `${Math.round(h)} jam lalu` : `${Math.round(h / 24)} hari lalu`;
}

function statusHtml() {
  if (getMode() !== "server") return `<p class="fine">Server tidak terhubung. Jalankan <code>uvicorn server.app:app</code> agar alur tindakan dan laporan dipakai bersama.</p>`;
  if (!status) return `<p class="fine">Memuat status data…</p>`;
  const rows = Object.entries(status.jobs).map(([id, j]) => {
    const last = j.last;
    const state = j.running ? "sedang berjalan…" : !j.enabled ? "nonaktif di server" : last?.status === "failed" ? `gagal ${ago(last.started_at)}` : `berhasil ${ago(j.last_ok)}`;
    return `<li><b>${esc(j.label)}</b><span class="${last?.status === "failed" ? "warn" : ""}">${state}</span>
      <small>${j.enabled ? `otomatis tiap ${j.interval_h >= 24 ? `${j.interval_h / 24} hari` : `${j.interval_h} jam`}` : ""}</small>
      ${actor?.role === "dinas" && j.enabled ? `<button class="ghost" data-job="${id}" ${j.running || Object.values(status!.jobs).some((x) => x.running) ? "disabled" : ""}>Perbarui sekarang</button>` : ""}</li>`;
  });
  return `<ul class="jobs">${rows.join("")}</ul>
    <p class="fine">Citra: ${status.data.meta ? when(status.data.meta) : "-"} · hujan: ${status.data.weather ? when(status.data.weather) : "-"}${status.scheduler ? "" : " · penjadwal mati"}</p>`;
}

function openWho() {
  const dlg = $("#who-dlg") as HTMLDialogElement;
  const draw = () => {
    dlg.innerHTML = `
      <form method="dialog" id="who-form">
        <h3>Identitas pengguna</h3>
        <p class="fine">Nama dan peran dicatat pada setiap tindakan dan laporan. Prototipe: belum ada kata sandi.</p>
        <label>Nama <input name="name" required minlength="2" maxlength="60" value="${esc(actor?.name ?? "")}" autocomplete="name"></label>
        <div class="roles">${(["penyuluh", "dinas"] as Role[]).map((r) => `<label class="radio"><input type="radio" name="role" value="${r}" ${(actor?.role ?? "penyuluh") === r ? "checked" : ""}> ${ROLE_LABEL[r]}<small>${r === "penyuluh" ? "mengusulkan, mengirim pesan, melapor" : "menyetujui dan membatalkan tindakan"}</small></label>`).join("")}</div>
        <div class="row"><button class="primary" value="save">Simpan</button>${actor ? `<button class="ghost" value="out" formnovalidate>Keluar</button>` : ""}<button class="ghost" value="cancel" formnovalidate>Tutup</button></div>
        <h3>Pembaruan data</h3>
        <div id="who-status">${statusHtml()}</div>
      </form>`;
    bindJobs();
  };
  const drawStatus = () => {
    const el = dlg.querySelector("#who-status");
    if (el) el.innerHTML = statusHtml();
    bindJobs();
  };
  const bindJobs = () => {
    dlg.querySelectorAll<HTMLButtonElement>("[data-job]").forEach((b) => (b.onclick = async (ev) => {
      ev.preventDefault();
      b.disabled = true;
      try {
        await requestRefresh(b.dataset.job as "weather" | "full", actor!);
        await pollStatus();
      } catch (e) {
        b.textContent = `Gagal: ${(e as Error).message}`;
        return;
      }
      drawStatus();
    }));
  };
  draw();
  dlg.onclose = () => {
    const v = dlg.returnValue;
    if (v === "save") {
      const fd = new FormData(dlg.querySelector("form")!);
      actor = { name: String(fd.get("name")).trim(), role: String(fd.get("role")) as Role };
      setActor(actor);
    } else if (v === "out") {
      actor = null;
      setActor(null);
    }
    renderWho();
    rerender();
  };
  dlg.showModal();
  void pollStatus().then(() => dlg.open && drawStatus());
  // Follow a running refresh until it finishes
  const t = setInterval(async () => {
    if (!dlg.open) return clearInterval(t);
    if (status && Object.values(status.jobs).some((j) => j.running)) { await pollStatus(); if (dlg.open) drawStatus(); }
  }, 3000);
}

async function pollStatus() {
  if (getMode() !== "server") return;
  try {
    status = await serverStatus();
  } catch {
    return;
  }
  // The pipeline wrote new files since this page loaded
  const fresh = status.data.meta !== meta.generated_at || (weather && status.data.weather !== weather.generated_at)
    || (forecast && status.data.forecast && status.data.forecast !== forecast.generated_at);
  $("#update").hidden = !fresh;
}

function startSync() {
  if (getMode() !== "server") return;
  $("#update").querySelector("button")!.onclick = () => location.reload();
  void pollStatus();
  setInterval(async () => {
    if (document.hidden) return;
    try {
      // Do not redraw under someone typing a report
      const changed = await sync();
      let revChanged = false;
      if (forecast) {
        const r = await getReviews(forecast.generated_at);
        revChanged = JSON.stringify(r) !== JSON.stringify(reviews);
        reviews = r;
      }
      if ((changed || revChanged) && !document.activeElement?.closest("#d-fb, .fc-act, dialog")) rerender();
    } catch { /* server went away; keep the last state */ }
  }, 15000);
  setInterval(() => { if (!document.hidden) void pollStatus(); }, 60000);
}

// Ages tick on even without a server
function startFreshClock() {
  setInterval(() => { if (!document.hidden) renderFresh($("#fresh"), freshness(meta, weather, forecast)); }, 60000);
}

// ---------------------------------------------------------------- layer bar
const renderLegend = (id: string) => drawLegend($("#legend"), id, meta, anomaly, periodId);
function renderLayerbar() {
  const layers = [{ id: "status", label: "Status wilayah" }, ...meta.layers,
    ...(anomaly ? [{ id: "anomaly", label: "Anomali vs biasanya" }] : [])];
  $("#layers").innerHTML = layers
    .map((l, i) => `<button data-layer="${l.id}" class="${i === 0 ? "on" : ""}">${l.label}</button>`)
    .join("");
  $("#layers").querySelectorAll("button").forEach((b) =>
    b.addEventListener("click", async () => {
      $("#layers").querySelectorAll("button").forEach((x) => x.classList.toggle("on", x === b));
      layerId = b.dataset.layer!;
      renderLegend(layerId);
      $("#opacity-wrap").hidden = layerId === "status" || layerId === "anomaly";
      if (layerId === "anomaly") api.setDesaValues(anomalyZ());
      await api.setLayer(layerId);
    }),
  );
  ($("#opacity") as HTMLInputElement).oninput = (ev) =>
    api.setOpacity(Number((ev.target as HTMLInputElement).value) / 100);
  renderLegend("status");
}


document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && selected) closeDetail();
  const typing = e.target instanceof Element && e.target.closest("input, textarea, select");
  if (!typing && (e.key === "ArrowLeft" || e.key === "ArrowRight") && periodId) {
    e.preventDefault();
    stepPeriod(e.key === "ArrowRight" ? 1 : -1);
  }
});

boot().catch((err) => {
  console.error(err);
  $("#loading").textContent = "Gagal memuat data. Jalankan pipeline/make_placeholder.py terlebih dahulu.";
});
