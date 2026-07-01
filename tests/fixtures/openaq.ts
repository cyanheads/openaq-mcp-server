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
