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
  /** Cropland ha per growth stage incl. non-active ("6" bera, "7" panen). */
  cropland_stage_ha?: Record<string, number>;
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

export interface Totals {
  class_ha: Record<string, number>;
  active_ha: number;
  cropland_stage_ha?: Record<string, number>;
}

export interface Period {
  id: string;
  start: string;
  end: string; // exclusive
  label: string;
  layers_dir: string;
  source: { scenes?: string[] } & Record<string, unknown>;
  totals: Totals;
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
  totals: Totals;
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
  "6": "#5b6170",
  "7": "#d4b483",
};

// ---------------------------------------------------------------- Stage 2
/** weather.json (pipeline/weather.py), optional. */
export interface Dasarian {
  id: string;
  start: string;
  end: string; // exclusive
  label: string;
  obs_mm: number;
  fc_mm: number;
  obs_days: number;
  fc_days: number;
  days: number;
  complete: boolean;
}

export interface KecWeather {
  dasarian: Dasarian[];
  hth: number;
  hth_class: string;
  obs_30d_mm: number;
  fc_mm: number;
  fc_days: number;
  fc_rain_days: number;
}

export interface Weather {
  generated_at: string;
  today: string;
  source: string;
  dry_day_mm: number;
  dry_dasarian_mm: number;
  kecamatan: Record<string, KecWeather>;
}

/** scenario.json (pipeline/scenario.py), optional. Keyed by N dasarian. */
export type ScenarioStats = Pick<KecProps,
  "active_ha" | "hazard_index" | "ha_at_risk" | "status" | "class_ha" | "stage_ha" | "stressed_stage_ha" | "action" | "rank">;

export interface ScenarioMonth {
  pair: string;
  rain_mm: number;
  kec_mae_ha: number;
  kec_bias_ha: number;
  persist_mae_ha: number;
  kec_mean_ha: number;
}

export interface Scenario {
  generated_at: string;
  period_id: string;
  max_dasarian: number;
  method: string;
  calibration: { rain_max_mm: number; months: ScenarioMonth[] };
  totals: Record<string, { class_ha: Record<string, number>; active_ha: number; ha_at_risk: number }>;
  kecamatan: Record<string, Record<string, ScenarioStats>>;
}
