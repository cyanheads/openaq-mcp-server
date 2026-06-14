/**
 * @fileoverview openaq_get_readings — latest measured value for every sensor at
 * a station, joined against the station's sensor→parameter→unit map so each value
 * carries its pollutant and unit (the raw /latest feed is keyed only by sensorsId).
 * The current-conditions tool. Pass a locationId, or coordinates+parametersId to
 * auto-resolve the nearest station.
 * @module mcp-server/tools/definitions/get-readings.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { coordinatesSchema } from '@/mcp-server/tools/shared/geo-input.js';
import { datetimePair, isNotFound } from '@/mcp-server/tools/shared/schema-helpers.js';
import { getOpenAqService } from '@/services/openaq/openaq-service.js';
import type { OpenAqLocation } from '@/services/openaq/types.js';

export const getReadings = tool('openaq_get_readings', {
  title: 'openaq-mcp-server: get readings',
  description:
    'Latest measured value for every sensor at a monitoring station — the current-conditions tool. Returns one record per parameter, each with the value, its unit, the UTC and local timestamp, and the sensor id, joined so every value carries its pollutant and unit (the raw latest feed is keyed only by sensor id). Pass a locationId from openaq_find_locations, or pass coordinates to auto-resolve to the nearest station that measures the requested parametersId. Data recency varies by station reporting cadence — read each value\'s timestamp to know whether "latest" is minutes or hours old. These are measured observations with coverage gaps, not a modeled grid.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  input: z.object({
    locationId: z
      .number()
      .int()
      .optional()
      .describe(
        'Station id from openaq_find_locations. Provide this OR coordinates. When set, returns the latest value for every sensor at this station.',
      ),
    coordinates: coordinatesSchema(
      'Fallback "latitude,longitude" when you do not have a locationId — resolves to the nearest station (within 25km) that measures parametersId, then reads its latest values. Requires parametersId.',
    ).optional(),
    parametersId: z
      .number()
      .int()
      .optional()
      .describe(
        'Required with coordinates: which parameter id the nearest station must measure (get ids from openaq_list_parameters). With locationId, optionally filters the returned values to this parameter id; omit to get all sensors.',
      ),
  }),
  output: z.object({
    location: z
      .object({
        id: z.number().describe('Station id'),
        name: z.string().describe('Station name'),
        coordinates: z
          .object({
            latitude: z.number().describe('Station latitude (decimal degrees)'),
            longitude: z.number().describe('Station longitude (decimal degrees)'),
          })
          .describe('Station coordinates'),
        timezone: z.string().nullable().describe('IANA timezone of the station'),
        distanceMeters: z
          .number()
          .nullable()
          .describe(
            'Distance from query coordinates in metres, when resolved via coordinates; null when called by locationId',
          ),
        datetimeLast: datetimePair
          .nullable()
          .describe(
            'Timestamp of the station\'s most recent measurement — tells you whether "latest" is minutes or hours old before reading per-value timestamps. Null if the station has never reported.',
          ),
      })
      .describe('The station these readings came from'),
    readings: z
      .array(
        z
          .object({
            parameter: z
              .object({
                id: z.number().describe('Parameter id'),
                name: z.string().describe('Pollutant code (e.g. "pm25")'),
                displayName: z.string().nullable().describe('Human-readable pollutant name'),
              })
              .describe('What was measured'),
            value: z.number().describe('Measured concentration'),
            unit: z
              .string()
              .describe(
                'Unit for this value (e.g. "µg/m³", "ppm", "ppb"). Always read it — units differ across stations and pollutants; the value is meaningless without it.',
              ),
            sensorId: z
              .number()
              .describe(
                "Sensor id — use the corresponding locationId + parametersId to fetch this sensor's history via openaq_get_measurements",
              ),
            datetimeUtc: z.string().describe('Measurement time, UTC (ISO 8601)'),
            datetimeLocal: z.string().describe("Measurement time in the station's local timezone"),
          })
          .describe('Latest value for one sensor, with its pollutant and unit'),
      )
      .describe(
        'Latest value per sensor. An old datetime means the station reports infrequently or is stale — not that the value is current.',
      ),
  }),
  enrichment: {
    notice: z
      .string()
      .optional()
      .describe('Guidance when the station resolved but returned no recent values.'),
  },
  errors: [
    {
      reason: 'location_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'The locationId does not exist (API returns {"detail":"Location not found"}).',
      recovery: 'Verify the id via openaq_find_locations.',
      retryable: false,
    },
    {
      reason: 'no_station_near_coordinates',
      code: JsonRpcErrorCode.NotFound,
      when: 'No station within 25km of coordinates measures the requested parametersId.',
      recovery:
        'Widen your search with openaq_find_locations (radius up to 25000m), try a different parametersId, or use the modeled open-meteo air-quality tool for coverage. No station does not mean clean air.',
      retryable: false,
    },
    {
      reason: 'no_recent_values',
      code: JsonRpcErrorCode.NotFound,
      when: 'The station exists but its latest feed returned no values (no recent reporting).',
      recovery:
        'Check datetimeLast from openaq_find_locations; the station may be dormant. Try a nearby station.',
      retryable: false,
    },
    {
      reason: 'missing_coordinates_parameter',
      code: JsonRpcErrorCode.ValidationError,
      when: 'coordinates was provided without parametersId.',
      recovery:
        'Provide parametersId so the nearest matching station can be resolved, or pass a locationId instead.',
      retryable: false,
    },
    {
      reason: 'upstream_error',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'OpenAQ returned 5xx, a rate-limit (429), or timed out.',
      recovery: 'Retry after a short backoff.',
      retryable: true,
    },
  ],

  async handler(input, ctx) {
    const service = getOpenAqService();
    const hasLocationId = input.locationId !== undefined;
    const hasCoordinates = Boolean(input.coordinates);

    if (hasLocationId === hasCoordinates) {
      throw ctx.fail(
        'missing_coordinates_parameter',
        'Provide exactly one of locationId or coordinates.',
        { ...ctx.recoveryFor('missing_coordinates_parameter') },
      );
    }
    if (hasCoordinates && input.parametersId === undefined) {
      throw ctx.fail('missing_coordinates_parameter', undefined, {
        ...ctx.recoveryFor('missing_coordinates_parameter'),
      });
    }

    // Resolve the target location id and (when via coordinates) its distance.
    let locationId: number;
    let distanceMeters: number | null = null;

    if (hasCoordinates) {
      const found = await service.findLocations(
        {
          coordinates: input.coordinates as string,
          radius: 25000,
          parametersId: input.parametersId as number,
          limit: 1,
        },
        ctx,
      );
      const nearest = found.results[0];
      if (!nearest) {
        throw ctx.fail('no_station_near_coordinates', undefined, {
          ...ctx.recoveryFor('no_station_near_coordinates'),
        });
      }
      locationId = nearest.id;
      distanceMeters = nearest.distance;
    } else {
      locationId = input.locationId as number;
    }

    // Fetch the sensor map (for parameter/unit + datetimeLast) and the latest
    // feed together. A 404 on the location → typed location_not_found.
    let location: OpenAqLocation;
    let latest: Awaited<ReturnType<typeof service.getLatest>>;
    try {
      [location, latest] = await Promise.all([
        service.getLocation(locationId, ctx),
        service.getLatest(locationId, ctx),
      ]);
    } catch (err) {
      if (isNotFound(err)) {
        throw ctx.fail(
          'location_not_found',
          `OpenAQ has no location ${locationId}.`,
          { locationId, ...ctx.recoveryFor('location_not_found') },
          { cause: err },
        );
      }
      throw err;
    }

    // Join latest values against the sensor→parameter→unit map on sensorsId.
    const sensorMap = new Map(location.sensors.map((s) => [s.id, s.parameter]));
    let readings = latest
      .map((l) => {
        const parameter = sensorMap.get(l.sensorsId);
        if (!parameter) return null;
        return {
          parameter: { id: parameter.id, name: parameter.name, displayName: parameter.displayName },
          value: l.value,
          unit: parameter.units,
          sensorId: l.sensorsId,
          datetimeUtc: l.datetime.utc,
          datetimeLocal: l.datetime.local,
        };
      })
      .filter((r): r is NonNullable<typeof r> => r !== null);

    if (input.parametersId !== undefined) {
      readings = readings.filter((r) => r.parameter.id === input.parametersId);
    }

    if (readings.length === 0) {
      throw ctx.fail('no_recent_values', `Station ${locationId} returned no recent values.`, {
        locationId,
        ...ctx.recoveryFor('no_recent_values'),
      });
    }

    ctx.log.info('Resolved readings', { locationId, count: readings.length });

    return {
      location: {
        id: location.id,
        name: location.name ?? `location ${location.id}`,
        coordinates: {
          latitude: location.coordinates?.latitude ?? 0,
          longitude: location.coordinates?.longitude ?? 0,
        },
        timezone: location.timezone,
        distanceMeters,
        datetimeLast: location.datetimeLast,
      },
      readings,
    };
  },

  format: (result) => {
    const loc = result.location;
    const head = `## ${loc.name} — id ${loc.id}`;
    const last = loc.datetimeLast
      ? `latest data: ${loc.datetimeLast.utc} (local ${loc.datetimeLast.local})`
      : 'station has never reported';
    const dist =
      loc.distanceMeters != null ? ` · ${Math.round(loc.distanceMeters)}m from query` : '';
    const meta = `coords: ${loc.coordinates.latitude}, ${loc.coordinates.longitude} · timezone: ${loc.timezone ?? 'n/a'}`;
    const rows = result.readings.map(
      (r) =>
        `- **${r.parameter.displayName ?? r.parameter.name}** (\`${r.parameter.name}\` #${r.parameter.id}): ${r.value} ${r.unit} · ${r.datetimeUtc} (local ${r.datetimeLocal}) · sensor ${r.sensorId}`,
    );
    return [{ type: 'text', text: [head, `${last}${dist}`, meta, '', ...rows].join('\n') }];
  },
});
