/**
 * @fileoverview Raw OpenAQ v3 response types, mirroring the live API payloads
 * (probed 2026-06-13). These intentionally track upstream sparsity: timestamps
 * are `{utc, local}` objects (not strings), `distance` is nullable, summary `sd`
 * is nullable, `displayName` is nullable, and `meta.found` is `number | string`
 * (e.g. `">2"` when more pages exist). Tool handlers reshape/join these into the
 * narrower domain output schemas.
 * @module services/openaq/types
 */

/** UTC + local timestamp pair returned by the locations/sensors endpoints. */
export interface OpenAqDatetime {
  local: string;
  utc: string;
}

/** List-endpoint envelope. `found` may be a string like `">2"` when more pages exist. */
export interface OpenAqMeta {
  found?: number | string;
  limit?: number;
  page?: number;
}

/** Generic `{ meta, results }` envelope wrapping every list endpoint. */
export interface OpenAqListResponse<T> {
  meta?: OpenAqMeta;
  results: T[];
}

/** Country reference embedded in a location. */
export interface OpenAqCountryRef {
  code: string;
  id: number;
  name: string;
}

/** Provider / owner reference embedded in a location. */
export interface OpenAqNamedRef {
  id: number;
  name: string;
}

/** Parameter descriptor embedded in a sensor or measurement. `displayName` is nullable. */
export interface OpenAqParameterRef {
  displayName: string | null;
  id: number;
  name: string;
  units: string;
}

/** Sensor on a location — one per measured parameter. The parameter→unit map. */
export interface OpenAqSensor {
  id: number;
  name: string;
  parameter: OpenAqParameterRef;
}

/** Latitude/longitude pair. Either side can be absent on sparse records. */
export interface OpenAqCoordinates {
  latitude: number | null;
  longitude: number | null;
}

/** A `/v3/locations` (list) or `/v3/locations/{id}` (detail) result. */
export interface OpenAqLocation {
  coordinates: OpenAqCoordinates | null;
  country: OpenAqCountryRef | null;
  datetimeFirst: OpenAqDatetime | null;
  datetimeLast: OpenAqDatetime | null;
  /** Metres from the query point. Present on bbox/iso queries too, but `null` (no center point). */
  distance: number | null;
  id: number;
  instruments?: OpenAqNamedRef[];
  isMobile: boolean;
  isMonitor: boolean;
  locality: string | null;
  name: string | null;
  owner?: OpenAqNamedRef | null;
  provider: OpenAqNamedRef | null;
  sensors: OpenAqSensor[];
  timezone: string | null;
}

/** A `/v3/locations/{id}/latest` result — keyed by `sensorsId`, NO parameter/unit inline. */
export interface OpenAqLatest {
  coordinates: OpenAqCoordinates | null;
  datetime: OpenAqDatetime;
  locationsId: number;
  sensorsId: number;
  value: number;
}

/** Coverage block on a measurement row. */
export interface OpenAqCoverage {
  datetimeFrom?: OpenAqDatetime;
  datetimeTo?: OpenAqDatetime;
  expectedCount?: number;
  observedCount?: number;
  percentComplete?: number | null;
}

/** Period block on a measurement row — carries the bucket boundaries. */
export interface OpenAqPeriod {
  datetimeFrom: OpenAqDatetime;
  datetimeTo: OpenAqDatetime;
  interval?: string;
  label: string;
}

/** Per-bucket statistical summary on hourly/daily rollups. `sd` is null for single-reading buckets. */
export interface OpenAqSummary {
  avg?: number;
  max?: number;
  median?: number;
  min?: number;
  q02?: number;
  q25?: number;
  q75?: number;
  q98?: number;
  sd?: number | null;
}

/** A `/v3/sensors/{id}/measurements[/hourly|/daily]` row. Unit IS inline here (unlike /latest). */
export interface OpenAqMeasurement {
  coverage?: OpenAqCoverage;
  flagInfo?: { hasFlags?: boolean };
  parameter: OpenAqParameterRef;
  period: OpenAqPeriod;
  summary?: OpenAqSummary;
  value: number;
}

/** A `/v3/parameters` catalog row. */
export interface OpenAqParameter {
  description: string | null;
  displayName: string | null;
  id: number;
  name: string;
  units: string;
}

/** A `/v3/countries` catalog row — datetimes are plain ISO strings here (NOT {utc,local}). */
export interface OpenAqCountry {
  code: string;
  datetimeFirst: string | null;
  datetimeLast: string | null;
  id: number;
  name: string;
  parameters: OpenAqParameterRef[];
}

/** Aggregation mode for the measurements endpoints. */
export type OpenAqAggregation = 'raw' | 'hourly' | 'daily';
