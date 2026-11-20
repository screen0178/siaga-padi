// v2 Phase 4: production at risk in tonnes / rupiah and action options with
// their estimated effect (computed in pipeline/impact.py).
import type { ActionOption, Impact, Meta } from "./types";

const num = (n: number, d = 0) => n.toLocaleString("id-ID", { maximumFractionDigits: d, minimumFractionDigits: d });

/** Rupiah, short: "Rp 2,1 M" (miliar) or "Rp 850 jt". */
export function rp(v: number) {
  if (Math.abs(v) >= 1e9) return `Rp ${num(v / 1e9, v >= 1e10 ? 0 : 1)} M`;
  return `Rp ${num(Math.round(v / 1e6))} jt`;
}
/** Range "Rp 2,1–4,2 M"; units only once when both ends share them. */
export function rpRange(a: number, b: number) {
  if (a >= 1e9 && b >= 1e9) return `Rp ${num(a / 1e9, b >= 1e10 ? 0 : 1)}–${num(b / 1e9, b >= 1e10 ? 0 : 1)} M`;
  return `${rp(a)}–${rp(b)}`;
}
export const tRange = (a: number, b: number) => `${num(a)}–${num(b)} t`;

export function impactSection(
  imp: Impact | undefined, opts: ActionOption[] | null, meta: Meta,
  ctx: { label: string; fcRainMm?: number | null; fcDays?: number | null; optsNote?: string },
) {
  if (!imp || !meta.impact) return "";
  const a = meta.impact;
  const optList = (opts ?? []).map((o) => `
    <li class="opt ${o.id}">
      <div class="opt-h"><b>${o.label}</b><span>${num(o.target_ha)} ha${o.pumps ? ` · ${o.pumps[0]}–${o.pumps[1]} pompa` : ""}</span></div>
      ${o.saves ? `<div class="opt-v">Menyelamatkan ±${tRange(o.saves.t[0], o.saves.t[1])} GKG · <b>${rpRange(o.saves.rp[0], o.saves.rp[1])}</b></div>` : ""}
      <p class="fine">${o.detail}${o.id === "delay" && ctx.fcRainMm != null && ctx.fcRainMm >= 100
        ? ` Prakiraan hujan ${ctx.fcDays ?? 16} hari ke depan ±${num(ctx.fcRainMm)} mm: syarat tanam mulai terpenuhi, siapkan benih dan olah tanah.` : ""}</p>
    </li>`).join("");
  return `
    <section class="impact">
      <h3>Dampak dan opsi tindakan <span class="h-note">${ctx.label}</span></h3>
      <div class="imp-kpi">
        <div><span>Produksi terancam</span><b>${tRange(imp.t[0], imp.t[2])}</b><small>GKG · setara ${num(imp.ha_eq)} ha gagal panen</small></div>
        <div><span>Nilai produksi terancam</span><b>${rpRange(imp.rp[0], imp.rp[2])}</b><small>harga HPP–pasar</small></div>
      </div>
      ${opts && opts.length ? `<ol class="opts">${optList}</ol>${ctx.optsNote ? `<p class="fine">${ctx.optsNote}</p>` : ""}` : opts ? `<p class="fine">Tidak ada opsi dengan sasaran ≥ 25 ha.</p>` : ""}
      <p class="fine">Perkiraan, bukan kerugian pasti: ha berisiko (luas × bobot bahaya × kerentanan fase) × produktivitas ${num(a.yield_t_ha, 2)} t/ha (±${Math.round((1 - a.yield_factor[0]) * 100)}%; ${a.yield_source}) × harga GKG Rp ${num(a.price_rp_kg[0])}–${num(a.price_rp_kg[1])}/kg (${a.price_source}). Efek opsi memakai asumsi sederhana yang tercantum; dikalibrasi dengan laporan lapangan.</p>
    </section>`;
}
