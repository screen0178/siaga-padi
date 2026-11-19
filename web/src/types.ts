// Mirrors pipeline/outputs.py (data contract v1)

export type Status = "Normal" | "Waspada" | "Siaga" | "Awas" | "Tidak ada data";

export interface Action {
  headline: string;
  steps: string[];
  urgency: string;
}

export interface KecProps {
  id: string;
  name: string;
  area_ha: number;
  n_desa: number;
  label_lon: number;
  label_lat: number;
  mean_nddi: number | null;
  mean_ndvi: number | null;
  mean_ndmi: number | null;
  cropland_ha: number | null;
  active_ha: number;
  hazard_index: number;
  ha_at_risk: number;
  status: Status;
  class_ha: Record<string, number>;
  stage_ha: Record<string, number>;
  stressed_stage_ha: Record<string, number>;
  action: Action | null;
  rank: number;
  /** Stage 1: per-period stats + scoring, keyed by Period.id (optional). */
  series?: Record<string, PeriodStats>;
}

/** The per-period part of KecProps (everything that changes over time). */
export type PeriodStats = Omit<KecProps, "id" | "name" | "area_ha" | "n_desa" | "label_lon" | "label_lat" | "series">;

export interface Period {
  id: string;
  start: string;
  end: string; // exclusive
  label: string;
  layers_dir: string;
  source: { scenes?: string[] } & Record<string, unknown>;
  totals: { class_ha: Record<string, number>; active_ha: number };
}

export interface KecFeature {
  type: "Feature";
  properties: KecProps;
  geometry: GeoJSON.Geometry;
}

export interface LegendClass {
  id: number;
  min: number | null;
  max: number | null;
  label: string;
  label_en?: string;
  color?: string;
  active?: boolean;
}

export interface LayerDef {
  id: string;
  file: string;
  label: string;
  legend: string;
}

export interface Meta {
  contract_version: number;
  mode: "placeholder" | "gee";
  generated_at: string;
  region: { id: string; name: string; province: string };
  period: { start: string; end: string; label: string };
  source: Record<string, unknown>;
  bounds: [number, number, number, number];
  layers: LayerDef[];
  nddi_classes: LegendClass[];
  stage_classes: LegendClass[];
  status_levels: Status[];
  totals: { class_ha: Record<string, number>; active_ha: number };
  notes: string[];
  /** Stage 1 time series (optional; absent in single-period data). */
  periods?: Period[];
  current_period?: string;
}

export const STATUS_COLOR: Record<string, string> = {
  Normal: "#3fb27f",
  Waspada: "#f2c94c",
  Siaga: "#f2994a",
  Awas: "#eb5757",
  "Tidak ada data": "#5b6170",
};

export const STAGE_COLOR: Record<string, string> = {
  "2": "#c7e9a0",
  "3": "#6cc04a",
  "4": "#f2c94c",
  "5": "#a0785a",
};
