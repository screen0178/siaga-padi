// v2 1.3: how old is each input? Satellite data always lags, so the age of the
// latest scene is shown next to "today" everywhere it matters.
import type { Forecast, Meta, Weather } from "./types";

export type Level = "ok" | "old" | "stale";

const BULAN = ["Jan", "Feb", "Mar", "Apr", "Mei", "Jun", "Jul", "Agu", "Sep", "Okt", "Nov", "Des"];
export const dayMonth = (iso: string) => `${Number(iso.slice(8, 10))} ${BULAN[Number(iso.slice(5, 7)) - 1]}`;

/** Latest Landsat scene over all periods (YYYY-MM-DD), or null. */
export function latestScene(meta: Meta): string | null {
  const all = [
    ...((meta.source.scenes as string[] | undefined) ?? []),
    ...(meta.periods ?? []).flatMap((p) => p.source.scenes ?? []),
  ];
  return all.length ? all.sort().at(-1)! : null;
}

/** Whole days from an ISO date to today (local midnight to midnight). */
export function daysSince(isoDate: string, now = new Date()) {
  const a = new Date(`${isoDate.slice(0, 10)}T00:00:00`);
  const b = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((b.getTime() - a.getTime()) / 864e5);
}

const hoursSince = (iso: string) => (Date.now() - new Date(iso).getTime()) / 3.6e6;

// Landsat 8+9 together pass every 8 days; clouds often cost one or two passes.
// Older than two Landsat-9 cycles (32 d) means the map no longer shows this season.
const sceneLevel = (d: number): Level => (d <= 16 ? "ok" : d <= 32 ? "old" : "stale");
// Weather refreshes every 6 h on the server
const rainLevel = (h: number): Level => (h <= 12 ? "ok" : h <= 36 ? "old" : "stale");

const agoDays = (d: number) => (d <= 0 ? "hari ini" : d === 1 ? "kemarin" : `${d} hari lalu`);
function agoHours(h: number) {
  if (h < 1) return `${Math.max(1, Math.round(h * 60))} menit lalu`;
  if (h < 48) return `${Math.round(h)} jam lalu`;
  return `${Math.round(h / 24)} hari lalu`;
}

export interface Fresh { key: string; label: string; value: string; level: Level; title: string }

export function freshness(meta: Meta, weather: Weather | null, forecast: Forecast | null = null): Fresh[] {
  const out: Fresh[] = [];
  const s = latestScene(meta);
  if (s) {
    const d = daysSince(s);
    out.push({
      key: "scene", label: "Citra", value: `${dayMonth(s)} · ${d <= 0 ? "hari ini" : `${d} hari`}`, level: sceneLevel(d),
      title: `Citra Landsat terakhir ${dayMonth(s)} (${agoDays(d)}). Peta menunjukkan kondisi pada tanggal itu, bukan hari ini. Hijau ≤ 16 hari, kuning ≤ 32 hari, merah lebih lama. Diolah ${new Date(meta.generated_at).toLocaleString("id-ID", { dateStyle: "medium", timeStyle: "short" })}.`,
    });
  }
  if (weather) {
    const h = hoursSince(weather.generated_at);
    out.push({
      key: "rain", label: "Hujan", value: agoHours(h).replace(" lalu", ""), level: rainLevel(h),
      title: `Data hujan (${weather.source}) diperbarui ${agoHours(h)}. Hijau ≤ 12 jam, kuning ≤ 36 jam, merah lebih lama.`,
    });
  }
  if (forecast) {
    const h = hoursSince(forecast.generated_at);
    out.push({
      key: "forecast", label: "Model", value: agoHours(h).replace(" lalu", ""), level: rainLevel(h),
      title: `Prakiraan model dihitung ${agoHours(h)} (dijalankan setelah data hujan diperbarui), dari citra sampai ${forecast.latest_obs ? dayMonth(forecast.latest_obs) : "-"}.`,
    });
  }
  return out;
}

export function renderFresh(el: HTMLElement, items: Fresh[]) {
  el.hidden = !items.length;
  el.innerHTML = items
    .map((f) => `<span class="fr ${f.level}" title="${f.title.replace(/"/g, "&quot;")}"><i></i><span class="k">${f.label}</span> ${f.value}</span>`)
    .join("");
}
