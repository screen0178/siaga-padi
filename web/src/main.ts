import "./style.css";
import { createMap, type MapApi } from "./map";
import { composeMessage } from "./message";
import { renderStrip, renderTrend, shortLabel } from "./timeline";
import { STAGE_COLOR, STATUS_COLOR, type KecFeature, type KecProps, type Meta, type Feedback, type Scenario, type Weather } from "./types";
import { renderRain, renderScenarioCurve } from "./weather";
import {
  FEEDBACK, ROLE_LABEL, STEPS, addReport, advance, canReset, canStep, feedbackLabel, getActor, getMode, getReports,
  ApiError, getState, initStore, requestRefresh, resetStep, serverStatus, setActor, stepLabel, sync,
  type Actor, type Role, type ServerStatus,
} from "./workflow";

const DATA = "./data";
const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector(sel) as T;
const fmt = (n: number | null | undefined, d = 0) =>
  n == null ? "-" : n.toLocaleString("id-ID", { maximumFractionDigits: d, minimumFractionDigits: d });
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

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

/** Optional data file: null when missing or malformed. */
const optional = <T,>(file: string) =>
  fetch(`${DATA}/${file}`).then((r) => (r.ok ? (r.json() as Promise<T>) : null)).catch(() => null);

async function boot() {
  const [m, kec, desa, w, sc, f] = await Promise.all([
    fetch(`${DATA}/meta.json`).then((r) => r.json()),
    fetch(`${DATA}/kecamatan.json`).then((r) => r.json()),
    fetch(`${DATA}/desa.json`).then((r) => r.json()),
    optional<Weather>("weather.json"),
    optional<Scenario>("scenario.json"),
    optional<Feedback>("feedback.json"),
  ]);
  fb = f;
  meta = m;
  weather = w;
  // A scenario only makes sense for the period it was computed from
  scenario = sc && meta.periods?.some((p) => p.id === sc.period_id) ? sc : null;
  feats = (kec.features as KecFeature[]).slice().sort((a, b) => a.properties.rank - b.properties.rank);
  for (const f of desa.features as { properties: { id: string; name: string; kec_id: string } }[])
    (desaByKec[f.properties.kec_id] ??= []).push({ id: f.properties.id, name: f.properties.name });
  Object.values(desaByKec).forEach((l) => l.sort((a, b) => a.name.localeCompare(b.name)));
  // Action log stays tied to the run's current month, not the month being viewed
  await initStore(meta.current_period ?? meta.period.start.slice(0, 7));
  if (meta.periods?.length) {
    periodId = meta.current_period ?? meta.periods[meta.periods.length - 1].id;
    document.body.classList.add("has-periods");
  }

  renderTopbar();
  renderScenarioControl();
  renderRanking();
  renderLayerbar();
  renderTimeline();

  api = await createMap($("#map"), meta, kec, desa, DATA);
  api.onSelect((id) => openDetail(id, false));
  $("#loading").remove();
  renderWho();
  startSync();

  const hash = location.hash.slice(1);
  const fromHash = feats.find((f) => slug(f.properties.name) === hash);
  if (fromHash) openDetail(fromHash.properties.id, true);
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-");

// ---------------------------------------------------------------- periods
async function setPeriod(id: string) {
  const p = meta.periods?.find((x) => x.id === id);
  if (!p || id === periodId) return;
  periodId = id;
  scenN = 0; // the what-if belongs to one period; leaving it shows observed data
  document.body.classList.remove("scen-on");
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
  renderStrip(el, meta, periodId, (id) => void setPeriod(id), togglePlay, playTimer != null);
}

// ---------------------------------------------------------------- what-if
const BULAN3 = ["Jan", "Feb", "Mar", "Apr", "Mei", "Jun", "Jul", "Agu", "Sep", "Okt", "Nov", "Des"];
const monthName = (id: string) => BULAN3[Number(id.slice(5, 7)) - 1] ?? id;
/** Observed values of the scenario's period (props are mutated in place). */
const observed = (p: KecProps): KecProps => ({ ...p, ...(scenario ? p.series?.[scenario.period_id] : undefined) });

function setScenario(n: number) {
  if (!scenario || periodId !== scenario.period_id) return;
  scenN = Math.max(0, Math.min(scenario.max_dasarian, n));
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

function renderScenarioControl() {
  const el = $("#scenario");
  if (!scenario) { el.hidden = true; return; }
  el.hidden = false;
  const live = periodId === scenario.period_id;
  const period = meta.periods!.find((p) => p.id === scenario!.period_id)!;
  const max = scenario.max_dasarian;
  const months = scenario.calibration.months.map((m) => monthName(m.pair.split(">")[1]));
  const t0 = scenario.totals["0"], tn = scenario.totals[String(scenN)];
  const st = (t: { class_ha: Record<string, number> }) => (t.class_ha["4"] ?? 0) + (t.class_ha["5"] ?? 0);
  const fcVals = weather ? Object.values(weather.kecamatan).map((k) => k.fc_mm).sort((a, b) => a - b) : [];
  const fcMed = fcVals.length ? fcVals[Math.floor(fcVals.length / 2)] : null;
  const fcDays = weather ? Object.values(weather.kecamatan)[0]?.fc_days : 0;
  el.innerHTML = `
    <div class="scen-h"><b>Bagaimana jika tidak hujan?</b>
      <span class="scen-v">${scenN === 0 ? "kondisi teramati" : `${scenN} dasarian (±${scenN * 10} hari)`}</span></div>
    <input id="scen-range" type="range" min="0" max="${max}" step="1" value="${scenN}" ${live ? "" : "disabled"}
      aria-label="Jumlah dasarian tanpa hujan" aria-valuetext="${scenN} dasarian" />
    <div class="scen-ticks">${Array.from({ length: max / 3 + 1 }, (_, k) => `<span>${k === 0 ? "0" : `${k} bln`}</span>`).join("")}</div>
    ${!live ? `<p class="fine">Skenario hanya untuk periode terbaru (${period.label.split(" (")[0]}).</p>`
      : scenN > 0 ? `<p class="scen-eff">Cekaman kuat–ekstrem <b>${fmt(st(t0))} → ${fmt(st(tn))} ha</b> · ha berisiko ${fmt(t0.ha_at_risk)} → ${fmt(tn.ha_at_risk)}</p>
        <p class="fine">Skenario uji, bukan prakiraan${fcMed != null ? `: prakiraan ${fcDays} hari ke depan justru ±${fmt(fcMed)} mm (median kecamatan)` : ""}. Laju pengeringan diulang dari bulan kering 2026 (${months.join(", ")}); fase tumbuh dan luas dianggap tetap. Peta raster tetap citra terakhir.</p>`
      : `<p class="fine">Geser untuk melihat status dan peringkat jika hujan berhenti, memakai laju pengeringan musim kering 2026.</p>`}`;
  const r = el.querySelector<HTMLInputElement>("#scen-range")!;
  r.oninput = () => setScenario(Number(r.value));
}

/** Change in ha-at-risk versus the previous period, for the ranking list. */
function deltaHtml(p: KecProps) {
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
  const inactive = cs && ("6" in cs || "7" in cs || "8" in cs) ? (cs["6"] ?? 0) + (cs["7"] ?? 0) + (cs["8"] ?? 0) : null;
  const count = (s: string) => feats.filter((f) => f.properties.status === s).length;
  $("#region").innerHTML = `${esc(meta.region.name)} · ${esc(meta.period.label)}${scenN > 0 ? ` <span class="scen-tag">Skenario: tanpa hujan ${scenN} dasarian</span>` : ""}`;
  $("#summary").innerHTML = `
    <div class="chip"><span class="k">Padi aktif</span><span class="v">${fmt(meta.totals.active_ha)} ha</span></div>
    <div class="chip"><span class="k">Cekaman kuat–ekstrem</span><span class="v" style="color:#ff8a7a">${fmt(stressed)} ha</span></div>
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
          <div class="r-meta"><span><b>${fmt(p.ha_at_risk)}</b> ha berisiko ${deltaHtml(p)}</span>
            <span class="r-step ${st.step}">${stepLabel}</span></div>
          ${p.action ? `<div class="r-act">${esc(p.action.headline)}</div>` : ""}
        </div>
      </li>`;
    })
    .join("");
  $("#rank-list").querySelectorAll("li").forEach((li) =>
    li.addEventListener("click", () => openDetail(li.dataset.id!, true)),
  );
}

// ---------------------------------------------------------------- detail
/** Sawah not counted as active rice (series mode): fallow and harvested. */
function inactiveSection(p: KecProps) {
  const cs = p.cropland_stage_ha;
  if (!cs || !("6" in cs || "7" in cs || "8" in cs)) return "";
  const rows = meta.stage_classes.filter((s) => s.id >= 6 && (s.id !== 8 || (cs["8"] ?? 0) > 0));
  const ex = fb?.excluded_desa.filter((e) => e.kec_id === p.id) ?? [];
  return `
    <section>
      <h3>Sawah tidak dihitung aktif</h3>
      <ul class="legend-rows">${rows
        .map((s) => `<li><i style="--c:${STAGE_COLOR[String(s.id)]}"></i>${s.label}<span>${fmt(cs[String(s.id)] ?? 0)} ha</span></li>`)
        .join("")}</ul>
      <p class="fine">Dari lintasan NDVI 4 bulan: <b>bera</b> = tidak pernah hijau, <b>panen</b> = sudah turun ke tanah terbuka setelah puncak. Bera bisa juga padi yang gagal tumbuh karena kering: mohon cek lapangan dan kirim laporan di bawah.</p>
      ${ex.length ? `<p class="fine"><b>Bukan padi (laporan lapangan)</b>: ${ex.map((e) => `${esc(e.name)} (${e.not_rice} dari ${e.reports} laporan)`).join(", ")}. Lahan pertanian di desa ini tidak dihitung sebagai padi aktif pada semua bulan.</p>` : ""}
    </section>`;
}

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
  // Messages to farmers always use observed data, never the what-if
  const msg = composeMessage(scenN > 0 ? observed(p) : p, meta, kw);
  const obs = scenN > 0 ? observed(p) : null;
  const totalClass = Object.values(p.class_ha).reduce((a, b) => a + b, 0) || 1;
  const reps = getReports(p.id);

  el.innerHTML = `
    <header>
      <div>
        <div class="d-kicker">Kecamatan · peringkat ${p.rank} dari ${feats.length}${obs ? ` · skenario ${scenN} dasarian tanpa hujan` : ""}</div>
        <h2>${esc(p.name)}</h2>
      </div>
      <button class="icon" id="d-close" aria-label="Tutup">✕</button>
    </header>
    <div class="d-status" style="--c:${STATUS_COLOR[p.status]}">
      <span class="dot"></span><b>${p.status}</b>
      <span class="d-why">indeks bahaya H = ${fmt(p.hazard_index, 2)}${obs ? ` · teramati ${obs.status} (${fmt(obs.hazard_index, 2)})` : ""}</span>
    </div>

    <div class="kpis">
      <div><span>NDDI rata-rata${obs ? " (teramati)" : ""}</span><b>${fmt(p.mean_nddi, 2)}</b></div>
      <div><span>Padi aktif</span><b>${fmt(p.active_ha)} <small>ha</small></b></div>
      <div><span>Berisiko (terbobot)</span><b>${fmt(p.ha_at_risk)} <small>ha${obs ? ` · teramati ${fmt(obs.ha_at_risk)}` : ""}</small></b></div>
      <div><span>NDVI / NDMI</span><b>${fmt(p.mean_ndvi, 2)} / ${fmt(p.mean_ndmi, 2)}</b></div>
    </div>

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
    </section>` : ""}

    <section>
      <h3>Sebaran kelas kekeringan</h3>
      ${classBar(p)}
      <ul class="legend-rows">${meta.nddi_classes
        .map((c) => `<li><i style="--c:${c.color}"></i>${c.label}<span>${fmt(p.class_ha[String(c.id)] ?? 0)} ha · ${fmt((100 * (p.class_ha[String(c.id)] ?? 0)) / totalClass)}%</span></li>`)
        .join("")}</ul>
    </section>

    ${inactiveSection(p)}

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
        ${FEEDBACK.map((o, i) => `<label class="radio"><input type="radio" name="fb" value="${o.id}" ${i === 0 ? "checked" : ""}> ${o.label}</label>`).join("")}
        <select name="desa"><option value="">Desa (opsional)</option>${(desaByKec[p.id] ?? []).map((d) => `<option value="${d.id}">${esc(d.name)}</option>`).join("")}</select>
        <input type="text" name="note" maxlength="1000" placeholder="Catatan (opsional): blok, komoditas, foto…" />
        <button class="ghost" type="submit">${actor ? "Kirim laporan" : "Masuk lalu kirim laporan"}</button>
        <p class="wf-err" id="d-fb-err" hidden></p>
      </form>
      <ul class="log">${reps
        .map((r) => `<li><time>${when(r.created_at)}</time> 📍 ${esc(feedbackLabel(r.answer))}${r.desa_name ? ` · ${esc(r.desa_name)}` : ""}${r.actor ? ` <span class="who-tag">${esc(r.actor)}</span>` : ""}${r.note ? ` <em>${esc(r.note)}</em>` : ""}${reportCheck(r)}</li>`)
        .join("") || `<li class="muted">Belum ada laporan.</li>`}</ul>
      <p class="fine">${getMode() === "server"
        ? "Laporan tersimpan di server dan terlihat oleh semua pengguna. Jawaban \"Bukan padi\" dan \"Sudah panen / bera\" dipakai untuk mengoreksi masker padi dan ambang lintasan NDVI."
        : "Server tidak terhubung: laporan dan alur tindakan hanya tersimpan di peramban ini."}</p>
    </section>

    <details class="fine">
      <summary>Bagaimana status dihitung?</summary>
      <p>H = rata-rata bobot bahaya kelas NDDI pada padi aktif (Normal 0, Ringan 0,1, Sedang 0,5, Kuat 0,85, Ekstrem 1). Status: H &lt; 0,40 Normal, &lt; 0,60 Waspada, &lt; 0,75 Siaga, selebihnya Awas. Peringkat memakai ha berisiko = luas × bobot bahaya × kerentanan fase (reproduktif 1,0; vegetatif akhir 0,7; vegetatif awal 0,5). Bobot bersifat provisional, mengikuti logika indeks H-MHEWS, dan dikalibrasi dengan laporan lapangan.</p>
      ${scenario ? `<p><b>Skenario tanpa hujan</b></p><p>Distribusi NDDI tiap kecamatan digeser mengikuti perubahan persentil NDDI padi aktif pada bulan kering 2026 (${scenario.calibration.months.map((m) => `${m.pair.split(">").map(monthName).join("→")}, hujan ${fmt(m.rain_mm)} mm`).join("; ")}), lalu dinilai ulang dengan aturan yang sama. Uji balik per kecamatan: galat rata-rata ${scenario.calibration.months.map((m) => `${fmt(m.kec_mae_ha)} ha`).join(" / ")} vs ${scenario.calibration.months.map((m) => `${fmt(m.persist_mae_ha)} ha`).join(" / ")} bila diasumsikan tidak berubah. Fase tumbuh, luas padi aktif, dan irigasi dianggap tetap.</p>` : ""}
      ${feedbackExplainer()}
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
  const adv = document.getElementById("d-advance") as HTMLButtonElement | null;
  if (adv) adv.onclick = () => act(adv, "d-wf-err", () => advance(p.id, actor!));
  const rst = document.getElementById("d-reset") as HTMLButtonElement | null;
  if (rst) rst.onclick = () => act(rst, "d-wf-err", () => resetStep(p.id, actor!));
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

// ---------------------------------------------------------------- workflow (Stage 3)
const when = (iso: string) => new Date(iso).toLocaleString("id-ID", { dateStyle: "short", timeStyle: "short" });

function curPeriodLabel() {
  const id = meta.current_period;
  return (id && meta.periods?.find((x) => x.id === id)?.label) || meta.period.label;
}

function reportSummary(reps: ReturnType<typeof getReports>) {
  if (!reps.length) return "";
  const n: Record<string, number> = {};
  reps.forEach((r) => (n[r.answer] = (n[r.answer] ?? 0) + 1));
  const parts = FEEDBACK.filter((f) => n[f.id]).map((f) => `${n[f.id]} ${f.label.split(":")[0].split(" (")[0].toLowerCase()}`);
  const wrong = (n.not_rice ?? 0) + (n.harvested ?? 0) + (n.irrigated ?? 0);
  // Only flag doubt once a few independent checks agree
  return `<p class="rep-sum"><b>${reps.length} laporan</b>: ${parts.join(", ")}.${reps.length >= 3 && wrong / reps.length >= 0.5 ? ` <span class="warn">Sebagian besar laporan tidak membenarkan cekaman; status peta di sini perlu diragukan.</span>` : ""}</p>`;
}

/** How the last pipeline run judged one report against the map. */
function reportCheck(r: ReturnType<typeof getReports>[number]) {
  if (!fb || r.id == null) return "";
  const c = fb.check.reports.find((x) => x.id === r.id);
  if (!c) {
    return new Date(r.created_at) > new Date(fb.generated_at)
      ? ` <span class="chk wait" title="Dipakai pada pembaruan citra berikutnya">menunggu pembaruan data</span>` : "";
  }
  const m = c.map;
  const pct = (v: number | null) => (v == null ? "-" : `${Math.round(v * 100)}%`);
  const said = m.active_ha < 1
    ? `Peta ${c.period_id}: tidak ada padi aktif${m.excluded_ha ? ` (${fmt(m.excluded_ha)} ha dikoreksi bukan padi)` : ""}`
    : `Peta ${c.period_id}: cekaman kuat+ ${pct(m.stressed_share)} padi aktif, bera/panen ${pct(m.inactive_share)} sawah${m.excluded_ha ? `, ${fmt(m.excluded_ha)} ha dikoreksi bukan padi` : ""}`;
  if (c.agrees === null) return ` <span class="chk" title="${said}">tidak dapat dinilai</span>`;
  return c.agrees
    ? ` <span class="chk ok" title="${said}">✓ peta sesuai</span>`
    : ` <span class="chk no" title="${said}">✗ peta berbeda</span>`;
}

function feedbackExplainer() {
  if (!fb || !fb.n_reports) return "";
  const rows = Object.values(fb.check.summary).filter((v) => v.n);
  return `<p><b>Laporan lapangan dalam pipeline</b></p>
    <p>Pembaruan citra terakhir (${when(fb.generated_at)}) membaca ${fb.n_reports} laporan. Desa dengan ≥ ${fb.rules.exclude_min_reports} laporan "bukan padi" yang menjadi mayoritas laporannya dikeluarkan dari padi aktif (${fb.excluded_desa.length} desa). Setiap laporan juga dibandingkan dengan peta bulan itu:</p>
    <ul>${rows.map((v) => `<li>${esc(v.label)}: peta sesuai ${v.agree} dari ${v.judged}${v.n > v.judged ? ` (${v.n - v.judged} tidak dapat dinilai)` : ""}</li>`).join("")}</ul>
    <p>"Sudah panen / bera" yang sering berbeda dengan peta berarti ambang lintasan NDVI perlu disetel.</p>`;
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
  const fresh = status.data.meta !== meta.generated_at || (weather && status.data.weather !== weather.generated_at);
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
      if ((await sync()) && !document.activeElement?.closest("#d-fb, dialog")) rerender();
    } catch { /* server went away; keep the last state */ }
  }, 15000);
  setInterval(() => { if (!document.hidden) void pollStatus(); }, 60000);
}

// ---------------------------------------------------------------- layer bar
function renderLayerbar() {
  const layers = [{ id: "status", label: "Status wilayah" }, ...meta.layers];
  $("#layers").innerHTML = layers
    .map((l, i) => `<button data-layer="${l.id}" class="${i === 0 ? "on" : ""}">${l.label}</button>`)
    .join("");
  $("#layers").querySelectorAll("button").forEach((b) =>
    b.addEventListener("click", async () => {
      $("#layers").querySelectorAll("button").forEach((x) => x.classList.toggle("on", x === b));
      renderLegend(b.dataset.layer!);
      $("#opacity-wrap").hidden = b.dataset.layer === "status";
      await api.setLayer(b.dataset.layer!);
    }),
  );
  ($("#opacity") as HTMLInputElement).oninput = (ev) =>
    api.setOpacity(Number((ev.target as HTMLInputElement).value) / 100);
  renderLegend("status");
}

const RAMPS: Record<string, { stops: [number, string][]; label: string }> = {
  nddi_ramp: { label: "NDDI", stops: [[-1, "#2b83ba"], [0.7, "#abdda4"], [1.25, "#fdae61"], [3, "#e8553d"], [4, "#8b0a1a"]] },
  ndvi_ramp: { label: "NDVI", stops: [[0, "#8c5a2b"], [0.25, "#d9c36a"], [0.45, "#8fcf5a"], [0.7, "#1a7f37"]] },
  ndmi_ramp: { label: "NDMI", stops: [[-0.8, "#8c3b1a"], [-0.3, "#e0a050"], [0, "#f2efc7"], [0.3, "#5bb0d9"], [0.6, "#1f4e9c"]] },
};

function renderLegend(layerId: string) {
  const el = $("#legend");
  if (layerId === "status") {
    el.innerHTML = meta.status_levels
      .map((s) => `<span class="sw"><i style="--c:${STATUS_COLOR[s]}"></i>${s}</span>`)
      .join("");
    return;
  }
  const def = meta.layers.find((l) => l.id === layerId)!;
  if (def.legend === "nddi_classes") {
    el.innerHTML = meta.nddi_classes
      .map((c) => `<span class="sw"><i style="--c:${c.color}"></i>${c.label}</span>`)
      .join("");
  } else if (def.legend === "stage_classes") {
    el.innerHTML = meta.stage_classes
      // Series mode has no single-date ripening class (5); harvest (7) replaces it
      .filter((s) => s.id >= 2 && !(s.id === 5 && meta.stage_classes.some((c) => c.id === 7)))
      .map((s) => `<span class="sw"><i style="--c:${STAGE_COLOR[String(s.id)]}"></i>${s.label}${s.active ? "" : " <em>(dikecualikan)</em>"}</span>`)
      .join("");
  } else {
    const r = RAMPS[def.legend];
    const lo = r.stops[0][0], hi = r.stops[r.stops.length - 1][0];
    const grad = r.stops.map(([v, c]) => `${c} ${(100 * (v - lo)) / (hi - lo)}%`).join(",");
    el.innerHTML = `<span class="ramp-l">${r.label}</span><span class="ramp" style="background:linear-gradient(90deg,${grad})">${r.stops
      .map(([v]) => `<em style="left:${(100 * (v - lo)) / (hi - lo)}%">${v}</em>`)
      .join("")}</span>`;
  }
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
