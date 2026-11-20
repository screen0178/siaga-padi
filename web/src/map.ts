import maplibregl, { type Map as MLMap } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import type { KecFeature, Meta } from "./types";
import { STATUS_COLOR } from "./types";

// Esri Dark Gray Canvas: keyless raster tiles (CARTO now needs an API key and
// serves a watermark otherwise). Note Esri's {z}/{y}/{x} order.
const BASEMAP = "https://services.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}";
const BASEMAP_ATTRIBUTION = "Tiles © Esri — Esri, HERE, Garmin, © OpenStreetMap contributors";

export interface MapApi {
  map: MLMap;
  setLayer(id: string): Promise<void>;
  setOpacity(v: number): void;
  /** Switch raster folder (null = top-level layers/) and redraw kecamatan
   *  styling from the (already mutated) feature properties. */
  setPeriod(layersDir: string | null): Promise<void>;
  /** Redraw kecamatan styling from mutated feature properties (scenario). */
  refresh(): void;
  select(id: string | null, fly?: boolean): void;
  /** v2 5.2: NDDI anomaly z per desa for the "anomaly" layer (null = none). */
  setDesaValues(values: Record<string, number> | null): void;
  onSelect(cb: (id: string) => void): void;
}

/** Probe whether remote basemap tiles are reachable (they are blocked in
 *  sandboxed previews); fall back to the offline village-outline basemap. */
function probeTile(): Promise<boolean> {
  return new Promise((res) => {
    const img = new Image();
    const t = setTimeout(() => res(false), 2500);
    img.onload = () => { clearTimeout(t); res(true); };
    img.onerror = () => { clearTimeout(t); res(false); };
    img.src = BASEMAP.replace("{z}/{y}/{x}", "10/533/827");
  });
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((res, rej) => {
    const img = new Image();
    img.onload = () => res(img);
    img.onerror = rej;
    img.src = src;
  });
}

export async function createMap(
  el: HTMLElement,
  meta: Meta,
  kec: GeoJSON.FeatureCollection,
  desa: GeoJSON.FeatureCollection,
  dataBase: string,
): Promise<MapApi> {
  const [w, s, e, n] = meta.bounds;
  const online = await probeTile();

  const map = new maplibregl.Map({
    container: el,
    style: {
      version: 8,
      sources: online
        ? { basemap: { type: "raster", tiles: [BASEMAP], tileSize: 256, maxzoom: 16, attribution: BASEMAP_ATTRIBUTION } }
        : {},
      layers: [
        { id: "bg", type: "background", paint: { "background-color": "#0e1116" } },
        ...(online ? [{ id: "basemap", type: "raster" as const, source: "basemap", paint: { "raster-opacity": 0.9 } }] : []),
      ],
    },
    bounds: [[w, s], [e, n]],
    fitBoundsOptions: { padding: { top: 70, bottom: 120, left: 380, right: 40 } },
    attributionControl: { compact: true },
    maxZoom: 15,
  });
  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "bottom-right");
  await new Promise<void>((r) => map.on("load", () => r()));

  map.addSource("desa", { type: "geojson", data: desa, promoteId: "id" });
  map.addSource("kec", { type: "geojson", data: kec, promoteId: "id" });

  map.addLayer({
    id: "kec-base", type: "fill", source: "kec",
    paint: { "fill-color": "#161b23", "fill-opacity": online ? 0 : 1 },
  });
  map.addLayer({
    id: "desa-line", type: "line", source: "desa",
    paint: { "line-color": "#2a313d", "line-width": 0.5 },
  });

  const statusMatch: maplibregl.ExpressionSpecification = [
    "match", ["get", "status"],
    ...Object.entries(STATUS_COLOR).flat(),
    "#5b6170",
  ] as unknown as maplibregl.ExpressionSpecification;

  map.addLayer({
    id: "kec-status", type: "fill", source: "kec",
    paint: {
      "fill-color": statusMatch,
      "fill-opacity": ["case", ["boolean", ["feature-state", "hover"], false], 0.72, 0.55],
    },
  });
  // v2 5.2: desa choropleth of the NDDI anomaly (z), driven by feature-state
  map.addLayer({
    id: "desa-anom", type: "fill", source: "desa",
    layout: { visibility: "none" },
    paint: {
      "fill-color": ["interpolate", ["linear"], ["coalesce", ["feature-state", "z"], 0],
        -2, "#2b6cb0", -1, "#7fb3d5", -0.4, "#3a4150", 0.4, "#3a4150", 1, "#f4a261", 2, "#d64545", 3, "#8b0a1a"],
      "fill-opacity": ["case", ["==", ["feature-state", "z"], null], 0, 0.8],
    },
  });
  map.addLayer({
    id: "kec-line", type: "line", source: "kec",
    paint: { "line-color": "#c9d1dc", "line-opacity": 0.55, "line-width": 1 },
  });
  map.addLayer({
    id: "kec-hover", type: "line", source: "kec",
    paint: {
      "line-color": "#ffffff",
      "line-width": ["case", ["boolean", ["feature-state", "hover"], false], 2, 0],
    },
  });
  map.addLayer({
    id: "kec-selected", type: "line", source: "kec",
    filter: ["==", ["get", "id"], ""],
    paint: { "line-color": "#ffffff", "line-width": 3 },
  });

  // Labels as HTML markers (no glyph server needed offline)
  for (const f of kec.features as unknown as KecFeature[]) {
    const p = f.properties;
    const m = document.createElement("div");
    m.className = "kec-label";
    m.textContent = p.name;
    new maplibregl.Marker({ element: m }).setLngLat([p.label_lon, p.label_lat]).addTo(map);
  }

  // Raster overlay via a canvas source (works without network fetch)
  let opacity = 0.9;
  let current = "status";
  let layersDir: string | null = null;
  const imgCache = new Map<string, HTMLImageElement>();

  let desaIds: string[] = [];
  function setDesaValues(values: Record<string, number> | null) {
    for (const id of desaIds) map.removeFeatureState({ source: "desa", id }, "z");
    desaIds = values ? Object.keys(values) : [];
    for (const id of desaIds) map.setFeatureState({ source: "desa", id }, { z: values![id] });
  }

  async function setLayer(id: string) {
    current = id;
    const dir = layersDir;
    map.setLayoutProperty("desa-anom", "visibility", id === "anomaly" ? "visible" : "none");
    if (id === "status" || id === "anomaly") {
      if (map.getLayer("overlay")) map.removeLayer("overlay");
      if (map.getSource("overlay")) map.removeSource("overlay");
    }
    map.setPaintProperty("kec-status", "fill-opacity",
      id === "status"
        ? ["case", ["boolean", ["feature-state", "hover"], false], 0.72, 0.55]
        : ["case", ["boolean", ["feature-state", "hover"], false], 0.12, 0]);
    if (id === "status" || id === "anomaly") return;

    const def = meta.layers.find((l) => l.id === id);
    if (!def) return;
    const src = dir ? `${dataBase}/${dir}/${def.file.split("/").pop()}` : `${dataBase}/${def.file}`;
    let img = imgCache.get(src);
    if (!img) {
      img = await loadImage(src);
      imgCache.set(src, img);
    }
    if (current !== id || layersDir !== dir) return; // user switched while loading
    // Swap after the new image is ready, so the map never flashes empty
    if (map.getLayer("overlay")) map.removeLayer("overlay");
    if (map.getSource("overlay")) map.removeSource("overlay");
    const canvas = document.createElement("canvas");
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const ctx = canvas.getContext("2d")!;
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(img, 0, 0);
    map.addSource("overlay", {
      type: "canvas", canvas, animate: false,
      coordinates: [[w, n], [e, n], [e, s], [w, s]],
    });
    map.addLayer({
      id: "overlay", type: "raster", source: "overlay",
      paint: { "raster-opacity": opacity, "raster-resampling": "nearest", "raster-fade-duration": 0 },
    }, "kec-line");
  }

  async function setPeriod(dir: string | null) {
    layersDir = dir;
    (map.getSource("kec") as maplibregl.GeoJSONSource).setData(kec);
    if (current !== "status") await setLayer(current);
  }

  function refresh() {
    (map.getSource("kec") as maplibregl.GeoJSONSource).setData(kec);
  }

  function setOpacity(v: number) {
    opacity = v;
    if (map.getLayer("overlay")) map.setPaintProperty("overlay", "raster-opacity", v);
  }

  // Hover + click
  let hovered: string | null = null;
  const tip = document.createElement("div");
  tip.className = "map-tip";
  el.appendChild(tip);

  map.on("mousemove", "kec-status", (ev) => {
    const f = ev.features?.[0];
    if (!f) return;
    const id = f.properties.id as string;
    if (hovered !== id) {
      if (hovered) map.setFeatureState({ source: "kec", id: hovered }, { hover: false });
      hovered = id;
      map.setFeatureState({ source: "kec", id }, { hover: true });
    }
    const p = f.properties as Record<string, unknown>;
    const nddi = typeof p.mean_nddi === "number" ? (p.mean_nddi as number).toFixed(2) : "-";
    tip.innerHTML = `<b>${p.name}</b><span class="tip-status" style="--c:${STATUS_COLOR[p.status as string]}">${p.status}</span><br>NDDI rata-rata ${nddi} · ${Math.round(p.ha_at_risk as number).toLocaleString("id-ID")} ha berisiko`;
    tip.style.display = "block";
    tip.style.left = `${ev.point.x + 14}px`;
    tip.style.top = `${ev.point.y + 14}px`;
    map.getCanvas().style.cursor = "pointer";
  });
  map.on("mouseleave", "kec-status", () => {
    if (hovered) map.setFeatureState({ source: "kec", id: hovered }, { hover: false });
    hovered = null;
    tip.style.display = "none";
    map.getCanvas().style.cursor = "";
  });

  const selectCbs: ((id: string) => void)[] = [];
  map.on("click", "kec-status", (ev) => {
    const id = ev.features?.[0]?.properties.id as string | undefined;
    if (id) selectCbs.forEach((cb) => cb(id));
  });

  function select(id: string | null, fly = false) {
    map.setFilter("kec-selected", ["==", ["get", "id"], id ?? ""]);
    if (id && fly) {
      const f = (kec.features as unknown as KecFeature[]).find((x) => x.properties.id === id);
      if (f) {
        const b = new maplibregl.LngLatBounds();
        const walk = (c: unknown): void => {
          if (Array.isArray(c) && typeof c[0] === "number") b.extend(c as [number, number]);
          else if (Array.isArray(c)) c.forEach(walk);
        };
        walk((f.geometry as GeoJSON.Polygon).coordinates);
        map.fitBounds(b, { padding: { top: 90, bottom: 140, left: 400, right: 460 }, duration: 900, maxZoom: 12.5 });
      }
    }
  }

  return { map, setLayer, setOpacity, setPeriod, refresh, select, setDesaValues, onSelect: (cb) => selectCbs.push(cb) };
}
