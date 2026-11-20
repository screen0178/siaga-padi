# SIAGA-Padi drought forecast, run 20261120-1302

Predicts, for one desa observed by Landsat on d0, the share of active rice in
Kuat+Ekstrem NDDI (and the hazard index H) on d1 = d0 + h, h = 8-40 days,
as P10 / P50 / P90. Gradient-boosted trees with quantile loss (scikit-learn).

## Data
- Landsat 8/9 TOA C2, 631 acquisition dates 2013-04-14 .. 2026-11-04,
  396 desa; same masks as the map (ESA cropland, NDVI stages 2-4 active).
- Rain: Open-Meteo archive (ERA5-based), daily, at each kecamatan's label point.
- Static: official irrigated / rice-3x share 2024 (kecamatan), SRTM elevation.
- Pairs: 79,399 train, 45,431 validation, 91,614 test.

## Split
Train d1 <= 2022, validation 2023 (chooses 400 trees, then joins
training), test d0 >= 2024 (2024-01-06 .. 2026-11-04). Never random.

## Test results (held-out years)
| | model | persistence | climatology |
|---|---|---|---|
| MAE share, desa | 0.068 | 0.085 | 0.099 |
| MAE ha Kuat+Ekstrem, kecamatan | 89 | 124 | 143 |
| Status matches | 89 % | 85 % | |
| Siaga/Awas hit rate | 77 % | 58 % | |
| Siaga/Awas false alarm ratio | 10 % | 16 % | |

P10-P90 coverage: desa 84 %, kecamatan 90 %
(target 80 %; kecamatan bands add desa quantiles, which assumes desa move together).

With future rain replaced by climatology (what the model gets without a
skilful rain forecast): MAE share 0.071, kecamatan MAE
97 ha.

## Limitations
- Single-date stages (not the map's 4-month trajectory): harvest and fallow
  fields are not separated, so the model forecasts the share, and the app
  applies it to the map's active area.
- Rain at one point per kecamatan from a reanalysis; at run time a forecast.
- Kuat+Ekstrem is an NDDI class, not observed crop loss.
