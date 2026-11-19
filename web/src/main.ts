import "./style.css";
import { createMap, type MapApi } from "./map";
import { composeMessage } from "./message";
import { STAGE_COLOR, STATUS_COLOR, type KecFeature, type KecProps, type Meta } from "./types";
import { FEEDBACK, STEPS, addFeedback, advance, getState, initStore, resetStep } from "./workflow";

const DATA = "./data";
const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector(sel) as T;
const fmt = (n: number | null | undefined, d = 0) =>
  n == null ? "-" : n.toLocaleString("id-ID", { maximumFractionDigits: d, minimumFractionDigits: d });
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

let meta: Meta;
let feats: KecFeature[];
let api: MapApi;
let selected: string | null = null;

async function boot() {
  const [m, kec, desa] = await Promise.all([
    fetch(`${DATA}/meta.json`).then((r) => r.json()),
    fetch(`${DATA}/kecamatan.json`).then((r) => r.json()),
    fetch(`${DATA}/desa.json`).then((r) => r.json()),
  ]);
  meta = m;
  feats = (kec.features as KecFeature[]).slice().sort((a, b) => a.properties.rank - b.properties.rank);
  initStore(`${meta.region.id}:${meta.period.start}`);

  renderTopbar();
  renderRanking();
  renderLayerbar();

  api = await createMap($("#map"), meta, kec, desa, DATA);
  api.onSelect((id) => openDetail(id, false));
  $("#loading").remove();

  const hash = location.hash.slice(1);
  const fromHash = feats.find((f) => slug(f.properties.name) === hash);
  if (fromHash) openDetail(fromHash.properties.id, true);
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-");

// ---------------------------------------------------------------- top bar
function renderTopbar() {
  const t = meta.totals.class_ha;
  const stressed = (t["4"] ?? 0) + (t["5"] ?? 0);
  const count = (s: string) => feats.filter((f) => f.properties.status === s).length;
  $("#region").textContent = `${meta.region.name} · ${meta.period.label}`;
  $("#summary").innerHTML = `
    <div class="chip"><span class="k">Padi aktif</span><span class="v">${fmt(meta.totals.active_ha)} ha</span></div>
    <div class="chip"><span class="k">Cekaman kuat–ekstrem</span><span class="v" style="color:#ff8a7a">${fmt(stressed)} ha</span></div>
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
          <div class="r-meta"><span><b>${fmt(p.ha_at_risk)}</b> ha berisiko</span>
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

function renderDetail(p: KecProps) {
  const el = $("#detail");
  const st = getState(p.id);
  const stepIdx = STEPS.findIndex((s) => s.id === st.step);
  const next = STEPS[stepIdx + 1];
  const stressed = p.stressed_stage_ha;
  const stressedTotal = Object.values(stressed).reduce((a, b) => a + b, 0) || 1;
  const msg = composeMessage(p, meta);
  const totalClass = Object.values(p.class_ha).reduce((a, b) => a + b, 0) || 1;

  el.innerHTML = `
    <header>
      <div>
        <div class="d-kicker">Kecamatan · peringkat ${p.rank} dari ${feats.length}</div>
        <h2>${esc(p.name)}</h2>
      </div>
      <button class="icon" id="d-close" aria-label="Tutup">✕</button>
    </header>
    <div class="d-status" style="--c:${STATUS_COLOR[p.status]}">
      <span class="dot"></span><b>${p.status}</b>
      <span class="d-why">indeks bahaya H = ${fmt(p.hazard_index, 2)}</span>
    </div>

    <div class="kpis">
      <div><span>NDDI rata-rata</span><b>${fmt(p.mean_nddi, 2)}</b></div>
      <div><span>Padi aktif</span><b>${fmt(p.active_ha)} <small>ha</small></b></div>
      <div><span>Berisiko (terbobot)</span><b>${fmt(p.ha_at_risk)} <small>ha</small></b></div>
      <div><span>NDVI / NDMI</span><b>${fmt(p.mean_ndvi, 2)} / ${fmt(p.mean_ndmi, 2)}</b></div>
    </div>

    <section>
      <h3>Sebaran kelas kekeringan</h3>
      ${classBar(p)}
      <ul class="legend-rows">${meta.nddi_classes
        .map((c) => `<li><i style="--c:${c.color}"></i>${c.label}<span>${fmt(p.class_ha[String(c.id)] ?? 0)} ha · ${fmt((100 * (p.class_ha[String(c.id)] ?? 0)) / totalClass)}%</span></li>`)
        .join("")}</ul>
    </section>

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
      <h3>Rekomendasi untuk penyuluh <span class="urg">${p.action.urgency}</span></h3>
      <p class="reco-h">${esc(p.action.headline)}</p>
      <ol>${p.action.steps.map((s) => `<li>${esc(s)}</li>`).join("")}</ol>
    </section>` : `<section class="reco ok"><h3>Rekomendasi</h3><p>Tidak ada tindakan khusus. Lanjutkan pemantauan rutin.</p></section>`}

    <section>
      <h3>Alur tindakan</h3>
      <ol class="stepper">${STEPS.slice(1)
        .map((s, i) => `<li class="${i + 1 <= stepIdx ? "done" : i + 1 === stepIdx + 1 ? "next" : ""}"><b>${s.label}</b><span>${s.who}</span></li>`)
        .join("")}</ol>
      <div class="row">
        ${next ? `<button class="primary" id="d-advance">Tandai: ${next.label}</button>` : `<span class="muted">Selesai ditindaklanjuti.</span>`}
        ${stepIdx > 0 ? `<button class="ghost" id="d-reset">Atur ulang</button>` : ""}
      </div>
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
      <form id="d-fb">
        ${FEEDBACK.map((o, i) => `<label class="radio"><input type="radio" name="fb" value="${o.label}" ${i === 0 ? "checked" : ""}> ${o.label}</label>`).join("")}
        <input type="text" name="note" placeholder="Catatan (opsional): desa, blok, foto…" />
        <button class="ghost" type="submit">Kirim laporan</button>
      </form>
      <ul class="log">${st.log
        .slice()
        .reverse()
        .map((l) => `<li><time>${new Date(l.at).toLocaleString("id-ID", { dateStyle: "short", timeStyle: "short" })}</time> ${l.kind === "feedback" ? "📍 " : "→ "}${esc(l.value)}${l.note ? ` <em>${esc(l.note)}</em>` : ""}</li>`)
        .join("") || `<li class="muted">Belum ada catatan.</li>`}</ul>
      <p class="fine">Prototipe: catatan disimpan di peramban ini saja. Pada Tahap 3 laporan dikirim ke server dan dipakai untuk mengoreksi masker padi dan ambang.</p>
    </section>

    <details class="fine">
      <summary>Bagaimana status dihitung?</summary>
      <p>H = rata-rata bobot bahaya kelas NDDI pada padi aktif (Normal 0, Ringan 0,1, Sedang 0,5, Kuat 0,85, Ekstrem 1). Status: H &lt; 0,40 Normal, &lt; 0,60 Waspada, &lt; 0,75 Siaga, selebihnya Awas. Peringkat memakai ha berisiko = luas × bobot bahaya × kerentanan fase (reproduktif 1,0; vegetatif akhir 0,7; vegetatif awal 0,5). Bobot bersifat provisional, mengikuti logika indeks H-MHEWS, dan dikalibrasi dengan laporan lapangan.</p>
    </details>`;

  el.classList.add("open");
  el.scrollTop = 0;
  $("#d-close").onclick = closeDetail;
  const adv = document.getElementById("d-advance");
  if (adv) adv.onclick = () => { advance(p.id); renderDetail(p); renderRanking(); };
  const rst = document.getElementById("d-reset");
  if (rst) rst.onclick = () => { resetStep(p.id); renderDetail(p); renderRanking(); };
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
    const fd = new FormData(ev.target as HTMLFormElement);
    addFeedback(p.id, String(fd.get("fb")), String(fd.get("note") || ""));
    renderDetail(p);
  };
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
      .filter((s) => s.id >= 2)
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
});

boot().catch((err) => {
  console.error(err);
  $("#loading").textContent = "Gagal memuat data. Jalankan pipeline/make_placeholder.py terlebih dahulu.";
});
