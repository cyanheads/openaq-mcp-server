/**
 * @fileoverview Shared Zod schema builders for geographic tool inputs
 * (`coordinates` point, `bbox` bounding box). They bound latitude/longitude to
 * valid Earth ranges, and a bbox's corners to west-to-east / south-to-north
 * order, at the edge so bad values are rejected as a clean ValidationError
 * instead of reaching OpenAQ — which returns a plain-text HTTP 500 for bad
 * coordinates (e.g. `999,999`, a `200,…` bbox, or an inverted bbox), retried
 * before it surfaces. The shared module keeps the range rule single-sourced across
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

/**
 * Format-check messages. Both patterns carry `abort: true` so a value that fails
 * the shape check stops there: the range refine parses the components with
 * `Number`, so a non-numeric value would otherwise also collect a second,
 * misleading "out of range" issue on top of the real complaint.
 */
const COORDINATES_MESSAGE =
  'Expected "latitude,longitude" in decimal degrees (e.g. "47.6062,-122.3321").';
const BBOX_MESSAGE =
  'Expected "minLon,minLat,maxLon,maxLat" in decimal degrees (e.g. "-122.5,47.4,-122.1,47.8").';

/**
 * Normalize away every space before the pattern runs, so the most natural way to
 * write a pair — `"47.6062, -122.3321"` — parses identically to its space-free
 * form. The space is internal (after the comma), so trimming is not enough. The
 * parsed value is always the canonical space-free string the handlers hand
 * straight to the OpenAQ query string.
 */
const stripWhitespace = (value: unknown): unknown =>
  typeof value === 'string' ? value.replace(/\s+/g, '') : value;

const inLat = (n: number): boolean => n >= LAT_MIN && n <= LAT_MAX;
const inLon = (n: number): boolean => n >= LON_MIN && n <= LON_MAX;

/**
 * `"latitude,longitude"` with both components bounded to valid Earth ranges.
 * The regex guarantees the comma-delimited numeric structure; the refine bounds
 * the values so `999,999` fails here instead of crashing the upstream API.
 */
export function coordinatesSchema(description: string) {
  return z
    .preprocess(
      stripWhitespace,
      z
        .string()
        .regex(COORDINATES_REGEX, { message: COORDINATES_MESSAGE, abort: true })
        .refine(
          (value) => {
            const [lat, lon] = value.split(',').map(Number);
            return inLat(lat as number) && inLon(lon as number);
          },
          {
            message:
              'Coordinates out of range. Latitude must be between -90 and 90, longitude between -180 and 180.',
          },
        ),
    )
    .describe(description);
}

/**
 * `"minLon,minLat,maxLon,maxLat"` with each component bounded to valid Earth
 * ranges (lons to ±180, lats to ±90) and the corners in order (west ≤ east,
 * south ≤ north). Out-of-range corners (e.g. `200,100,…`) and inverted ones
 * (e.g. `-122.1,47.8,-122.5,47.4`) both fail here instead of reaching the
 * upstream API as a plain-text 500. Equal corners stay valid — OpenAQ serves a
 * zero-area box. The range refine aborts, so an out-of-range box reports that
 * one problem rather than a second, derived ordering complaint.
 */
export function bboxSchema(description: string) {
  return z
    .preprocess(
      stripWhitespace,
      z
        .string()
        .regex(BBOX_REGEX, { message: BBOX_MESSAGE, abort: true })
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
            abort: true,
          },
        )
        .refine(
          (value) => {
            const [minLon, minLat, maxLon, maxLat] = value.split(',').map(Number) as [
              number,
              number,
              number,
              number,
            ];
            return minLon <= maxLon && minLat <= maxLat;
          },
          {
            message:
              'Bounding box corners out of order. Use "minLon,minLat,maxLon,maxLat" with minLon ≤ maxLon (west to east) and minLat ≤ maxLat (south to north).',
          },
        ),
    )
    .describe(description);
}
