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
  /** v2 Phase 3: ha_at_risk x capacity_factor; the ranking key. */
  priority?: number;
  capacity_factor?: number;
  water_source?: "irigasi" | "tadah hujan" | "campuran" | null;
  status: Status;
  class_ha: Record<string, number>;
  stage_ha: Record<string, number>;
  stressed_stage_ha: Record<string, number>;
  action: Action | null;
  rank: number;
  /** Stage 1: per-period stats + scoring, keyed by Period.id (optional). */
  series?: Record<string, PeriodStats>;
  /** v2 Phase 3: official 2024 irrigation + 2026 dry-season satellite proxy (static). */
  water?: Water;
}

export interface Water {
  irrigated_ha: number;
  rainfed_ha: number;
  sawah_ha: number;
  irrigated_share: number;
  rice3x_share: number;
  dry_green_share?: number;
}

/** The per-period part of KecProps (everything that changes over time). */
export type PeriodStats = Omit<KecProps, "id" | "name" | "area_ha" | "n_desa" | "label_lon" | "label_lat" | "series" | "water">;

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
  "8": "#b07cc6",
  "9": "#e0602b",
  "10": "#d9468f",
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

// ---------------------------------------------------------------- Stage 3
/** feedback.json (pipeline/feedback.py via gee_export.py), optional. */
export interface MapView {
  cropland_ha: number;
  active_ha: number;
  stressed_share: number | null;
  inactive_share: number | null;
  excluded_ha: number;
}
export interface Feedback {
  generated_at: string;
  n_reports: number;
  rules: { exclude_min_reports: number; exclude_share: number; stressed_share: number; inactive_share: number };
  excluded_desa: { desa_id: string; name: string; kec_id: string; not_rice: number; reports: number }[];
  check: {
    summary: Record<string, { label: string; n: number; agree: number; judged: number }>;
    reports: { id: number; period_id: string; kec_id: string; desa_id: string | null; answer: string; agrees: boolean | null; map: MapView }[];
  };
}

/** forecast.json (pipeline/forecast.py, v2 Phase 2), optional. */
export interface ForecastStep { id: string; label: string; date: string; days: number }
export interface ForecastReason { group: string; pp: number; up: boolean; text: string }
export interface KecForecastStep {
  share: [number, number, number];   // P10, P50, P90 of Kuat+Ekstrem share of active rice
  ha: [number, number, number];
  hazard: [number, number, number];
  status: Status;
  status_range: [Status, Status];
  confidence: "Tinggi" | "Sedang" | "Rendah";
  coverage: number;
  h_days: [number, number];
  rain_win_mm: number;
  reasons: ForecastReason[];
}
export interface ModelMetrics {
  desa: { n: number; mae_share: Record<string, number>; coverage_p10_p90: number; mean_width_p10_p90: number };
  kecamatan: {
    n: number; mae_ha: Record<string, number>; coverage_p10_p90: number;
    status_match: Record<string, number>;
    siaga_or_awas: Record<string, { events: number; hit_rate: number | null; false_alarm_ratio: number | null }>;
  };
}
export interface Forecast {
  generated_at: string;
  today: string;
  steps: ForecastStep[];
  latest_obs: string | null;
  desa_used: number;
  rain_source: string;
  model: {
    run_id: string; trained_at: string; kind: string;
    data: { dates: number; first: string; last: string; desa: number };
    horizon_days: [number, number];
    n_pairs: Record<string, number>;
    test_period: [string, string];
    test: ModelMetrics;
    test_rain_climatology: ModelMetrics;
    test_by_horizon: Record<string, { n: number; mae_model: number; mae_persistence: number }>;
    group_importance: Record<string, number>;
  };
  totals: Record<string, { ha: [number, number, number]; status_count: Record<string, number> }>;
  kecamatan: Record<string, { name: string; obs_dates: string[]; steps: Record<string, KecForecastStep> }>;
}
