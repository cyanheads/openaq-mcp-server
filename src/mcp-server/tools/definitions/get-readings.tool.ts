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
import { displayNumber } from '@/mcp-server/tools/shared/format-helpers.js';
import { coordinatesSchema } from '@/mcp-server/tools/shared/geo-input.js';
import { datetimePair, isNotFound } from '@/mcp-server/tools/shared/schema-helpers.js';
import { upstreamFailure, withUpstream } from '@/mcp-server/tools/shared/upstream-errors.js';
import { getOpenAqService } from '@/services/openaq/openaq-service.js';
import type { OpenAqLocation } from '@/services/openaq/types.js';

/**
 * Candidate pool pulled when auto-resolving the nearest station from coordinates —
 * OpenAQ's page maximum (1001 is rejected with a 422). /v3/locations pages in
 * ascending id order, not by distance, so a smaller pool drops the newest stations
 * and can miss the nearest one: dense 25 km searches match a few hundred stations
 * (283 around Los Angeles for PM2.5). The service's distance sort then surfaces the
 * nearest of the page at results[0]. A page that comes back full may leave matches
 * uncompared, which the handler discloses rather than paging on.
 */
const NEAREST_CANDIDATE_LIMIT = 1000;

/**
 * Radius for the nearest-station sweep — the API's hard maximum, so a miss here
 * has already searched as wide as OpenAQ allows. The `no_station_near_coordinates`
 * recovery must therefore not suggest widening it.
 */
const NEAREST_SEARCH_RADIUS_M = 25_000;

export const getReadings = tool('openaq_get_readings', {
  title: 'openaq-mcp-server: get readings',
  description:
    'Latest measured value for every sensor at a monitoring station — the current-conditions tool. Returns one record per parameter, each with the value, its unit, the UTC and local timestamp, and the sensor id, joined so every value carries its pollutant and unit (the raw latest feed is keyed only by sensor id). The station block names its provider (for attribution) and timezone. Pass a locationId from openaq_find_locations, or pass coordinates to auto-resolve to the nearest station that measures the requested parametersId. Data recency varies by station reporting cadence — read each value\'s timestamp to know whether "latest" is minutes or hours old. These are measured observations with coverage gaps, not a modeled grid.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  input: z.object({
    locationId: z
      .number()
      .int()
      .positive()
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
      .positive()
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
          .nullable()
          .describe('Station coordinates. Null when OpenAQ lists no latitude or no longitude.'),
        provider: z
          .string()
          .nullable()
          .describe(
            'Network that operates the station (e.g. "AirNow") — cite it alongside OpenAQ. Null when OpenAQ lists none.',
          ),
        providerId: z
          .number()
          .nullable()
          .describe(
            'Provider id, usable as providersId in openaq_find_locations. Null when OpenAQ lists none.',
          ),
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
      .describe(
        'Set when coordinate resolution compared a full 1,000-station page: more stations may match, so the station returned is the nearest of the first 1,000 OpenAQ lists, not necessarily the nearest overall.',
      ),
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
      reason: 'parameter_not_at_location',
      code: JsonRpcErrorCode.NotFound,
      when: 'No sensor at the resolved station measures parametersId (often the wrong unit variant was chosen).',
      recovery:
        'Pick one of the ids listed in data.available, or confirm the id and its unit in openaq_list_parameters — the same pollutant has different ids for µg/m³ vs ppm vs ppb.',
      retryable: false,
    },
    {
      reason: 'no_station_near_coordinates',
      code: JsonRpcErrorCode.NotFound,
      when: 'The 25km auto-resolution sweep found no station measuring the requested parametersId.',
      recovery:
        'Try a different parametersId, sweep a wider area with an openaq_find_locations bbox query, or fall back to the modeled open-meteo air-quality tool. No station does not mean clean air.',
      retryable: false,
    },
    {
      reason: 'no_recent_values',
      code: JsonRpcErrorCode.NotFound,
      when: 'The station has the requested sensors but its latest feed carried no values for them.',
      recovery:
        'Check datetimeLast from openaq_find_locations; the station may be dormant. Try a nearby station.',
      retryable: false,
    },
    {
      reason: 'invalid_location_scope',
      code: JsonRpcErrorCode.ValidationError,
      when: 'Both locationId and coordinates were provided, or neither was.',
      recovery:
        'Pass exactly one — a locationId from openaq_find_locations to read a known station, or coordinates plus parametersId to auto-resolve the nearest one.',
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
      when: 'OpenAQ returned 5xx or an unreadable body on every retry.',
      recovery:
        'Retry after a short backoff; if it keeps failing, OpenAQ is degraded and current conditions are briefly unavailable.',
      retryable: true,
      thrownBy: 'service',
    },
    {
      reason: 'rate_limited',
      code: JsonRpcErrorCode.RateLimited,
      when: 'OpenAQ returned 429 — the request budget for this key is exhausted.',
      recovery:
        'Wait the retryAfter seconds given in data (about 60 if absent) before retrying; the free tier allows roughly 60 requests per minute.',
      retryable: true,
      thrownBy: 'service',
    },
    {
      reason: 'upstream_timeout',
      code: JsonRpcErrorCode.Timeout,
      when: 'OpenAQ did not respond within the request timeout on every retry.',
      recovery:
        'Retry once after a short pause; passing a known locationId skips the nearest-station sweep and costs one fewer request.',
      retryable: true,
      thrownBy: 'service',
    },
    {
      reason: 'invalid_api_key',
      code: JsonRpcErrorCode.Unauthorized,
      when: 'OpenAQ returned 401 — the configured OPENAQ_API_KEY is missing, invalid, or revoked.',
      recovery:
        "Stop retrying — every OpenAQ call fails until the server's OPENAQ_API_KEY is replaced with a valid key from an OpenAQ Explorer account.",
      retryable: false,
      thrownBy: 'service',
    },
  ],

  async handler(input, ctx) {
    const service = getOpenAqService();
    const hasLocationId = input.locationId !== undefined;
    const hasCoordinates = Boolean(input.coordinates);

    if (hasLocationId === hasCoordinates) {
      throw ctx.fail(
        'invalid_location_scope',
        hasLocationId
          ? 'Provide either locationId or coordinates, not both.'
          : 'Provide either a locationId or coordinates — neither was given.',
        { ...ctx.recoveryFor('invalid_location_scope') },
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
      // Pull a full page so the service's distance sort can pick the true nearest —
      // upstream order is by id, so a short pool leaves the newest stations out.
      const found = await withUpstream(ctx, () =>
        service.findLocations(
          {
            coordinates: input.coordinates as string,
            radius: NEAREST_SEARCH_RADIUS_M,
            parametersId: input.parametersId as number,
            limit: NEAREST_CANDIDATE_LIMIT,
          },
          ctx,
        ),
      );
      const nearest = found.results[0];
      if (!nearest) {
        throw ctx.fail(
          'no_station_near_coordinates',
          `No station within ${NEAREST_SEARCH_RADIUS_M / 1000}km of ${input.coordinates} measures parameter ${input.parametersId}.`,
          { ...ctx.recoveryFor('no_station_near_coordinates') },
        );
      }
      locationId = nearest.id;
      distanceMeters = nearest.distance;
      if (found.results.length >= NEAREST_CANDIDATE_LIMIT) {
        ctx.enrich.notice(
          `OpenAQ returned a full page of ${NEAREST_CANDIDATE_LIMIT.toLocaleString('en-US')} stations within ${NEAREST_SEARCH_RADIUS_M / 1000}km measuring parameter ${input.parametersId}, so more may match: station ${nearest.id} is the nearest of the first ${NEAREST_CANDIDATE_LIMIT.toLocaleString('en-US')} OpenAQ lists (in station-id order), not necessarily the nearest overall. To check, search openaq_find_locations around these coordinates with a radius small enough that the page comes back short of its limit, then pass the nearest locationId here.`,
        );
      }
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
      throw upstreamFailure(ctx, err);
    }

    // A parametersId the station has no sensor for is a wrong-parameter error, not
    // a dormant station — decide that from the sensor map, before the join empties
    // the array and makes a live station look like it stopped reporting.
    if (
      input.parametersId !== undefined &&
      !location.sensors.some((s) => s.parameter.id === input.parametersId)
    ) {
      throw ctx.fail(
        'parameter_not_at_location',
        `Station ${locationId} has no sensor for parameter ${input.parametersId}.`,
        {
          locationId,
          parametersId: input.parametersId,
          available: location.sensors.map((s) => s.parameter.id),
          ...ctx.recoveryFor('parameter_not_at_location'),
        },
      );
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
      // The station does have the sensor (checked above) — it simply has not
      // reported a value for it, so name the sensor rather than the whole station.
      throw ctx.fail(
        'no_recent_values',
        input.parametersId !== undefined
          ? `Station ${locationId} measures parameter ${input.parametersId} but returned no recent value for it.`
          : `Station ${locationId} returned no recent values.`,
        {
          locationId,
          ...(input.parametersId !== undefined ? { parametersId: input.parametersId } : {}),
          ...ctx.recoveryFor('no_recent_values'),
        },
      );
    }

    ctx.log.info('Resolved readings', { locationId, count: readings.length });

    // A point is only a point when both sides are known.
    const { latitude, longitude } = location.coordinates ?? {};
    return {
      location: {
        id: location.id,
        name: location.name ?? `location ${location.id}`,
        coordinates:
          typeof latitude === 'number' && typeof longitude === 'number'
            ? { latitude, longitude }
            : null,
        provider: location.provider?.name ?? null,
        providerId: location.provider?.id ?? null,
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
    const coords = loc.coordinates
      ? `${loc.coordinates.latitude}, ${loc.coordinates.longitude}`
      : 'not listed by OpenAQ';
    const meta = `coords: ${coords} · timezone: ${loc.timezone ?? 'n/a'}`;
    const provider = `provider: ${loc.provider === null ? 'not listed by OpenAQ' : `${loc.provider} (providerId ${loc.providerId})`}`;
    const rows = result.readings.map(
      (r) =>
        `- **${r.parameter.displayName ?? r.parameter.name}** (\`${r.parameter.name}\` #${r.parameter.id}): ${displayNumber(r.value)} ${r.unit} · ${r.datetimeUtc} (local ${r.datetimeLocal}) · sensor ${r.sensorId}`,
    );
    return [
      { type: 'text', text: [head, `${last}${dist}`, meta, provider, '', ...rows].join('\n') },
    ];
  },
});
