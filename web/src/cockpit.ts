// v2 Phase 4.3: Dinas cockpit. KPI tiles for the whole kabupaten and an alert
// list (who owns each case, how long it has waited, what it needs next).
import { rp, rpRange, tRange } from "./impact";
import { STATUS_COLOR as SC, type Forecast, type KecProps, type Meta } from "./types";
const STATUS_COLOR = SC as Record<string, string>;
import { STEPS, getState, type StepId } from "./workflow";

const num = (n: number) => Math.round(n).toLocaleString("id-ID");
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
const SEV: Record<string, number> = { Awas: 3, Siaga: 2, Waspada: 1, Normal: 0 };
const NEXT: Record<StepId, string> = {
  open: "Usulan penyuluh", proposed: "Persetujuan Dinas", approved: "Kirim ke Gapoktan",
  sent: "Catat tindak lanjut", done: "",
};

function ago(iso: string) {
  const h = (Date.now() - new Date(iso).getTime()) / 3.6e6;
  if (h < 1) return `${Math.max(1, Math.round(h * 60))} mnt`;
  if (h < 48) return `${Math.round(h)} jam`;
  return `${Math.round(h / 24)} hari`;
}

export interface CockpitInput {
  meta: Meta;
  /** Current-period props per kecamatan (observed, not a scenario or forecast view). */
  kec: KecProps[];
  prevStressedHa: number | null;
  prevLabel: string | null;
  forecast: Forecast | null;
  periodLabel: string;
}

export function cockpitHtml(c: CockpitInput) {
  const t = c.meta.totals;
  const stressed = (t.class_ha["4"] ?? 0) + (t.class_ha["5"] ?? 0);
  const count = (s: string) => c.kec.filter((p) => p.status === s).length;
  const steps = c.kec.map((p) => getState(p.id).step);
  const n = (s: StepId) => steps.filter((x) => x === s).length;
  const severeOpen = c.kec.filter((p) => SEV[p.status] >= 2 && getState(p.id).step === "open").length;
  const fcLast = c.forecast?.steps.at(-1);
  const fcNow = c.forecast?.totals[c.forecast.steps[0].id];
  const fcEnd = fcLast ? c.forecast!.totals[fcLast.id] : undefined;
  const fcSevere = fcLast ? Object.values(c.forecast!.kecamatan).filter((k) => SEV[k.steps[fcLast.id]?.status ?? "Normal"] >= 2).length : 0;
  const imp = t.impact;
  const delta = c.prevStressedHa != null ? stressed - c.prevStressedHa : null;

  const tiles = `
    <div class="tile"><span>Cekaman kuat–ekstrem</span><b>${num(stressed)} ha</b>
      <small>${delta == null ? "" : `${delta > 0 ? "▲" : "▼"} ${num(Math.abs(delta))} ha vs ${c.prevLabel}`}</small></div>
    <div class="tile"><span>Kecamatan per status</span>
      <b class="st">${["Awas", "Siaga", "Waspada", "Normal"].map((s) => `<i style="--c:${STATUS_COLOR[s]}"></i>${count(s)}`).join(" ")}</b>
      <small>Awas · Siaga · Waspada · Normal</small></div>
    <div class="tile"><span>Nilai produksi terancam</span><b>${imp ? rpRange(imp.rp[0], imp.rp[2]) : "-"}</b>
      <small>${imp ? `${tRange(imp.t[0], imp.t[2])} GKG` : ""}</small></div>
    <div class="tile ${n("proposed") ? "attn" : ""}"><span>Tindakan</span>
      <b>${n("proposed")} <em>menunggu Dinas</em></b>
      <small>${n("approved")} disetujui · ${n("sent")} dikirim · ${n("done")} selesai · ${severeOpen} Siaga/Awas belum ditindak</small></div>
    ${fcEnd && fcNow ? `<div class="tile fc"><span>Prakiraan ${fcLast!.label}</span>
      <b>${num(fcEnd.ha[1])} ha ${fcEnd.ha[1] < fcNow.ha[1] ? "▼" : "▲"}</b>
      <small>kisaran ${num(fcEnd.ha[0])}–${num(fcEnd.ha[2])} ha · ${fcSevere} kec. Siaga/Awas · hari ini ${num(fcNow.ha[1])} ha</small></div>` : ""}`;

  // Alerts: anything severe now or in the forecast, or with an action in progress
  const rows = c.kec
    .map((p) => {
      const st = getState(p.id);
      const fs = fcLast ? c.forecast!.kecamatan[p.id]?.steps[fcLast.id] : undefined;
      const last = st.log.at(-1);
      return { p, st, fs, last };
    })
    .filter(({ p, st, fs }) => SEV[p.status] >= 2 || SEV[fs?.status ?? "Normal"] >= 2 || (st.step !== "open" && st.step !== "done"))
    .sort((a, b) =>
      Number(b.st.step === "proposed") - Number(a.st.step === "proposed")
      || SEV[b.p.status] - SEV[a.p.status]
      || a.p.rank - b.p.rank);
  const since = c.meta.generated_at;
  const list = rows.map(({ p, st, fs, last }) => `
    <tr data-kec="${p.id}" class="${st.step === "proposed" ? "attn" : ""}">
      <td><b>${esc(p.name)}</b><small>#${p.rank}</small></td>
      <td><span class="pill" style="--c:${STATUS_COLOR[p.status]}">${p.status}</span>${fs ? ` → <span class="pill fcp" style="--c:${STATUS_COLOR[fs.status]}" title="Prakiraan ${fcLast!.label}, keyakinan ${fs.confidence.toLowerCase()}">${fs.status}</span>` : ""}</td>
      <td class="r">${p.impact ? rp(p.impact.rp[1]) : "-"}</td>
      <td>${STEPS.find((s) => s.id === st.step)!.label}</td>
      <td>${last?.actor ? esc(last.actor) : `<span class="muted">belum ada</span>`}</td>
      <td class="r" title="${last ? "Sejak langkah terakhir" : "Sejak data citra diproses"}">${ago(last?.at ?? since)}</td>
      <td class="${st.step === "proposed" ? "need" : ""}">${NEXT[st.step]}</td>
    </tr>`).join("");

  return `
    <form method="dialog">
      <div class="ck-head"><h3>Dasbor Dinas Pertanian</h3><span class="fine">${esc(c.periodLabel)} · kondisi peta teramati${c.forecast ? " + prakiraan model" : ""}</span>
        <button class="icon" value="close" aria-label="Tutup">✕</button></div>
      <div class="tiles">${tiles}</div>
      <h4>Perlu perhatian <span class="fine">${rows.length} kecamatan: Siaga/Awas sekarang atau dalam prakiraan, atau tindakan sedang berjalan</span></h4>
      ${rows.length ? `<table class="alerts"><thead><tr><th>Kecamatan</th><th>Status → prakiraan</th><th class="r">Nilai terancam</th><th>Tindakan</th><th>Pemilik</th><th class="r">Umur</th><th>Perlu</th></tr></thead>
        <tbody>${list}</tbody></table>` : `<p class="fine">Tidak ada kecamatan Siaga/Awas dan tidak ada tindakan yang berjalan.</p>`}
      <p class="fine"><button class="link" data-open="verify">Verifikasi data dan model →</button></p>
      <p class="fine">Klik baris untuk membuka detail kecamatan. "Umur" = sejak langkah terakhir pada alur tindakan, atau sejak data citra diproses bila belum ditindak. Nilai terancam = perkiraan tengah; rentang di panel detail.</p>
    </form>`;
}
