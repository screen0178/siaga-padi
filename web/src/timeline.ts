// Stage 1: period strip (time slider) and per-kecamatan NDDI trend chart.
import { STATUS_COLOR, type KecProps, type Meta, type Period } from "./types";

const MONTH = ["Jan", "Feb", "Mar", "Apr", "Mei", "Jun", "Jul", "Agu", "Sep", "Okt", "Nov", "Des"];
export const shortLabel = (p: Period) => MONTH[Number(p.start.slice(5, 7)) - 1] ?? p.id;

const fmt = (n: number | null | undefined, d = 0) =>
  n == null ? "-" : n.toLocaleString("id-ID", { maximumFractionDigits: d, minimumFractionDigits: d });

const stressedHa = (c: Record<string, number>) => (c["4"] ?? 0) + (c["5"] ?? 0);

function tipAt(tip: HTMLElement, host: HTMLElement, anchor: DOMRect, html: string) {
  const h = host.getBoundingClientRect();
  tip.innerHTML = html;
  tip.hidden = false;
  const x = anchor.left + anchor.width / 2 - h.left;
  tip.style.left = `${Math.max(tip.offsetWidth / 2, Math.min(h.width - tip.offsetWidth / 2, x))}px`;
  tip.style.top = `${anchor.top - h.top - 6}px`;
}

// ------------------------------------------------------------ period strip
export function renderStrip(
  el: HTMLElement,
  meta: Meta,
  selected: string,
  onPick: (id: string) => void,
  onPlay: () => void,
  playing: boolean,
) {
  const periods = meta.periods!;
  const kuatColor = meta.nddi_classes.find((c) => c.id === 4)?.color ?? "#e8553d";
  const ekstColor = meta.nddi_classes.find((c) => c.id === 5)?.color ?? "#8b0a1a";
  const max = Math.max(1, ...periods.map((p) => stressedHa(p.totals.class_ha)));
  el.innerHTML = `
    <button class="tl-play" aria-label="${playing ? "Jeda" : "Putar"}" title="${playing ? "Jeda" : "Putar urutan bulan"}">${playing ? "❚❚" : "▶"}</button>
    <div class="tl-periods" role="radiogroup" aria-label="Periode">${periods
      .map((p) => {
        const k = p.totals.class_ha["4"] ?? 0, e = p.totals.class_ha["5"] ?? 0;
        return `<button class="tl-p ${p.id === selected ? "on" : ""}" data-id="${p.id}" role="radio" aria-checked="${p.id === selected}"
            aria-label="${p.label}: ${fmt(k + e)} ha cekaman kuat–ekstrem">
          <span class="tl-bar"><i style="height:${(100 * e) / max}%;background:${ekstColor}"></i><i style="height:${(100 * k) / max}%;background:${kuatColor}"></i></span>
          <span class="tl-l">${shortLabel(p)}</span>
        </button>`;
      })
      .join("")}</div>
    <div class="tl-cap"><b>${periods.find((p) => p.id === selected)?.label ?? ""}</b><span>ha cekaman kuat–ekstrem per bulan</span></div>
    <div class="tl-tip" hidden></div>`;
  const tip = el.querySelector<HTMLElement>(".tl-tip")!;
  el.querySelector<HTMLButtonElement>(".tl-play")!.onclick = onPlay;
  el.querySelectorAll<HTMLButtonElement>(".tl-p").forEach((b) => {
    const p = periods.find((x) => x.id === b.dataset.id)!;
    b.onclick = () => onPick(p.id);
    b.onmouseenter = () => {
      const n = p.source.scenes?.length;
      tipAt(tip, el, b.getBoundingClientRect(),
        `<b>${p.label}</b><br>Kuat ${fmt(p.totals.class_ha["4"])} ha · Ekstrem ${fmt(p.totals.class_ha["5"])} ha<br>Padi aktif ${fmt(p.totals.active_ha)} ha${n ? ` · ${n} tanggal citra` : ""}`);
    };
    b.onmouseleave = () => (tip.hidden = true);
  });
}

// ------------------------------------------------------------ trend chart
export function renderTrend(el: HTMLElement, p: KecProps, meta: Meta, selected: string, onPick: (id: string) => void) {
  const periods = meta.periods!;
  const vals = periods.map((pp) => p.series?.[pp.id]?.mean_nddi ?? null);
  const nums = vals.filter((v): v is number => v != null);
  const W = 364, H = 136, L = 30, R = 64, T = 8, B = 30;
  const lo = Math.min(0, Math.floor(Math.min(...nums, 0) * 2) / 2);
  const hi = Math.max(3.25, Math.ceil((Math.max(...nums, 0) + 0.15) * 4) / 4);
  const x = (i: number) => L + ((W - L - R) * (periods.length === 1 ? 0.5 : i / (periods.length - 1)));
  const y = (v: number) => T + (H - T - B) * (1 - (v - lo) / (hi - lo));
  const classOf = (v: number) =>
    meta.nddi_classes.find((c) => (c.min == null || v >= c.min) && (c.max == null || v < c.max));

  // Class bands (what an NDDI value means), labelled at the right edge
  const bands = meta.nddi_classes
    .map((c) => {
      const a = Math.max(lo, c.min ?? lo), b = Math.min(hi, c.max ?? hi);
      if (b <= a) return "";
      const y1 = y(b), y2 = y(a);
      return `<rect x="${L}" y="${y1}" width="${W - L - R}" height="${y2 - y1}" fill="${c.color}" opacity="0.10"/>
        ${y2 - y1 >= 11 ? `<text x="${W - R + 6}" y="${(y1 + y2) / 2 + 3.5}" class="t-band">${c.label}</text>` : ""}`;
    })
    .join("");
  const ticks = [];
  for (let v = Math.ceil(lo); v <= hi; v++) ticks.push(v);
  const grid = ticks
    .map((v) => `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" class="t-grid"/><text x="${L - 6}" y="${y(v) + 3.5}" class="t-ax" text-anchor="end">${v}</text>`)
    .join("");

  // Line, broken at periods without data
  let d = "";
  vals.forEach((v, i) => {
    if (v == null) return;
    d += `${i > 0 && vals[i - 1] != null ? "L" : "M"}${x(i)},${y(v)}`;
  });
  const pts = vals
    .map((v, i) => {
      if (v == null) return "";
      const sel = periods[i].id === selected;
      return `<circle cx="${x(i)}" cy="${y(v)}" r="${sel ? 6 : 4}" fill="${classOf(v)?.color ?? "#888"}" class="t-pt${sel ? " sel" : ""}"/>`;
    })
    .join("");
  const xl = periods
    .map((pp, i) => {
      const st = p.series?.[pp.id]?.status ?? "Tidak ada data";
      const sel = pp.id === selected;
      return `<text x="${x(i)}" y="${H - B + 14}" text-anchor="middle" class="t-ax${sel ? " sel" : ""}">${shortLabel(pp)}</text>
        <circle cx="${x(i)}" cy="${H - B + 23}" r="3.5" fill="${STATUS_COLOR[st]}"/>`;
    })
    .join("");
  const step = periods.length > 1 ? (W - L - R) / (periods.length - 1) : W - L - R;
  const hits = periods
    .map((_, i) => `<rect x="${x(i) - step / 2}" y="0" width="${step}" height="${H}" fill="transparent" data-i="${i}" class="t-hit"/>`)
    .join("");

  el.innerHTML = `
    <svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="Tren NDDI rata-rata ${p.name}">
      ${bands}${grid}
      <line x1="${L}" x2="${W - R}" y1="${y(lo)}" y2="${y(lo)}" class="t-base"/>
      <path d="${d}" class="t-line"/>
      ${pts}${xl}${hits}
    </svg>
    <div class="tl-tip" hidden></div>`;
  const tip = el.querySelector<HTMLElement>(".tl-tip")!;
  el.querySelectorAll<SVGRectElement>(".t-hit").forEach((r) => {
    const i = Number(r.dataset.i);
    const pp = periods[i], s = p.series?.[pp.id];
    r.addEventListener("click", () => onPick(pp.id));
    r.addEventListener("mouseenter", () => {
      const v = vals[i];
      const box = r.getBoundingClientRect();
      const svgBox = el.querySelector("svg")!.getBoundingClientRect();
      const py = v == null ? box.top + 10 : svgBox.top + (y(v) / H) * svgBox.height;
      tipAt(tip, el, new DOMRect(box.left, py - 6, box.width, 0),
        `<b>${pp.label}</b><br>NDDI ${fmt(v, 2)}${v != null ? ` (${classOf(v)?.label})` : ""}<br>${s?.status ?? "-"} · ${fmt(s?.ha_at_risk)} ha berisiko · peringkat ${s?.rank ?? "-"}`);
    });
    r.addEventListener("mouseleave", () => (tip.hidden = true));
  });
}
