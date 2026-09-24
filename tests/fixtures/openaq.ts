/**
 * @fileoverview Captured-shape OpenAQ v3 fixtures for unit tests. Mirror the real
 * live payloads (probed 2026-06-13): {utc,local} datetime objects, nullable
 * distance/sd/displayName, sensor→parameter map for the join, and a sparse case.
 * @module tests/fixtures/openaq
 */

import type {
  OpenAqCountry,
  OpenAqLatest,
  OpenAqLocation,
  OpenAqMeasurement,
  OpenAqParameter,
} from '@/services/openaq/types.js';

export const seattleLocation: OpenAqLocation = {
  id: 931,
  name: 'Seattle-10th & Weller',
  locality: 'Seattle-Tacoma-Bellevue',
  timezone: 'America/Los_Angeles',
  country: { id: 155, code: 'US', name: 'United States' },
  owner: { id: 4, name: 'Unknown Governmental Organization' },
  provider: { id: 119, name: 'AirNow' },
  isMobile: false,
  isMonitor: true,
  instruments: [{ id: 2, name: 'Government Monitor' }],
  sensors: [
    {
      id: 1701,
      name: 'pm25 µg/m³',
      parameter: { id: 2, name: 'pm25', units: 'µg/m³', displayName: 'PM2.5' },
    },
    { id: 1708, name: 'co ppm', parameter: { id: 8, name: 'co', units: 'ppm', displayName: 'CO' } },
  ],
  coordinates: { latitude: 47.5972, longitude: -122.3197 },
  distance: 1364.84,
  datetimeFirst: { utc: '2016-03-15T20:00:00Z', local: '2016-03-15T13:00:00-07:00' },
  datetimeLast: { utc: '2026-06-13T19:00:00Z', local: '2026-06-13T12:00:00-07:00' },
};

/** A sparse location from a bbox query — distance null, name null, displayName null, never reported. */
export const sparseLocation: OpenAqLocation = {
  id: 42,
  name: null,
  locality: null,
  timezone: null,
  country: { id: 1, code: 'IN', name: 'India' },
  provider: { id: 99, name: 'OpenAQ LCS' },
  isMobile: false,
  isMonitor: false,
  sensors: [
    {
      id: 7000,
      name: 'pm25',
      parameter: { id: 2, name: 'pm25', units: 'µg/m³', displayName: null },
    },
  ],
  coordinates: { latitude: 28.6, longitude: 77.2 },
  distance: null,
  datetimeFirst: null,
  datetimeLast: null,
};

/** Latest feed for station 931 — keyed by sensorsId, NO parameter/unit inline. */
export const seattleLatest: OpenAqLatest[] = [
  {
    datetime: { utc: '2026-06-13T19:00:00Z', local: '2026-06-13T12:00:00-07:00' },
    value: 3.4,
    coordinates: { latitude: 47.5972, longitude: -122.3197 },
    sensorsId: 1701,
    locationsId: 931,
  },
  {
    datetime: { utc: '2026-06-13T19:00:00Z', local: '2026-06-13T12:00:00-07:00' },
    value: 0.2,
    coordinates: { latitude: 47.5972, longitude: -122.3197 },
    sensorsId: 1708,
    locationsId: 931,
  },
];

/** A daily measurement bucket with a full summary (sd populated). */
export const dailyMeasurement: OpenAqMeasurement = {
  value: 7.89,
  parameter: { id: 2, name: 'pm25', units: 'µg/m³', displayName: null },
  period: {
    label: '1 day',
    interval: '24:00:00',
    datetimeFrom: { utc: '2026-05-01T07:00:00Z', local: '2026-05-01T00:00:00-07:00' },
    datetimeTo: { utc: '2026-05-02T07:00:00Z', local: '2026-05-02T00:00:00-07:00' },
  },
  summary: { min: 4.3, q25: 6, median: 7.85, q75: 9, max: 14.7, avg: 7.88, sd: 2.68 },
  coverage: { expectedCount: 24, observedCount: 24, percentComplete: 100 },
  flagInfo: { hasFlags: false },
};

/** A single-reading hourly bucket — summary.sd is null (the -32007 trap if declared required). */
export const singleReadingHourly: OpenAqMeasurement = {
  value: 5.1,
  parameter: { id: 2, name: 'pm25', units: 'µg/m³', displayName: null },
  period: {
    label: '1 hour',
    interval: '01:00:00',
    datetimeFrom: { utc: '2026-05-01T07:00:00Z', local: '2026-05-01T00:00:00-07:00' },
    datetimeTo: { utc: '2026-05-01T08:00:00Z', local: '2026-05-01T01:00:00-07:00' },
  },
  summary: { min: 5.1, median: 5.1, max: 5.1, avg: 5.1, sd: null },
  coverage: { expectedCount: 1, observedCount: 1, percentComplete: 100 },
  flagInfo: { hasFlags: false },
};

/**
 * A gap bucket — the sensor reported nothing into this hour, so `value` and every
 * summary field come back null while coverage still reads 100%. Captured verbatim
 * from sensor 3425 at 2024-01-03T18:00Z; the #11 repro.
 */
export const gapBucketHourly: OpenAqMeasurement = {
  value: null,
  parameter: { id: 2, name: 'pm25', units: 'µg/m³', displayName: null },
  period: {
    label: '1 hour',
    interval: '01:00:00',
    datetimeFrom: { utc: '2024-01-03T18:00:00Z', local: '2024-01-03T10:00:00-08:00' },
    datetimeTo: { utc: '2024-01-03T19:00:00Z', local: '2024-01-03T11:00:00-08:00' },
  },
  summary: {
    min: null,
    q02: null,
    q25: null,
    median: null,
    q75: null,
    q98: null,
    max: null,
    avg: null,
    sd: null,
  },
  coverage: { expectedCount: 1, observedCount: 1, percentComplete: 100 },
  flagInfo: { hasFlags: false },
};

/**
 * A daily bucket whose aggregates carry raw IEEE-754 artifacts, exactly as OpenAQ
 * returns them for a ppm sensor — the #10 repro. `structuredContent` must keep
 * these exact; only `content[]` rounds.
 */
export const impreciseDaily: OpenAqMeasurement = {
  value: 0.0207,
  parameter: { id: 10, name: 'o3', units: 'ppm', displayName: 'O₃' },
  period: {
    label: '1 day',
    interval: '24:00:00',
    datetimeFrom: { utc: '2026-07-01T07:00:00Z', local: '2026-07-01T00:00:00-07:00' },
    datetimeTo: { utc: '2026-07-02T07:00:00Z', local: '2026-07-02T00:00:00-07:00' },
  },
  summary: {
    min: 0.001,
    median: 0.023,
    max: 0.029,
    avg: 0.02070833333333334,
    sd: 0.0074977049628633,
  },
  coverage: { expectedCount: 24, observedCount: 24, percentComplete: 100 },
  flagInfo: { hasFlags: false },
};

/**
 * A measurement bucket over one UTC period, for the gap, DST, and clipping tests
 * where only the boundaries and the value matter. `local` repeats the UTC instant
 * because no tool reads it. A `value: null` bucket carries the all-null summary
 * of a captured gap bucket (see `gapBucketHourly`).
 */
export function makeBucket(
  from: string,
  to: string,
  opts: { label?: string; percentComplete?: number; value?: number | null } = {},
): OpenAqMeasurement {
  const value = opts.value === undefined ? 5 : opts.value;
  const stat = value;
  return {
    value,
    parameter: { id: 2, name: 'pm25', units: 'µg/m³', displayName: null },
    period: {
      label: opts.label ?? '1 hour',
      datetimeFrom: { utc: from, local: from },
      datetimeTo: { utc: to, local: to },
    },
    summary: { min: stat, median: stat, max: stat, avg: stat, sd: null },
    coverage: { percentComplete: opts.percentComplete ?? 100 },
    flagInfo: { hasFlags: false },
  };
}

/**
 * Station 931 (America/Los_Angeles) bucket boundaries captured live 2026-09-23 on
 * sensor 1701, as `[datetimeFrom, datetimeTo]` UTC pairs. OpenAQ labels an hour by
 * its end and a day by the station's local calendar day, so DST shows up in the
 * boundaries rather than as missing time.
 */
export const dstBoundaries = {
  /** Daily 2025-11-01..2025-11-03 local: the fall-back day is the 25-hour bucket. */
  dailyFallBack: [
    ['2025-11-01T07:00:00Z', '2025-11-02T07:00:00Z'],
    ['2025-11-02T07:00:00Z', '2025-11-03T08:00:00Z'],
    ['2025-11-03T08:00:00Z', '2025-11-04T08:00:00Z'],
  ],
  /** Hourly 2025-11-02T06:00Z–12:00Z: the repeated local hour arrives as one 2-hour bucket. */
  hourlyFallBack: [
    ['2025-11-02T06:00:00Z', '2025-11-02T07:00:00Z'],
    ['2025-11-02T07:00:00Z', '2025-11-02T09:00:00Z'],
    ['2025-11-02T09:00:00Z', '2025-11-02T10:00:00Z'],
    ['2025-11-02T10:00:00Z', '2025-11-02T11:00:00Z'],
    ['2025-11-02T11:00:00Z', '2025-11-02T12:00:00Z'],
  ],
  /** Hourly 2026-03-08T08:00Z–13:00Z: the skipped local hour leaves the UTC hours contiguous. */
  hourlySpringForward: [
    ['2026-03-08T08:00:00Z', '2026-03-08T09:00:00Z'],
    ['2026-03-08T09:00:00Z', '2026-03-08T10:00:00Z'],
    ['2026-03-08T10:00:00Z', '2026-03-08T11:00:00Z'],
    ['2026-03-08T11:00:00Z', '2026-03-08T12:00:00Z'],
    ['2026-03-08T12:00:00Z', '2026-03-08T13:00:00Z'],
  ],
  /**
   * Daily around 2026-03-08: OpenAQ returns the day before the change as a 47-hour
   * bucket that overlaps the next one — an upstream shape, not missing time.
   */
  dailySpringForwardOverlap: [
    ['2026-03-07T08:00:00Z', '2026-03-09T07:00:00Z'],
    ['2026-03-08T08:00:00Z', '2026-03-09T07:00:00Z'],
    ['2026-03-09T07:00:00Z', '2026-03-10T07:00:00Z'],
  ],
} as const satisfies Record<string, readonly (readonly [string, string])[]>;

/** A raw measurement row — no summary block. */
export const rawMeasurement: OpenAqMeasurement = {
  value: 6.3,
  parameter: { id: 2, name: 'pm25', units: 'µg/m³', displayName: null },
  period: {
    label: 'raw',
    interval: '01:00:00',
    datetimeFrom: { utc: '2026-05-01T07:00:00Z', local: '2026-05-01T00:00:00-07:00' },
    datetimeTo: { utc: '2026-05-01T08:00:00Z', local: '2026-05-01T01:00:00-07:00' },
  },
  coverage: { expectedCount: 1, observedCount: 1, percentComplete: 100 },
  flagInfo: { hasFlags: false },
};

export const parameters: OpenAqParameter[] = [
  {
    id: 2,
    name: 'pm25',
    units: 'µg/m³',
    displayName: 'PM2.5',
    description: 'Particulate matter < 2.5µm',
  },
  {
    id: 4,
    name: 'co',
    units: 'µg/m³',
    displayName: 'CO mass',
    description: 'Carbon monoxide mass',
  },
  { id: 8, name: 'co', units: 'ppm', displayName: 'CO', description: 'Carbon monoxide' },
  { id: 102, name: 'co', units: 'ppb', displayName: 'CO', description: 'Carbon monoxide' },
  {
    id: 100,
    name: 'temperature',
    units: 'c',
    displayName: 'Temperature (C)',
    description: 'Air temperature',
  },
  { id: 34, name: 'wind_speed', units: 'm/s', displayName: 'Wind speed', description: null },
];

export const countries: OpenAqCountry[] = [
  {
    id: 155,
    code: 'US',
    name: 'United States',
    datetimeFirst: '2016-01-01T00:00:00Z',
    datetimeLast: '2026-06-13T19:00:00Z',
    parameters: [
      { id: 2, name: 'pm25', units: 'µg/m³', displayName: 'PM2.5' },
      { id: 8, name: 'co', units: 'ppm', displayName: 'CO' },
    ],
  },
  {
    id: 9,
    code: 'IN',
    name: 'India',
    datetimeFirst: '2017-03-01T00:00:00Z',
    datetimeLast: '2026-06-12T18:00:00Z',
    parameters: [{ id: 2, name: 'pm25', units: 'µg/m³', displayName: 'PM2.5' }],
  },
];

/**
 * Three coordinate-query locations returned OUT of distance order — the #2 repro
 * (Bremerton 917 at ~22km arrives before the ~1.4km Seattle station). The service
 * must sort these ascending so results[0] is the true nearest (id 931).
 */
export const unsortedByDistance: OpenAqLocation[] = [
  { ...seattleLocation, id: 917, name: 'Bremerton-Spruce Ave', distance: 22257.53 },
  { ...seattleLocation, id: 931, name: 'Seattle-10th & Weller', distance: 1364.84 },
  { ...seattleLocation, id: 700, name: 'Seattle-Beacon Hill', distance: 4575.1 },
];

/**
 * Countries whose names or codes contain the "us" substring — the #4 repro. A
 * two-letter "US" query must return United States alone (exact ISO code), not every
 * country matching the substring (Cyprus, Australia, United Kingdom by name).
 */
export const usSubstringCountries: OpenAqCountry[] = [
  {
    id: 155,
    code: 'US',
    name: 'United States',
    datetimeFirst: null,
    datetimeLast: null,
    parameters: [],
  },
  {
    id: 826,
    code: 'GB',
    name: 'United Kingdom',
    datetimeFirst: null,
    datetimeLast: null,
    parameters: [],
  },
  { id: 196, code: 'CY', name: 'Cyprus', datetimeFirst: null, datetimeLast: null, parameters: [] },
  {
    id: 36,
    code: 'AU',
    name: 'Australia',
    datetimeFirst: null,
    datetimeLast: null,
    parameters: [],
  },
];

/** A country whose `parameters` field is null — the bug case for #1. */
export const countriesWithNullParameters: OpenAqCountry[] = [
  ...countries,
  {
    id: 999,
    code: 'XX',
    name: 'Sparse Country',
    datetimeFirst: null,
    datetimeLast: null,
    parameters: null,
  },
];

/**
 * A country catalog of `count` rows in OpenAQ's ascending-id order, for paging
 * tests that need more rows than one page. Codes run AA, AB, … so every row is
 * distinguishable. Every country measures pm25 (id 2); every third (ids 1, 4, 7, …)
 * also measures no2 (id 5); `nullParametersAt` (1-based id) marks one row with
 * `parameters: null`, the sparse shape OpenAQ returns for a country with none.
 */
export function makeCountries(count: number, nullParametersAt?: number): OpenAqCountry[] {
  return Array.from({ length: count }, (_, i) => {
    const id = i + 1;
    const pm25 = { id: 2, name: 'pm25', units: 'µg/m³', displayName: 'PM2.5' };
    const no2 = { id: 5, name: 'no2', units: 'µg/m³', displayName: 'NO₂ mass' };
    return {
      id,
      code: String.fromCharCode(65 + Math.floor(i / 26), 65 + (i % 26)),
      name: `Country ${id}`,
      datetimeFirst: '2016-01-01T00:00:00Z',
      datetimeLast: '2026-09-01T00:00:00Z',
      parameters: id === nullParametersAt ? null : i % 3 === 0 ? [pm25, no2] : [pm25],
    };
  });
}
