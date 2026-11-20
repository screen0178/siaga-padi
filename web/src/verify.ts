// v2 Phase 5.1: "Verifikasi" page - every check the app's claims rest on, in
// one place, including the ones that did not pass.
const num = (n: number, d = 0) => n.toLocaleString("id-ID", { maximumFractionDigits: d, minimumFractionDigits: d });
const pct = (v: number | null | undefined) => (v == null ? "-" : `${Math.round(v * 100)}%`);
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

export interface Verification {
  generated_at: string;
  video: { what: string; video: number; ours: number; unit: string; matched: boolean; note: string }[];
  capacity: {
    n: number; spearman_irrigated: number; spearman_rice3x: number; pearson_cropland_sawah: number;
    cropland_total: number; sawah_total: number; points: { name: string; proxy: number; official: number }[];
  } | null;
  scenario: { pair: string; rain_mm: number; kec_mae_ha: number; persist_mae_ha: number; kec_bias_ha: number }[] | null;
  forecast: {
    run_id: string; test_period: [string, string];
    test: { kecamatan: { mae_ha: Record<string, number>; coverage_p10_p90: number; siaga_or_awas: Record<string, { hit_rate: number | null; false_alarm_ratio: number | null }> } };
    test_rain_climatology: { kecamatan: { mae_ha: Record<string, number> } };
  } | null;
  reports: { n: number; generated_at?: string; summary?: Record<string, { label: string; n: number; agree: number; judged: number }>; excluded_desa?: number };
}

const BULAN = ["Jan", "Feb", "Mar", "Apr", "Mei", "Jun", "Jul", "Agu", "Sep", "Okt", "Nov", "Des"];
const pair = (p: string) => p.split(">").map((m) => BULAN[Number(m.slice(5, 7)) - 1]).join("→");
const chip = (k: "ok" | "part" | "no" | "wait", t: string) => `<span class="vchip ${k}">${t}</span>`;

/** Proxy vs official irrigated share, one dot per kecamatan. */
function scatter(points: { name: string; proxy: number; official: number }[]) {
  const W = 300, H = 210, L = 38, B = 32, T = 8, R = 10;
  const x = (v: number) => L + v * (W - L - R);
  const maxY = Math.max(0.2, ...points.map((p) => p.proxy)) * 1.1;
  const y = (v: number) => T + (1 - v / maxY) * (H - T - B);
  const ticksX = [0, 0.25, 0.5, 0.75, 1];
  const ticksY = [0, maxY / 2, maxY].map((v) => Math.round(v * 100) / 100);
  return `<svg viewBox="0 0 ${W} ${H}" width="100%" class="vscatter" role="img" aria-label="Pangsa hijau di puncak kemarau terhadap pangsa sawah irigasi resmi, per kecamatan">
    ${ticksY.map((v) => `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" class="t-grid"/><text x="${L - 5}" y="${y(v) + 3.5}" text-anchor="end" class="t-ax">${Math.round(v * 100)}%</text>`).join("")}
    ${ticksX.map((v) => `<text x="${x(v)}" y="${H - B + 14}" text-anchor="middle" class="t-ax">${Math.round(v * 100)}%</text>`).join("")}
    <line x1="${L}" x2="${W - R}" y1="${y(0)}" y2="${y(0)}" class="t-base"/>
    <text x="${(L + W - R) / 2}" y="${H - 4}" text-anchor="middle" class="t-band">sawah irigasi (data resmi 2024)</text>
    ${points.map((p) => `<circle cx="${x(p.official)}" cy="${y(p.proxy)}" r="4.5" class="vdot"><title>${esc(p.name)}: irigasi ${pct(p.official)}, hijau kemarau ${pct(p.proxy)}</title></circle>`).join("")}
  </svg>`;
}

export function verificationPage(v: Verification) {
  const c = v.capacity, f = v.forecast, r = v.reports;
  const videoOk = v.video.filter((x) => x.matched).length;
  const scenBetter = (v.scenario ?? []).every((s) => s.kec_mae_ha < s.persist_mae_ha);
  const fk = f?.test.kecamatan;
  const reportsJudged = Object.values(r.summary ?? {}).reduce((a, s) => a + s.judged, 0);
  const reportsAgree = Object.values(r.summary ?? {}).reduce((a, s) => a + s.agree, 0);

  const summary = `
    <table class="mt vsum"><tbody>
      <tr><td>Metode vs video NgabubuGIS #2 (Agu 2024)</td><td>${chip(videoOk === v.video.length ? "ok" : "part", `${videoOk} dari ${v.video.length} cocok`)}</td></tr>
      ${c ? `<tr><td>Proksi air satelit vs data irigasi resmi</td><td>${chip(c.spearman_irrigated >= 0.5 ? "ok" : "part", `ρ ${num(c.spearman_irrigated, 2)}`)}</td></tr>` : ""}
      ${v.scenario ? `<tr><td>Skenario tanpa hujan, uji balik</td><td>${chip(scenBetter ? "ok" : "part", scenBetter ? "lebih baik dari \"tidak berubah\"" : "sebagian")}</td></tr>` : ""}
      ${fk ? `<tr><td>Prakiraan 8–40 hari, tahun uji</td><td>${chip(fk.mae_ha.model < fk.mae_ha.persistence ? "ok" : "no", `galat −${Math.round(100 * (1 - fk.mae_ha.model / fk.mae_ha.persistence))}% vs persistensi`)}</td></tr>` : ""}
      <tr><td>Laporan lapangan vs peta</td><td>${r.n >= 20 ? chip(reportsAgree / Math.max(1, reportsJudged) >= 0.7 ? "ok" : "part", `${reportsAgree}/${reportsJudged} sesuai`) : chip("wait", `${r.n} laporan, perlu ≥ 20`)}</td></tr>
    </tbody></table>`;

  return `
    <form method="dialog">
      <div class="ck-head"><h3>Verifikasi data dan model</h3><span class="fine">diperbarui ${new Date(v.generated_at).toLocaleDateString("id-ID", { dateStyle: "medium" })}</span>
        <button class="icon" value="close" aria-label="Tutup">✕</button></div>
      <p class="fine">Semua uji yang menjadi dasar angka di aplikasi, termasuk yang belum lolos. Status kematangan: <b>digital shadow</b> dengan umpan balik yang ditutup manusia (penyuluh dan Dinas), belum digital twin penuh.</p>
      ${summary}

      <h4>1. Metode vs video NgabubuGIS #2 (Agustus 2024)</h4>
      <table class="mt"><thead><tr><th></th><th>Video</th><th>SIAGA-Padi</th><th></th></tr></thead><tbody>
        ${v.video.map((x) => `<tr><td>${esc(x.what)}</td><td>${num(x.video, x.unit ? 0 : 2)} ${x.unit}</td><td>${num(x.ours, x.unit ? 0 : 2)} ${x.unit}</td><td>${x.matched ? chip("ok", "cocok") : chip("no", "beda")}</td></tr>
          <tr class="vnote"><td colspan="4">${esc(x.note)}</td></tr>`).join("")}
      </tbody></table>

      ${c ? `<h4>2. Kapasitas air: satelit vs data resmi</h4>
      <div class="vgrid"><div>${scatter(c.points)}<p class="fine" style="text-align:center">sumbu tegak: sawah hijau (NDVI ≥ 0,45) di Agu/Sep 2026</p></div>
        <div><p>Sawah yang tetap hijau di puncak kemarau 2026 sejalan dengan pangsa irigasi resmi per kecamatan: Spearman ρ = <b>${num(c.spearman_irrigated, 2)}</b> (vs padi ≥ 3×/tahun: ${num(c.spearman_rice3x, 2)}). Aturan proksi ditetapkan sebelum dibandingkan.</p>
        <p>Lahan pertanian ESA vs sawah resmi per kecamatan: r = <b>${num(c.pearson_cropland_sawah, 2)}</b> (${num(c.cropland_total)} vs ${num(c.sawah_total)} ha): masker lahan cocok di tingkat kecamatan.</p>
        <p class="fine">Peringkat memakai data resmi, bukan proksi, agar bukti NDVI tidak dihitung dua kali.</p></div></div>` : ""}

      ${v.scenario ? `<h4>3. Skenario "tanpa hujan": uji balik 2026</h4>
      <table class="mt"><thead><tr><th>Bulan kering</th><th>Hujan</th><th>Galat skenario</th><th>"Tidak berubah"</th><th>Bias</th></tr></thead><tbody>
        ${v.scenario.map((s) => `<tr><td>${pair(s.pair)}</td><td>${num(s.rain_mm)} mm</td><td>${num(s.kec_mae_ha)} ha</td><td>${num(s.persist_mae_ha)} ha</td><td>${s.kec_bias_ha > 0 ? "+" : ""}${num(s.kec_bias_ha)} ha</td></tr>`).join("")}
      </tbody></table>
      <p class="fine">Galat ha kuat–ekstrem per kecamatan. Diuji pada musim yang sama dengan kalibrasinya (in-sample dalam waktu): uji di luar sampel menunggu musim kemarau 2027.</p>` : ""}

      ${fk ? `<h4>4. Prakiraan model (${f!.test_period[0].slice(0, 4)}–${f!.test_period[1].slice(0, 4)}, tidak dipakai melatih)</h4>
      <table class="mt"><thead><tr><th></th><th>Model</th><th>Persistensi</th><th>Klimatologi</th></tr></thead><tbody>
        <tr><td>Galat ha kuat–ekstrem per kecamatan</td><td>${num(fk.mae_ha.model)} ha</td><td>${num(fk.mae_ha.persistence)} ha</td><td>${num(fk.mae_ha.climatology)} ha</td></tr>
        <tr><td>Siaga/Awas terdeteksi</td><td>${pct(fk.siaga_or_awas.model.hit_rate)}</td><td>${pct(fk.siaga_or_awas.persistence.hit_rate)}</td><td></td></tr>
        <tr><td>Alarm palsu</td><td>${pct(fk.siaga_or_awas.model.false_alarm_ratio)}</td><td>${pct(fk.siaga_or_awas.persistence.false_alarm_ratio)}</td><td></td></tr>
        <tr><td>Dalam P10–P90 (target 80%)</td><td>${pct(fk.coverage_p10_p90)}</td><td></td><td></td></tr>
      </tbody></table>
      <p class="fine">Tanpa prakiraan hujan yang baik (hujan diganti klimatologi): ${num(f!.test_rain_climatology.kecamatan.mae_ha.model)} ha, masih lebih baik dari persistensi. Rincian di "Tentang model".</p>` : ""}

      <h4>5. Laporan lapangan</h4>
      ${r.n ? `<p>${r.n} laporan dibaca pada pembaruan data terakhir${r.excluded_desa ? `, ${r.excluded_desa} desa dikoreksi bukan padi` : ""}.</p>
        <ul>${Object.values(r.summary ?? {}).map((s) => `<li>${esc(s.label)}: peta sesuai ${s.agree} dari ${s.judged}${s.n > s.judged ? ` (${s.n - s.judged} tidak dapat dinilai)` : ""}</li>`).join("")}</ul>` : `<p>Belum ada laporan.</p>`}
      <p class="fine">Laporan adalah satu-satunya kebenaran lapangan: ambang lintasan NDVI, bobot skor, dan asumsi opsi tindakan dikalibrasi dari sini begitu jumlahnya cukup (≥ 20 per jenis jawaban).</p>

      <h4>Batasan yang masih terbuka</h4>
      <ul>
        <li>Lahan pertanian ESA ≠ sawah padi: tanaman lahan kering di selatan dapat terbaca kering ekstrem.</li>
        <li>Ambang fase tumbuh NDVI (Adinda 2020) belum diverifikasi dengan teks lengkap.</li>
        <li>Landsat tiap 8–16 hari dikurangi awan: peta selalu tertinggal; lihat umur citra di kanan atas.</li>
        <li>Bobot skor, nilai rupiah, dan efek opsi masih asumsi sampai dikalibrasi laporan.</li>
      </ul>
    </form>`;
}
