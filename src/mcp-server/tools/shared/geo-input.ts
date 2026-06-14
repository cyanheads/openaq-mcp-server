/**
 * @fileoverview Shared Zod schema builders for geographic tool inputs
 * (`coordinates` point, `bbox` bounding box). They bound latitude/longitude to
 * valid Earth ranges at the edge so out-of-range values are rejected as a clean
 * ValidationError instead of reaching OpenAQ — which returns a plain-text HTTP
 * 500 for bad coordinates (e.g. `999,999` or a `200,…` bbox), retried before it
 * surfaces. The shared module keeps the range rule single-sourced across
 * find-locations and get-readings.
 * @module mcp-server/tools/shared/geo-input
 */

import { z } from '@cyanheads/mcp-ts-core';

const LAT_MIN = -90;
const LAT_MAX = 90;
const LON_MIN = -180;
const LON_MAX = 180;

const COORDINATES_REGEX = /^-?\d{1,3}(\.\d+)?,-?\d{1,3}(\.\d+)?$/;
const BBOX_REGEX = /^(-?\d+(\.\d+)?,){3}-?\d+(\.\d+)?$/;

const inLat = (n: number): boolean => n >= LAT_MIN && n <= LAT_MAX;
const inLon = (n: number): boolean => n >= LON_MIN && n <= LON_MAX;

/**
 * `"latitude,longitude"` with both components bounded to valid Earth ranges.
 * The regex guarantees the comma-delimited numeric structure; the refine bounds
 * the values so `999,999` fails here instead of crashing the upstream API.
 */
export function coordinatesSchema(description: string) {
  return z
    .string()
    .regex(COORDINATES_REGEX)
    .refine(
      (value) => {
        const [lat, lon] = value.split(',').map(Number);
        return inLat(lat as number) && inLon(lon as number);
      },
      {
        message:
          'Coordinates out of range. Latitude must be between -90 and 90, longitude between -180 and 180.',
      },
    )
    .describe(description);
}

/**
 * `"minLon,minLat,maxLon,maxLat"` with each component bounded to valid Earth
 * ranges (lons to ±180, lats to ±90). Out-of-range corners (e.g. `200,100,…`)
 * fail here instead of reaching the upstream API as a plain-text 500.
 */
export function bboxSchema(description: string) {
  return z
    .string()
    .regex(BBOX_REGEX)
    .refine(
      (value) => {
        const [minLon, minLat, maxLon, maxLat] = value.split(',').map(Number);
        return (
          inLon(minLon as number) &&
          inLat(minLat as number) &&
          inLon(maxLon as number) &&
          inLat(maxLat as number)
        );
      },
      {
        message:
          'Bounding box out of range. Use "minLon,minLat,maxLon,maxLat" with longitudes between -180 and 180 and latitudes between -90 and 90.',
      },
    )
    .describe(description);
}
