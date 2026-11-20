// Legend under the layer bar: status, classes, ramps, and the anomaly scale.
import { STAGE_COLOR, STATUS_COLOR, type Anomaly, type Meta } from "./types";
import { BULAN_PANJANG } from "./util";

const RAMPS: Record<string, { stops: [number, string][]; label: string }> = {
  nddi_ramp: { label: "NDDI", stops: [[-1, "#2b83ba"], [0.7, "#abdda4"], [1.25, "#fdae61"], [3, "#e8553d"], [4, "#8b0a1a"]] },
  ndvi_ramp: { label: "NDVI", stops: [[0, "#8c5a2b"], [0.25, "#d9c36a"], [0.45, "#8fcf5a"], [0.7, "#1a7f37"]] },
  ndmi_ramp: { label: "NDMI", stops: [[-0.8, "#8c3b1a"], [-0.3, "#e0a050"], [0, "#f2efc7"], [0.3, "#5bb0d9"], [0.6, "#1f4e9c"]] },
};

export function drawLegend(el: HTMLElement, layerId: string, meta: Meta, anomaly: Anomaly | null, periodId: string | null) {
  if (layerId === "status") {
    el.innerHTML = meta.status_levels
      .map((s) => `<span class="sw"><i style="--c:${STATUS_COLOR[s]}"></i>${s}</span>`)
      .join("");
    return;
  }
  if (layerId === "anomaly") {
    const a = anomaly && periodId ? anomaly.periods[periodId] : undefined;
    const stops: [number, string][] = [[-2, "#2b6cb0"], [-1, "#7fb3d5"], [-0.4, "#3a4150"], [0.4, "#3a4150"], [1, "#f4a261"], [2, "#d64545"], [3, "#8b0a1a"]];
    const grad = stops.map(([v, c]) => `${c} ${(100 * (v + 2)) / 5}%`).join(",");
    el.innerHTML = `<span class="ramp-l">z NDDI</span><span class="ramp" style="background:linear-gradient(90deg,${grad})">${[-2, -1, 0, 1, 2, 3]
      .map((v) => `<em style="left:${(100 * (v + 2)) / 5}%">${v > 0 ? "+" : ""}${v}</em>`).join("")}</span>
      <span class="anom-key">← lebih basah · <b>lebih kering</b> → dari ${periodId ? BULAN_PANJANG[Number(periodId.slice(5, 7)) - 1] : "bulan ini"} ${anomaly!.baseline_years.join("–")}${a ? "" : " · tidak ada data bulan ini"}</span>`;
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
