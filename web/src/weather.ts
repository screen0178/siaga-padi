// Stage 2: rainfall per dasarian (observed + forecast) and the per-kecamatan
// "no rain for N dasarian" curve.
import { STATUS_COLOR, type KecWeather, type Scenario, type Status } from "./types";

const fmt = (n: number | null | undefined, d = 0) =>
  n == null ? "-" : n.toLocaleString("id-ID", { maximumFractionDigits: d, minimumFractionDigits: d });

const RAIN = "#5bb0d9";

/** 1, 2, 2.5 or 5 x 10^k, giving about `n` intervals up to `max`. */
function niceStep(max: number, n = 4) {
  const raw = max / n, k = 10 ** Math.floor(Math.log10(raw));
  return ([1, 2, 2.5, 5, 10].find((m) => m * k >= raw) ?? 10) * k;
}

function tipAt(tip: HTMLElement, host: HTMLElement, x: number, y: number, html: string) {
  const h = host.getBoundingClientRect();
  tip.innerHTML = html;
  tip.hidden = false;
  tip.style.left = `${Math.max(tip.offsetWidth / 2, Math.min(h.width - tip.offsetWidth / 2, x - h.left))}px`;
  tip.style.top = `${y - h.top - 6}px`;
}

/** Bars per dasarian: observed solid, forecast hatched, BMKG 50 mm line. */
export function renderRain(el: HTMLElement, w: KecWeather, dryMm: number, today: string) {
  const das = w.dasarian;
  const W = 364, H = 132, L = 30, R = 8, T = 14, B = 32;
  const max = Math.max(dryMm * 1.25, ...das.map((d) => d.obs_mm + d.fc_mm)) * 1.08;
  const slot = (W - L - R) / das.length;
  const bw = Math.min(26, slot - 8);
  const y = (v: number) => T + (H - T - B) * (1 - v / max);
  const step = niceStep(max);
  const ticks: number[] = [];
  for (let v = 0; v <= max; v += step) ticks.push(v);

  const bars = das
    .map((d, i) => {
      const cx = L + slot * (i + 0.5), x0 = cx - bw / 2;
      const yo = y(d.obs_mm), yf = y(d.obs_mm + d.fc_mm);
      const total = d.obs_mm + d.fc_mm;
      const r = Math.min(4, bw / 2);
      // Rounded top on whichever segment is on top
      const seg = (top: number, bottom: number, fill: string, rounded: boolean) => {
        const h = bottom - top;
        if (h <= 0.3) return "";
        if (!rounded || h < r) return `<rect x="${x0}" y="${top}" width="${bw}" height="${h}" fill="${fill}"/>`;
        return `<path d="M${x0},${bottom}V${top + r}Q${x0},${top} ${x0 + r},${top}H${x0 + bw - r}Q${x0 + bw},${top} ${x0 + bw},${top + r}V${bottom}Z" fill="${fill}"/>`;
      };
      const gap = d.fc_mm > 0 && d.obs_mm > 0 ? 2 : 0;
      return `${seg(yo, y(0), RAIN, d.fc_mm <= 0)}${seg(yf, yo - gap, "url(#hatch)", true)}
        <text x="${cx}" y="${yf - 4}" text-anchor="middle" class="t-ax">${fmt(total)}</text>
        <text x="${cx}" y="${H - B + 13}" text-anchor="middle" class="t-ax${d.start <= today && today < d.end ? " sel" : ""}">${d.label.split(" ")[1]}${d.complete ? "" : "*"}</text>
        ${i === 0 || d.start.slice(5, 7) !== das[i - 1].start.slice(5, 7) ? `<text x="${cx - slot / 2 + 2}" y="${H - B + 26}" class="t-band">${d.label.split(" ")[0]}</text>` : ""}`;
    })
    .join("");
  const grid = ticks
    .map((v) => `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" class="t-grid"/><text x="${L - 6}" y="${y(v) + 3.5}" class="t-ax" text-anchor="end">${v}</text>`)
    .join("");
  const hits = das
    .map((_, i) => `<rect x="${L + slot * i}" y="0" width="${slot}" height="${H}" fill="transparent" data-i="${i}" class="t-hit"/>`)
    .join("");

  el.innerHTML = `
    <svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="Curah hujan per dasarian">
      <defs><pattern id="hatch" width="5" height="5" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
        <rect width="5" height="5" fill="${RAIN}" opacity="0.28"/><line x1="0" y1="0" x2="0" y2="5" stroke="${RAIN}" stroke-width="2"/></pattern></defs>
      ${grid}
      <line x1="${L}" x2="${W - R}" y1="${y(dryMm)}" y2="${y(dryMm)}" class="t-thr"/>
      <line x1="${L}" x2="${W - R}" y1="${y(0)}" y2="${y(0)}" class="t-base"/>
      ${bars}${hits}
    </svg>
    <div class="rain-key"><span><i style="background:${RAIN}"></i>Teramati</span><span><i class="hatch"></i>Prakiraan</span><span><i class="thr"></i>${dryMm} mm: batas dasarian kering (BMKG)</span><span class="muted">* dasarian belum lengkap</span></div>
    <div class="tl-tip" hidden></div>`;
  const tip = el.querySelector<HTMLElement>(".tl-tip")!;
  el.querySelectorAll<SVGRectElement>(".t-hit").forEach((r) => {
    const d = das[Number(r.dataset.i)];
    r.addEventListener("mouseenter", () => {
      const b = r.getBoundingClientRect();
      const parts = [
        d.obs_days ? `Teramati ${fmt(d.obs_mm, 1)} mm (${d.obs_days} hari)` : "",
        d.fc_days ? `Prakiraan ${fmt(d.fc_mm, 1)} mm (${d.fc_days} hari)` : "",
      ].filter(Boolean);
      tipAt(tip, el, b.left + b.width / 2, b.top + 12,
        `<b>Dasarian ${d.label}</b> (${d.start.slice(8)}–${String(Number(d.end.slice(8)) - 1 || "akhir")})<br>${parts.join("<br>")}${d.complete ? "" : `<br><span class="muted">${d.obs_days + d.fc_days} dari ${d.days} hari tersedia</span>`}`);
    });
    r.addEventListener("mouseleave", () => (tip.hidden = true));
  });
}

/** Ha at risk versus N dasarian without rain, dots coloured by status. */
export function renderScenarioCurve(
  el: HTMLElement, kecId: string, name: string, scen: Scenario, selected: number, onPick: (n: number) => void,
) {
  const s = scen.kecamatan[kecId];
  if (!s) { el.innerHTML = ""; return; }
  const ns = Array.from({ length: scen.max_dasarian + 1 }, (_, i) => i);
  const vals = ns.map((n) => s[String(n)].ha_at_risk);
  const W = 364, H = 118, L = 44, R = 10, T = 10, B = 30;
  const hi = Math.max(1, ...vals) * 1.12;
  const x = (n: number) => L + ((W - L - R) * n) / scen.max_dasarian;
  const y = (v: number) => T + (H - T - B) * (1 - v / hi);
  const tick = niceStep(hi, 4);
  const grid: string[] = [];
  for (let v = 0; v <= hi; v += tick)
    grid.push(`<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" class="t-grid"/><text x="${L - 6}" y="${y(v) + 3.5}" class="t-ax" text-anchor="end">${fmt(v)}</text>`);
  // Month boundaries of the replayed dry season
  const months = scen.calibration.months.map((_, k) => {
    const a = x(3 * k), b = x(3 * (k + 1));
    return `${k > 0 ? `<line x1="${a}" x2="${a}" y1="${T}" y2="${H - B}" class="t-grid"/>` : ""}
      <text x="${(a + b) / 2}" y="${H - 4}" text-anchor="middle" class="t-band">bulan kering ${k + 1}</text>`;
  });
  const d = vals.map((v, i) => `${i ? "L" : "M"}${x(i)},${y(v)}`).join("");
  const pts = ns
    .map((n) => {
      const st = s[String(n)].status as Status;
      const sel = n === selected;
      return `<circle cx="${x(n)}" cy="${y(vals[n])}" r="${sel ? 6 : 4}" fill="${STATUS_COLOR[st]}" class="t-pt${sel ? " sel" : ""}"/>`;
    })
    .join("");
  const xl = ns.map((n) => `<text x="${x(n)}" y="${H - B + 13}" text-anchor="middle" class="t-ax${n === selected ? " sel" : ""}">${n}</text>`).join("");
  const step = (W - L - R) / scen.max_dasarian;
  const hits = ns.map((n) => `<rect x="${x(n) - step / 2}" y="0" width="${step}" height="${H}" fill="transparent" data-n="${n}" class="t-hit"/>`).join("");

  el.innerHTML = `
    <svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="Ha berisiko ${name} jika tidak hujan 0 sampai ${scen.max_dasarian} dasarian">
      ${grid.join("")}${months.join("")}
      <line x1="${L}" x2="${W - R}" y1="${y(0)}" y2="${y(0)}" class="t-base"/>
      <path d="${d}" class="t-line"/>
      ${pts}${xl}${hits}
    </svg>
    <div class="tl-tip" hidden></div>`;
  const tip = el.querySelector<HTMLElement>(".tl-tip")!;
  const svg = el.querySelector("svg")!;
  el.querySelectorAll<SVGRectElement>(".t-hit").forEach((r) => {
    const n = Number(r.dataset.n), v = s[String(n)];
    r.addEventListener("click", () => onPick(n));
    r.addEventListener("mouseenter", () => {
      const b = r.getBoundingClientRect(), sb = svg.getBoundingClientRect();
      tipAt(tip, el, b.left + b.width / 2, sb.top + (y(vals[n]) / H) * sb.height - 6,
        `<b>${n === 0 ? "Kondisi teramati" : `Tanpa hujan ${n} dasarian (±${n * 10} hari)`}</b><br>${v.status} · ${fmt(v.ha_at_risk)} ha berisiko · peringkat ${v.rank}<br>Kuat–ekstrem ${fmt((v.class_ha["4"] ?? 0) + (v.class_ha["5"] ?? 0))} ha`);
    });
    r.addEventListener("mouseleave", () => (tip.hidden = true));
  });
}
