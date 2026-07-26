/**
 * @fileoverview openaq_find_locations — find air-quality monitoring stations
 * (measured by physical sensors, not modeled) near a point, within a bounding
 * box, or by country. The required first step: get_readings and get_measurements
 * key on the location id this returns. Empty results mean NO coverage, not clean air.
 * @module mcp-server/tools/definitions/find-locations.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { bboxSchema, coordinatesSchema } from '@/mcp-server/tools/shared/geo-input.js';
import { datetimePair } from '@/mcp-server/tools/shared/schema-helpers.js';
import { withUpstream } from '@/mcp-server/tools/shared/upstream-errors.js';
import { getOpenAqService, interpretFound } from '@/services/openaq/openaq-service.js';
import type { OpenAqLocation } from '@/services/openaq/types.js';

/** Upstream page cap for `/v3/locations`. Past it, only `page` reaches more stations. */
const LIMIT_MAX = 100;

/** Reshape a raw location into the tool's domain output, sensors[] → parameters[]. */
function shapeLocation(loc: OpenAqLocation) {
  return {
    id: loc.id,
    name: loc.name ?? `location ${loc.id}`,
    locality: loc.locality,
    country: {
      code: loc.country?.code ?? 'XX',
      name: loc.country?.name ?? 'Unknown',
    },
    coordinates: {
      latitude: loc.coordinates?.latitude ?? 0,
      longitude: loc.coordinates?.longitude ?? 0,
    },
    distanceMeters: loc.distance,
    provider: loc.provider?.name ?? 'Unknown',
    isMonitor: loc.isMonitor,
    isMobile: loc.isMobile,
    parameters: loc.sensors.map((s) => ({
      id: s.parameter.id,
      name: s.parameter.name,
      unit: s.parameter.units,
      displayName: s.parameter.displayName,
    })),
    datetimeLast: loc.datetimeLast,
    datetimeFirst: loc.datetimeFirst,
  };
}

export const findLocations = tool('openaq_find_locations', {
  title: 'openaq-mcp-server: find locations',
  description:
    "Find air-quality monitoring stations (measured by physical sensors, not modeled) near a point, within a bounding box, or by country. Returns each station's id, name, coordinates, distance from the query point (when searching by coordinates), country, provider, the parameters its sensors measure, and the timestamp of its most recent data (datetimeLast). Required first step: openaq_get_readings and openaq_get_measurements key on the location id this returns. Coverage is uneven and real — a station only reports the parameters it measures, and the absence of a nearby station means no monitoring there, not clean air. For dense modeled coverage anywhere on Earth, use open-meteo-mcp-server's air-quality tool instead.",
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  input: z.object({
    coordinates: coordinatesSchema(
      'Center point as "latitude,longitude" (e.g. "47.6062,-122.3321"). Pair with radius for a near-me search. Resolve a place name to coordinates with openstreetmap-mcp-server or open-meteo geocode first. Provide either coordinates+radius OR bbox, not both.',
    ).optional(),
    radius: z
      .number()
      .int()
      .min(1)
      .max(25000)
      .default(12000)
      .describe(
        'Search radius in metres around coordinates (1–25000; the API hard-caps at 25000). Default 12000 (~12km). Only used with coordinates.',
      ),
    bbox: bboxSchema(
      'Bounding box as "minLon,minLat,maxLon,maxLat" (west,south,east,north). Alternative to coordinates+radius for area sweeps. Results have no distance field (no center point).',
    ).optional(),
    iso: z
      .string()
      .length(2)
      .optional()
      .describe(
        'Restrict to a country by ISO 3166-1 alpha-2 code (e.g. "US", "IN", "DE"). Combine with bbox/coordinates to scope, or use alone for a country-wide list. Discover coverage with openaq_list_countries.',
      ),
    parametersId: z
      .number()
      .int()
      .optional()
      .describe(
        'Only return stations that measure this parameter id (e.g. 2 = PM2.5 µg/m³). Get ids from openaq_list_parameters — the same pollutant has several ids for different units. Narrows the station set; each returned station still lists all its sensors.',
      ),
    limit: z
      .number()
      .int()
      .min(1)
      .max(LIMIT_MAX)
      .default(20)
      .describe(
        'Max stations to return (1–100). Default 20. Results are ordered by distance when searching by coordinates.',
      ),
    page: z
      .number()
      .int()
      .min(1)
      .default(1)
      .describe(
        'Which page of results to return (1-based). Default 1. The only way past the 100-station cap: with limit 100, page 2 returns stations 101–200. Distance ordering applies within a page, not across pages, so paging is for iso/bbox sweeps — a near-me coordinates search should stay on page 1.',
      ),
  }),
  output: z.object({
    locations: z
      .array(
        z
          .object({
            id: z
              .number()
              .describe('Location id — pass to openaq_get_readings / openaq_get_measurements'),
            name: z.string().describe('Station name'),
            locality: z.string().nullable().describe('Locality or metro area, when provided'),
            country: z
              .object({
                code: z.string().describe('ISO 3166-1 alpha-2 country code'),
                name: z.string().describe('Country name'),
              })
              .describe('Country the station is in'),
            coordinates: z
              .object({
                latitude: z.number().describe('Station latitude (decimal degrees)'),
                longitude: z.number().describe('Station longitude (decimal degrees)'),
              })
              .describe('Station location'),
            distanceMeters: z
              .number()
              .nullable()
              .describe(
                'Distance from the query coordinates in metres. Null when searching by bbox or iso (no center point).',
              ),
            provider: z.string().describe('Data provider / network (e.g. "AirNow", "OpenAQ LCS")'),
            isMonitor: z
              .boolean()
              .describe(
                'True for reference-grade government monitors; false for low-cost sensors. Reference monitors are more reliable for regulatory comparison.',
              ),
            isMobile: z
              .boolean()
              .describe('True if the station is mobile (coordinates may vary over time)'),
            parameters: z
              .array(
                z
                  .object({
                    id: z
                      .number()
                      .describe(
                        'Parameter id — use as parametersId in get_readings / get_measurements',
                      ),
                    name: z.string().describe('Pollutant code (e.g. "pm25", "o3")'),
                    unit: z
                      .string()
                      .describe(
                        'Measurement unit for this sensor (e.g. "µg/m³", "ppm"). Units vary by sensor — never assume.',
                      ),
                    displayName: z.string().nullable().describe('Human-readable pollutant name'),
                  })
                  .describe('A parameter the station measures, with its sensor unit'),
              )
              .describe(
                'Parameters this station measures, each with its sensor unit. The station has one sensor per parameter.',
              ),
            datetimeLast: datetimePair
              .nullable()
              .describe(
                'Timestamp of the station\'s most recent measurement. Tells you whether "latest" will be minutes or hours/days old. Null if the station has never reported.',
              ),
            datetimeFirst: datetimePair
              .nullable()
              .describe("Timestamp of the station's first available measurement."),
          })
          .describe('A matching monitoring station with its sensors and data span'),
      )
      .describe(
        'Matching stations. Empty array means no monitoring coverage for the query — NOT clean air. Widen the radius, try openaq_list_countries, or use the modeled open-meteo air-quality tool.',
      ),
  }),
  enrichment: {
    totalCount: z
      .number()
      .describe(
        'Total matching stations before the limit. A floor (not an exact count) when totalCountIsLowerBound is true.',
      ),
    totalCountIsLowerBound: z
      .boolean()
      .optional()
      .describe(
        'True when OpenAQ reported a lower bound (">N"): totalCount is a floor and more stations match than the count shown.',
      ),
    truncated: z
      .boolean()
      .optional()
      .describe('True when the station list was capped at the limit.'),
    shown: z.number().optional().describe('Number of stations returned.'),
    cap: z.number().optional().describe('The limit that was applied.'),
    notice: z
      .string()
      .optional()
      .describe(
        'Guidance when OpenAQ reports a lower-bound total without the result set hitting the limit.',
      ),
  },
  errors: [
    {
      reason: 'no_locations_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'No monitoring stations match the given area or filters.',
      recovery:
        'Widen the radius (up to 25000m), drop the parametersId filter, check coverage with openaq_list_countries, or fall back to the modeled open-meteo air-quality tool. No station does not mean clean air.',
      retryable: false,
    },
    {
      reason: 'no_search_scope',
      code: JsonRpcErrorCode.ValidationError,
      when: 'None of coordinates, bbox, or iso was provided.',
      recovery:
        'Provide coordinates+radius for a near-me search, bbox for an area, or iso for a country.',
      retryable: false,
    },
    {
      reason: 'upstream_error',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'OpenAQ returned 5xx or an unreadable body on every retry.',
      recovery:
        'Retry after a short backoff; if it keeps failing, OpenAQ is degraded — an error here says nothing about station coverage.',
      retryable: true,
    },
    {
      reason: 'rate_limited',
      code: JsonRpcErrorCode.RateLimited,
      when: 'OpenAQ returned 429 — the request budget for this key is exhausted.',
      recovery:
        'Wait the retryAfter seconds given in data (about 60 if absent) before retrying; the free tier allows roughly 60 requests per minute.',
      retryable: true,
    },
    {
      reason: 'upstream_timeout',
      code: JsonRpcErrorCode.Timeout,
      when: 'OpenAQ did not respond within the request timeout on every retry.',
      recovery:
        'Retry once after a short pause, or narrow the search area with a smaller radius or a tighter bbox.',
      retryable: true,
    },
    {
      reason: 'invalid_api_key',
      code: JsonRpcErrorCode.Unauthorized,
      when: 'OpenAQ returned 401 — the configured OPENAQ_API_KEY is missing, invalid, or revoked.',
      recovery:
        "Stop retrying — every OpenAQ call fails until the server's OPENAQ_API_KEY is replaced with a valid key from an OpenAQ Explorer account.",
      retryable: false,
    },
  ],

  async handler(input, ctx) {
    const hasCoordinates = Boolean(input.coordinates);
    const hasBbox = Boolean(input.bbox);
    const hasIso = Boolean(input.iso);
    if (!hasCoordinates && !hasBbox && !hasIso) {
      throw ctx.fail('no_search_scope', undefined, { ...ctx.recoveryFor('no_search_scope') });
    }

    const res = await withUpstream(ctx, () =>
      getOpenAqService().findLocations(
        {
          ...(input.coordinates ? { coordinates: input.coordinates, radius: input.radius } : {}),
          ...(input.bbox ? { bbox: input.bbox } : {}),
          ...(input.iso ? { iso: input.iso } : {}),
          ...(input.parametersId !== undefined ? { parametersId: input.parametersId } : {}),
          limit: input.limit,
          page: input.page,
        },
        ctx,
      ),
    );

    const locations = res.results.map(shapeLocation);

    if (locations.length === 0) {
      throw ctx.fail('no_locations_found', 'No monitoring stations match the query.', {
        ...ctx.recoveryFor('no_locations_found'),
      });
    }

    // `meta.found` is the upstream total before the limit — but OpenAQ reports ">N"
    // (a lower bound) once the count exceeds the page cap. Keep totalCount as the
    // numeric floor and flag it, so the count is never presented as exact.
    const { total: foundFloor, isLowerBound } = interpretFound(res.meta?.found);
    const total = foundFloor > 0 ? foundFloor : locations.length;
    ctx.enrich.total(total);
    if (isLowerBound) ctx.enrich({ totalCountIsLowerBound: true });

    if (locations.length >= input.limit) {
      // At the 100 cap there is nowhere left for limit to go — the next page is the
      // only way to reach station 101, so name it instead of repeating "raise limit".
      const nextStep =
        input.limit >= LIMIT_MAX
          ? `request page ${input.page + 1}`
          : `raise limit (max ${LIMIT_MAX})`;
      ctx.enrich.truncated({
        shown: locations.length,
        cap: input.limit,
        guidance: isLowerBound
          ? `OpenAQ reports more than ${total} matching stations (a lower bound, not an exact count); showing ${locations.length} on page ${input.page}. Narrow with parametersId, a smaller radius, or a tighter bbox, or ${nextStep}.`
          : `More stations may match. Narrow with parametersId, a smaller radius, or a tighter bbox, or ${nextStep}.`,
      });
    } else if (isLowerBound) {
      // Lower bound without hitting the cap (rare) — still disclose it as a notice.
      ctx.enrich.notice(
        `OpenAQ reports more than ${total} matching stations (a lower bound, not an exact count).`,
      );
    }

    ctx.log.info('Found locations', {
      shown: locations.length,
      page: input.page,
      scope: hasCoordinates ? 'coordinates' : hasBbox ? 'bbox' : 'iso',
    });

    return { locations };
  },

  format: (result) => {
    const lines = result.locations.map((loc) => {
      const dist =
        loc.distanceMeters != null ? `${Math.round(loc.distanceMeters)}m away` : 'no distance';
      const locality = loc.locality ?? 'n/a';
      const kind = loc.isMonitor ? 'reference monitor' : 'low-cost sensor';
      const mobile = loc.isMobile ? 'mobile' : 'fixed';
      const first = loc.datetimeFirst
        ? `${loc.datetimeFirst.utc} (local ${loc.datetimeFirst.local})`
        : 'unknown';
      const last = loc.datetimeLast
        ? `${loc.datetimeLast.utc} (local ${loc.datetimeLast.local})`
        : 'never reported';
      const params =
        loc.parameters
          .map((p) => `${p.name} #${p.id} (${p.unit}, ${p.displayName ?? 'no display name'})`)
          .join(', ') || 'none';
      return [
        `## ${loc.name} — id ${loc.id}`,
        `${loc.country.name} (${loc.country.code}) · locality: ${locality} · ${dist} · ${kind} · ${mobile} · provider: ${loc.provider}`,
        `coords: ${loc.coordinates.latitude}, ${loc.coordinates.longitude}`,
        `data span: ${first} → ${last}`,
        `parameters: ${params}`,
      ].join('\n');
    });
    return [{ type: 'text', text: lines.join('\n\n') }];
  },
});
