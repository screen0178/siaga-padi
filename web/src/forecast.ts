// v2 Phase 2.4: the model forecast in the detail panel, the "Tentang model"
// page, and the optional forecast sentence for messages to Gapoktan.
import { STATUS_COLOR, type Forecast, type KecForecastStep, type ModelMetrics } from "./types";
import type { Review } from "./workflow";

const fmt = (n: number | null | undefined, d = 0) =>
  n == null ? "-" : n.toLocaleString("id-ID", { maximumFractionDigits: d, minimumFractionDigits: d });
const pct = (v: number | null | undefined) => (v == null ? "-" : `${Math.round(v * 100)}%`);
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
const BULAN = ["Jan", "Feb", "Mar", "Apr", "Mei", "Jun", "Jul", "Agu", "Sep", "Okt", "Nov", "Des"];
export const tgl = (iso: string) => `${Number(iso.slice(8, 10))} ${BULAN[Number(iso.slice(5, 7)) - 1]}`;
const CONF_COLOR = { Tinggi: "#3fb27f", Sedang: "#f2c94c", Rendah: "#e8553d" } as const;

/** Forecast step shown when none is selected: the farthest one. */
export const defaultStep = (fc: Forecast) => fc.steps[fc.steps.length - 1].id;

/** Can this forecast go into a message to farmers? Only when confident or
 * accepted by Dinas, and never once Dinas rejected it. */
export function messageAllowed(s: KecForecastStep | undefined, review?: Review) {
  if (!s || review?.verdict === "reject") return false;
  return review?.verdict === "accept" || s.confidence === "Tinggi";
}

export function forecastSentence(fc: Forecast, kecId: string, review?: Review): string | null {
  const id = defaultStep(fc);
  const s = fc.kecamatan[kecId]?.steps[id];
  if (!messageAllowed(s, review)) return null;
  const step = fc.steps.find((x) => x.id === id)!;
  return `Prakiraan model sampai ${tgl(step.date)}: status *${s!.status.toUpperCase()}*, ±${fmt(s!.ha[1])} ha (kisaran ${fmt(s!.ha[0])}–${fmt(s!.ha[2])} ha) padi berisiko cekaman kuat${review?.verdict === "accept" ? " (sudah ditinjau Dinas)" : ""}.`;
}

/** Detail-panel card: the three steps with P10-P90 bars, confidence, reasons, review. */
export function forecastCard(
  fc: Forecast, kecId: string, observedStatus: string, selected: string | null,
  review: Review | undefined, opts: { canReview: boolean; serverMode: boolean; obsLabel: string },
) {
  const k = fc.kecamatan[kecId];
  if (!k || !Object.keys(k.steps).length) {
    return `<section class="fc"><h3>Prakiraan model</h3><p class="fine">Tidak ada citra bersih yang cukup baru untuk kecamatan ini (perlu citra ≤ 32 hari).</p></section>`;
  }
  const max = Math.max(1, ...Object.values(k.steps).map((s) => s.ha[2]));
  const sel = selected && k.steps[selected] ? selected : defaultStep(fc);
  const rows = fc.steps
    .filter((st) => k.steps[st.id])
    .map((st) => {
      const s = k.steps[st.id];
      const x = (v: number) => (100 * v) / max;
      return `<li class="${st.id === sel ? "on" : ""}" data-fc="${st.id}" title="Klik untuk menampilkan di peta">
        <span class="fc-when"><b>${st.label}</b><small>${tgl(st.date)}</small></span>
        <span class="pill" style="--c:${STATUS_COLOR[s.status]}">${s.status}</span>
        <span class="fc-bar" title="P10–P90: ${fmt(s.ha[0])}–${fmt(s.ha[2])} ha; P50 ${fmt(s.ha[1])} ha">
          <i class="rng" style="left:${x(s.ha[0])}%;width:${Math.max(0.8, x(s.ha[2]) - x(s.ha[0]))}%"></i>
          <i class="mid" style="left:${x(s.ha[1])}%"></i></span>
        <span class="fc-ha"><b>${fmt(s.ha[1])}</b> ha</span>
        <span class="fc-conf" style="--c:${CONF_COLOR[s.confidence]}" title="Keyakinan dari lebar kisaran P10–P90 dan cakupan citra bersih (${pct(s.coverage)} sawah)">${s.confidence}</span>
      </li>`;
    })
    .join("");
  const s = k.steps[sel];
  const st = fc.steps.find((x) => x.id === sel)!;
  const reviewHtml = review
    ? `<p class="fc-rev ${review.verdict}">${review.verdict === "accept" ? "✓ Diterima" : "✗ Ditolak"} Dinas · ${esc(review.actor)} · ${new Date(review.created_at).toLocaleString("id-ID", { dateStyle: "short", timeStyle: "short" })}${review.note ? ` · <em>${esc(review.note)}</em>` : ""}</p>`
    : `<p class="fine">Belum ditinjau Dinas.${s.confidence === "Tinggi" ? "" : " Pesan ke Gapoktan baru memuat prakiraan ini setelah diterima Dinas."}</p>`;
  const actions = !opts.serverMode
    ? `<p class="fine">Tinjauan Dinas butuh server.</p>`
    : opts.canReview
      ? `<div class="row fc-act"><input id="fc-note" maxlength="500" placeholder="Catatan (opsional)" />
          <button class="primary" id="fc-accept">Terima</button><button class="ghost" id="fc-reject">Tolak</button></div>
         <p class="wf-err" id="fc-err" hidden></p>`
      : "";
  return `
    <section class="fc">
      <h3>Prakiraan model <span class="h-note">Kuat–ekstrem, ha · P10–P90</span></h3>
      <ul class="fc-rows">${rows}</ul>
      <p class="fc-src"><span class="tag model">Model</span> ${s.status} pada ${tgl(st.date)}, keyakinan ${s.confidence.toLowerCase()} ·
        <span class="tag rule">Aturan</span> ${observedStatus} pada peta ${esc(opts.obsLabel)}</p>
      ${s.reasons.length ? `<p class="fc-why-h">Alasan utama (${st.label.toLowerCase()})</p>
      <ul class="fc-why">${s.reasons.map((r) => `<li class="${r.up ? "up" : "down"}"><span>${r.up ? "▲" : "▼"}</span>${esc(r.text)}<small>${r.pp > 0 ? "+" : ""}${fmt(r.pp, 1)} poin</small></li>`).join("")}</ul>` : ""}
      <p class="fine">Dari citra ${k.obs_dates.map(tgl).join(", ")} (${s.h_days[0] === s.h_days[1] ? s.h_days[0] : `${s.h_days[0]}–${s.h_days[1]}`} hari ke depan dari citra) dan hujan ${fmt(s.rain_win_mm)} mm sampai ${tgl(st.date)} (teramati + prakiraan Open-Meteo). Hektare = pangsa prakiraan × padi aktif di peta.</p>
      ${reviewHtml}
      ${actions}
      <button class="link" id="fc-about">Tentang model: data, uji, dan batasan →</button>
    </section>`;
}

// ---------------------------------------------------------------- "Tentang model"
const GROUP_LABEL: Record<string, string> = {
  state: "Kondisi cekaman pada citra terakhir", rain_future: "Hujan sampai tanggal prakiraan",
  rain_past: "Hujan 10–60 hari sebelum citra", trend: "Perubahan sejak citra sebelumnya",
  stage: "Fase tumbuh / kehijauan", water: "Irigasi (data resmi)", season: "Musim (bulan)", horizon: "Jarak hari prakiraan",
};

function metricRows(m: ModelMetrics) {
  const d = m.desa, k = m.kecamatan;
  const sa = k.siaga_or_awas;
  const better = (a: number, b: number) => (a < b ? ` <span class="ok">${Math.round(100 * (1 - a / b))}% lebih baik</span>` : "");
  return `
    <tr><td>Galat pangsa kuat–ekstrem per desa (MAE)</td><td>${fmt(100 * d.mae_share.model, 1)} poin</td><td>${fmt(100 * d.mae_share.persistence, 1)}${better(d.mae_share.model, d.mae_share.persistence)}</td><td>${fmt(100 * d.mae_share.climatology, 1)}</td></tr>
    <tr><td>Galat ha kuat–ekstrem per kecamatan (MAE)</td><td>${fmt(k.mae_ha.model)} ha</td><td>${fmt(k.mae_ha.persistence)}${better(k.mae_ha.model, k.mae_ha.persistence)}</td><td>${fmt(k.mae_ha.climatology)}</td></tr>
    <tr><td>Status kecamatan tepat</td><td>${pct(k.status_match.model)}</td><td>${pct(k.status_match.persistence)}</td><td></td></tr>
    <tr><td>Siaga/Awas: terdeteksi (hit rate)</td><td>${pct(sa.model.hit_rate)}</td><td>${pct(sa.persistence.hit_rate)}</td><td></td></tr>
    <tr><td>Siaga/Awas: alarm palsu</td><td>${pct(sa.model.false_alarm_ratio)}</td><td>${pct(sa.persistence.false_alarm_ratio)}</td><td></td></tr>
    <tr><td>Nilai sebenarnya di dalam P10–P90 (target 80%)</td><td>desa ${pct(d.coverage_p10_p90)}, kec. ${pct(k.coverage_p10_p90)}</td><td></td><td></td></tr>`;
}

export function modelPage(fc: Forecast) {
  const m = fc.model, t = m.test, tc = m.test_rain_climatology;
  const imp = Object.entries(m.group_importance).filter(([, v]) => v > 0);
  const maxImp = Math.max(1e-9, ...imp.map(([, v]) => v));
  return `
    <form method="dialog">
      <h3>Tentang model prakiraan</h3>
      <p class="fine">Run ${esc(m.run_id)} · dilatih ${new Date(m.trained_at).toLocaleDateString("id-ID", { dateStyle: "medium" })} · ${esc(m.kind)}</p>
      <p>Memprakirakan pangsa padi aktif dengan cekaman <b>kuat–ekstrem</b> (NDDI ≥ 1,25) dan indeks bahaya H tiap desa ${m.horizon_days[0]}–${m.horizon_days[1]} hari setelah citra Landsat terakhir, sebagai kisaran P10 / P50 / P90. Status prakiraan memakai ambang yang sama dengan peta.</p>
      <h4>Data</h4>
      <ul>
        <li>${fmt(m.data.dates)} tanggal citra Landsat 8/9 (${tgl(m.data.first)} ${m.data.first.slice(0, 4)} – ${tgl(m.data.last)} ${m.data.last.slice(0, 4)}), ${m.data.desa} desa, masker sama dengan peta.</li>
        <li>Hujan harian Open-Meteo (reanalisis ERA5) di titik tiap kecamatan; saat dipakai: hujan teramati + prakiraan 16 hari.</li>
        <li>Pangsa sawah irigasi resmi 2024, elevasi SRTM, musim.</li>
        <li>Pasangan latih ${fmt(m.n_pairs.train)}, validasi ${fmt(m.n_pairs.val)}, uji ${fmt(m.n_pairs.test)}.</li>
      </ul>
      <h4>Uji pada tahun yang tidak dipakai melatih (${m.test_period[0].slice(0, 4)}–${m.test_period[1].slice(0, 4)})</h4>
      <p class="fine">Latih ≤ 2022, validasi 2023, uji 2024 dst.; dibagi menurut waktu, bukan acak. Pembanding: <b>persistensi</b> (dianggap tidak berubah) dan <b>klimatologi</b> (rata-rata desa pada bulan yang sama).</p>
      <table class="mt"><thead><tr><th></th><th>Model</th><th>Persistensi</th><th>Klimatologi</th></tr></thead><tbody>${metricRows(t)}</tbody></table>
      <p class="fine">Hujan masa depan saat latih adalah hujan teramati. Jika diganti klimatologi (tanpa prakiraan hujan yang baik), galat per kecamatan menjadi ${fmt(tc.kecamatan.mae_ha.model)} ha (persistensi ${fmt(tc.kecamatan.mae_ha.persistence)} ha): batas bawah kemampuan nyata.</p>
      <h4>Galat menurut jarak hari (pangsa per desa)</h4>
      <table class="mt"><thead><tr><th>Hari setelah citra</th><th>Model</th><th>Persistensi</th><th>n</th></tr></thead><tbody>${Object.entries(m.test_by_horizon)
        .map(([h, v]) => `<tr><td>${h}</td><td>${fmt(100 * v.mae_model, 1)} poin</td><td>${fmt(100 * v.mae_persistence, 1)}</td><td>${fmt(v.n)}</td></tr>`).join("")}</tbody></table>
      <h4>Yang paling berpengaruh</h4>
      <p class="fine">Kenaikan galat bila kelompok fitur diacak (uji):</p>
      <ul class="imp">${imp.map(([g, v]) => `<li><span>${GROUP_LABEL[g] ?? g}</span><i style="width:${(100 * v) / maxImp}%"></i><small>+${fmt(100 * v, 1)}</small></li>`).join("")}</ul>
      <h4>Batasan</h4>
      <ul>
        <li>Fase tumbuh dari satu tanggal citra, bukan lintasan 4 bulan seperti peta: model memprakirakan pangsa, aplikasi mengalikannya dengan padi aktif di peta.</li>
        <li>Kisaran kecamatan menjumlahkan kuantil desa (anggap desa bergerak bersama); cakupan di atas menunjukkan seberapa tepat anggapan itu.</li>
        <li>Kuat–ekstrem adalah kelas NDDI, bukan kehilangan hasil yang teramati. Prakiraan mendukung, tidak menggantikan, cek lapangan dan tinjauan Dinas.</li>
      </ul>
      <div class="row"><button class="primary" value="close">Tutup</button></div>
    </form>`;
}
