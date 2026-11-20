// Detail-panel sections that need no app state beyond their arguments:
// water capacity, verification flags, inactive sawah, field reports.
import { STAGE_COLOR, type Feedback, type KecProps, type Meta } from "./types";
import { esc, fmt, when } from "./util";
import { FEEDBACK, type Report } from "./workflow";

// ---------------------------------------------------------------- verification (v2 0.2)
export const VERIFY_MIN_HA = 25; // below this a flag is noise on the priority list
export const verifyHa = (p: KecProps) => (p.cropland_stage_ha?.["9"] ?? 0) + (p.cropland_stage_ha?.["10"] ?? 0);

/** v2 Phase 3: what water the kecamatan can fall back on. */
export function waterSection(p: KecProps) {
  const w = p.water;
  if (!w) return "";
  const pct = (v: number | undefined) => (v == null ? "-" : `${Math.round(v * 100)}%`);
  const f = p.capacity_factor;
  return `
    <section>
      <h3>Kapasitas air <span class="h-note">${esc(p.water_source ?? "")}</span></h3>
      <div class="wbar" title="Sawah irigasi ${fmt(w.irrigated_ha)} ha, tadah hujan ${fmt(w.rainfed_ha)} ha">
        <span style="width:${w.irrigated_share * 100}%" class="irr"></span><span style="width:${(1 - w.irrigated_share) * 100}%" class="rf"></span></div>
      <ul class="legend-rows">
        <li><i style="--c:#5bb0d9"></i>Sawah irigasi<span>${fmt(w.irrigated_ha)} ha (${pct(w.irrigated_share)})</span></li>
        <li><i style="--c:#c9a66b"></i>Sawah tadah hujan<span>${fmt(w.rainfed_ha)} ha</span></li>
        <li>Ditanami padi ≥ 3× setahun<span>${pct(w.rice3x_share)}</span></li>
        ${w.dry_green_share != null ? `<li>Hijau di puncak kemarau 2026 (satelit)<span>${pct(w.dry_green_share)}</span></li>` : ""}
      </ul>
      <p class="fine">Data resmi Dinas Pertanian 2024. ${f != null && f < 1 ? `Peringkat memakai ha berisiko × ${fmt(f, 2)}: sawah irigasi meredam, tidak menghapus, risiko kekeringan. Status tetap dari tingkat bahaya.` : ""} "Hijau di puncak kemarau" = sawah dengan tajuk padi (NDVI ≥ 0,45) pada Agustus atau September 2026, tanda ada air irigasi, pompa, atau sumur.</p>
    </section>`;
}

/** Harvest-like drops that may be drought-killed crops: ask, do not hide. */
export function verifySection(p: KecProps) {
  if (verifyHa(p) <= 0) return "";
  const cs = p.cropland_stage_ha ?? {};
  const puso = cs["9"] ?? 0, failed = cs["10"] ?? 0;
  return `
    <section class="verify">
      <h3>Perlu verifikasi</h3>
      <ul class="legend-rows">
        ${puso > 0 ? `<li><i style="--c:${STAGE_COLOR["9"]}"></i>Panen atau puso?<span>${fmt(puso)} ha</span></li>` : ""}
        ${failed > 0 ? `<li><i style="--c:${STAGE_COLOR["10"]}"></i>Gagal tanam?<span>${fmt(failed)} ha</span></li>` : ""}
      </ul>
      ${puso > 0 ? `<p class="fine"><b>Panen atau puso?</b> Lahan turun seperti panen (${fmt(cs["7"] ?? 0)} ha lain terlihat panen biasa), tetapi sebelumnya sudah tercekam kuat, atau turunnya terlalu cepat setelah tanam.</p>` : ""}
      ${failed > 0 ? `<p class="fine"><b>Gagal tanam?</b> Lahan tidak pernah hijau, padahal sebagian besar sawah dalam radius 300 m di sekitarnya hijau: wilayah itu ditanami, jadi lahan ini mungkin gagal tumbuh, bukan sengaja dibiarkan bera.</p>` : ""}
      <p class="fine">Tidak dihitung sebagai padi aktif, jadi tidak masuk peringkat: hanya cek lapangan yang bisa memastikan.</p>
      <button class="ghost" id="d-verify">Isi laporan cek lapangan</button>
    </section>`;
}

export function inactiveSection(p: KecProps, meta: Meta, fb: Feedback | null) {
  const cs = p.cropland_stage_ha;
  if (!cs || !("6" in cs || "7" in cs || "8" in cs)) return "";
  // Stage 9 has its own "Perlu verifikasi" section
  const rows = meta.stage_classes.filter((s) => s.id >= 6 && s.id !== 9 && s.id !== 10 && (s.id !== 8 || (cs["8"] ?? 0) > 0));
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


export function reportSummary(reps: Report[]) {
  if (!reps.length) return "";
  const n: Record<string, number> = {};
  reps.forEach((r) => (n[r.answer] = (n[r.answer] ?? 0) + 1));
  const parts = FEEDBACK.filter((f) => n[f.id]).map((f) => `${n[f.id]} ${f.label.split(":")[0].split(" (")[0].toLowerCase()}`);
  const wrong = (n.not_rice ?? 0) + (n.harvested ?? 0) + (n.irrigated ?? 0);
  // Only flag doubt once a few independent checks agree
  return `<p class="rep-sum"><b>${reps.length} laporan</b>: ${parts.join(", ")}.${reps.length >= 3 && wrong / reps.length >= 0.5 ? ` <span class="warn">Sebagian besar laporan tidak membenarkan cekaman; status peta di sini perlu diragukan.</span>` : ""}</p>`;
}

/** How the last pipeline run judged one report against the map. */
export function reportCheck(r: Report, fb: Feedback | null) {
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

export function feedbackExplainer(fb: Feedback | null) {
  if (!fb || !fb.n_reports) return "";
  const rows = Object.values(fb.check.summary).filter((v) => v.n);
  return `<p><b>Laporan lapangan dalam pipeline</b></p>
    <p>Pembaruan citra terakhir (${when(fb.generated_at)}) membaca ${fb.n_reports} laporan. Desa dengan ≥ ${fb.rules.exclude_min_reports} laporan "bukan padi" yang menjadi mayoritas laporannya dikeluarkan dari padi aktif (${fb.excluded_desa.length} desa). Setiap laporan juga dibandingkan dengan peta bulan itu:</p>
    <ul>${rows.map((v) => `<li>${esc(v.label)}: peta sesuai ${v.agree} dari ${v.judged}${v.n > v.judged ? ` (${v.n - v.judged} tidak dapat dinilai)` : ""}</li>`).join("")}</ul>
    <p>"Sudah panen / bera" yang sering berbeda dengan peta berarti ambang lintasan NDVI perlu disetel.</p>`;
}
