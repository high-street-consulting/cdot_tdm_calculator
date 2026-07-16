// Shared types for the strategy port.

export interface TazInputs {
  taz_id: string;
  // Core activity / geometry
  daily_vmt: number;
  daily_trips?: number | null;
  avg_trip_length?: number | null;
  population?: number | null;
  employment?: number | null;
  households?: number | null;
  area_sqmi?: number | null;
  pop_density?: number | null;
  emp_density?: number | null;
  activity_density?: number | null;
  area_type?: "urban_core" | "urban" | "suburban" | "rural" | string;
  // ACS commute mode share (B08301). Null if no coverage.
  acs_total_workers?: number | null;
  acs_drove_alone_share?: number | null;
  acs_carpool_share?: number | null;
  acs_transit_share?: number | null;
  acs_bike_share?: number | null;
  acs_walk_share?: number | null;
  // NOAA bikeable days
  annual_bikeable_days_taz?: number | null;
  annual_bikeable_days_county?: number | null;
  // Lane miles by facility class
  lane_mi_freeway?: number | null;
  lane_mi_expressway?: number | null;
  lane_mi_major_arterial?: number | null;
  lane_mi_minor_arterial?: number | null;
  lane_mi_collector?: number | null;
  lane_mi_local?: number | null;
  // Transit service + bike network (parent-gate fields, e.g. wayfinding).
  transit_vrh?: number | null;
  transit_route_count?: number | null;
  bike_centerline_mi?: number | null;
  // Observed average vehicle occupancy (TDM model); getAvo prefers it.
  avo?: number | null;
  // Observed VMT-purpose split (baseVmt prefers these where present).
  vmt_share_commute?: number | null;
  vmt_share_recreational?: number | null;
  vmt_share_other?: number | null;
  // Park-and-Ride observed inputs (TDM model trip length + drive-to-transit access).
  tdm_avg_trip_length_mi?: number | null;
  drive_to_transit_share?: number | null;
  [extra: string]: unknown;
}

export type TripPurpose = "all" | "commute" | "recreational" | "other";

export interface StrategyResult {
  taz_id: string;
  strategy: string;
  inputs: string;            // Human-readable kwargs (debugging)
  base_vmt_purpose: TripPurpose;
  base_vmt: number;
  pct_vmt_reduction: number; // <0 = reduction, >0 = increase
  daily_vmt_reduction: number;
  data_assumptions: string;  // Semicolon-separated flags; "" when no defaults used
}

export type StrategyFn<Args extends object = Record<string, unknown>> = (
  taz: TazInputs,
  args: Args,
) => StrategyResult;
