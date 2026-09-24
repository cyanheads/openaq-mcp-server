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
import { getOpenAqService } from '@/services/openaq/openaq-service.js';
import type { OpenAqLocation } from '@/services/openaq/types.js';

/** Upstream page cap for `/v3/locations`. Past it, only `page` reaches more stations. */
const LIMIT_MAX = 100;

/**
 * OpenAQ's country codes: ISO 3166-1 alpha-2, plus the `-99` placeholder it lists
 * for a country with no ISO code (Dhekelia). Either letter case is advertised
 * because the preprocess below never reaches the emitted JSON Schema — a client
 * validating against `[A-Z]` alone would reject `"us"`, which the server accepts.
 */
const ISO_REGEX = /^(?:[A-Za-z]{2}|-99)$/;

/**
 * OpenAQ matches `iso` case-sensitively (`iso=us` finds nothing), so trim and
 * uppercase before validating. `-99` passes through unchanged.
 */
const normalizeIso = (value: unknown): unknown =>
  typeof value === 'string' ? value.trim().toUpperCase() : value;

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
    providerId: loc.provider?.id ?? null,
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
    "Find air-quality monitoring stations (measured by physical sensors, not modeled) near a point, within a bounding box, or by country, optionally narrowed to one parameter, one station class (reference monitors or low-cost sensors, mobile or fixed), or one provider network. Returns each station's id, name, coordinates, distance from the query point (when searching by coordinates), country, provider name and id, the parameters its sensors measure, and the timestamp of its most recent data (datetimeLast). Required first step: openaq_get_readings and openaq_get_measurements key on the location id this returns. Coverage is uneven and real — a station only reports the parameters it measures, and the absence of a nearby station means no monitoring there, not clean air. For dense modeled coverage anywhere on Earth, use open-meteo-mcp-server's air-quality tool instead.",
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
      .optional()
      .describe(
        'Search radius in metres around coordinates (1–25000; the API hard-caps at 25000). Default 12000 (~12km). Requires coordinates — a radius sent with only bbox or iso is rejected.',
      ),
    bbox: bboxSchema(
      'Bounding box as "minLon,minLat,maxLon,maxLat" (west,south,east,north), with minLon ≤ maxLon and minLat ≤ maxLat. Alternative to coordinates+radius for area sweeps. Results have no distance field (no center point).',
    ).optional(),
    iso: z
      .preprocess(
        normalizeIso,
        z.string().regex(ISO_REGEX, {
          message:
            'Expected a two-letter ISO 3166-1 alpha-2 country code (e.g. "US") or "-99", as openaq_list_countries returns it.',
        }),
      )
      .optional()
      .describe(
        'Restrict to a country by OpenAQ country code: ISO 3166-1 alpha-2 (e.g. "US", "IN", "DE"; either case), or "-99" where OpenAQ lists a country with no ISO code. Take codes from openaq_list_countries. Combine with bbox/coordinates to scope, or use alone for a country-wide list.',
      ),
    parametersId: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(
        'Only return stations that measure this parameter id (e.g. 2 = PM2.5 µg/m³). Get ids from openaq_list_parameters — the same pollutant has several ids for different units. Narrows the station set; each returned station still lists all its sensors.',
      ),
    monitor: z
      .boolean()
      .optional()
      .describe(
        'Station class filter: true returns only reference-grade monitors, false only low-cost sensors. Omit for both.',
      ),
    mobile: z
      .boolean()
      .optional()
      .describe(
        'Mobility filter: true returns only mobile stations, false only fixed ones. Omit for both.',
      ),
    providersId: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(
        "Only return stations from this OpenAQ provider (data network) id — read it from a previous result's providerId (e.g. 119 = AirNow).",
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
        'Which page of results to return (1-based). Default 1. The only way past the 100-station cap: with limit 100, page 2 returns stations 101–200. Distance ordering applies within a page, not across pages, so paging is for iso/bbox sweeps — a near-me coordinates search should stay on page 1. A page past the last one fails with page_exhausted.',
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
                code: z
                  .string()
                  .describe(
                    'OpenAQ country code: ISO 3166-1 alpha-2, or "-99" where OpenAQ lists none',
                  ),
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
            providerId: z
              .number()
              .nullable()
              .describe(
                'OpenAQ provider id — pass as providersId to restrict a search to this network. Null when OpenAQ lists no provider.',
              ),
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
        'Matching stations on this page, never empty: a query with no match fails with no_locations_found (no monitoring coverage, NOT clean air), and a page past the last with page_exhausted.',
      ),
  }),
  enrichment: {
    totalCount: z
      .number()
      .describe(
        'Stations counted through this page: (page − 1) × limit plus the stations returned. Exact on a page that came back short of the limit (the last page); a floor when totalCountIsLowerBound is true.',
      ),
    totalCountIsLowerBound: z
      .boolean()
      .optional()
      .describe(
        'True when this page came back full: at least totalCount stations match, and the next page may hold more.',
      ),
    truncated: z
      .boolean()
      .optional()
      .describe(
        'True when this page came back full (the limit was reached), so the next page may hold more stations.',
      ),
    shown: z.number().optional().describe('Number of stations returned.'),
    cap: z.number().optional().describe('The limit that was applied.'),
    notice: z
      .string()
      .optional()
      .describe('Guidance on a full page: the next page to request, or how to narrow the search.'),
  },
  errors: [
    {
      reason: 'no_locations_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'No monitoring stations match the given area or filters.',
      recovery:
        'Widen the search area (a radius up to 25000m around coordinates, or a larger bbox), drop the parametersId, monitor, mobile, or providersId filter, check coverage with openaq_list_countries, or fall back to the modeled open-meteo air-quality tool. No station does not mean clean air.',
      retryable: false,
    },
    {
      reason: 'page_exhausted',
      code: JsonRpcErrorCode.NotFound,
      when: 'A page past the first returned no stations — the results end before it.',
      recovery:
        'The results end before this page. Request an earlier page; page 1 shows whether anything matches the query at all.',
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
      reason: 'invalid_search_scope',
      code: JsonRpcErrorCode.ValidationError,
      when: 'coordinates and bbox were both provided, or radius was provided without coordinates.',
      recovery:
        'Use one area scope: coordinates (with an optional radius) for a near-me search, or bbox for an area. radius applies only with coordinates; iso combines with either.',
      retryable: false,
    },
    {
      reason: 'upstream_error',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'OpenAQ returned 5xx or an unreadable body on every retry.',
      recovery:
        'Retry after a short backoff; if it keeps failing, OpenAQ is degraded — an error here says nothing about station coverage.',
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
        'Retry once after a short pause, or narrow the search area with a smaller radius or a tighter bbox.',
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
    const hasCoordinates = Boolean(input.coordinates);
    const hasBbox = Boolean(input.bbox);
    const hasIso = Boolean(input.iso);
    if (!hasCoordinates && !hasBbox && !hasIso) {
      throw ctx.fail('no_search_scope', undefined, { ...ctx.recoveryFor('no_search_scope') });
    }
    // OpenAQ answers both combinations with HTTP 500 — reject them before the call.
    if (hasCoordinates && hasBbox) {
      throw ctx.fail(
        'invalid_search_scope',
        'Both coordinates and bbox were provided; they are alternative area scopes, so use one.',
        { ...ctx.recoveryFor('invalid_search_scope') },
      );
    }
    if (input.radius !== undefined && !hasCoordinates) {
      throw ctx.fail(
        'invalid_search_scope',
        'radius was provided without coordinates; it sets the distance around a center point.',
        { ...ctx.recoveryFor('invalid_search_scope') },
      );
    }

    const res = await withUpstream(ctx, () =>
      getOpenAqService().findLocations(
        {
          ...(input.coordinates ? { coordinates: input.coordinates } : {}),
          ...(input.radius !== undefined ? { radius: input.radius } : {}),
          ...(input.bbox ? { bbox: input.bbox } : {}),
          ...(input.iso ? { iso: input.iso } : {}),
          ...(input.parametersId !== undefined ? { parametersId: input.parametersId } : {}),
          ...(input.monitor !== undefined ? { monitor: input.monitor } : {}),
          ...(input.mobile !== undefined ? { mobile: input.mobile } : {}),
          ...(input.providersId !== undefined ? { providersId: input.providersId } : {}),
          limit: input.limit,
          page: input.page,
        },
        ctx,
      ),
    );

    const locations = res.results.map(shapeLocation);

    if (locations.length === 0) {
      // Past page 1 an empty page says only that the results end earlier — the same
      // query may well match stations, so it must not read as missing coverage.
      if (input.page > 1) {
        throw ctx.fail(
          'page_exhausted',
          `No stations on page ${input.page} at limit ${input.limit}: the results end before this page.`,
          { page: input.page, limit: input.limit, ...ctx.recoveryFor('page_exhausted') },
        );
      }
      throw ctx.fail('no_locations_found', 'No monitoring stations match the query.', {
        ...ctx.recoveryFor('no_locations_found'),
      });
    }

    // `meta.found` on /v3/locations counts only this page (">limit" on any full page,
    // even the last), so the paging state comes from the rows: every earlier page was
    // full, and a page short of the limit is the last one.
    const counted = (input.page - 1) * input.limit + locations.length;
    ctx.enrich.total(counted);

    if (locations.length >= input.limit) {
      const nextPage = input.page + 1;
      // At the 100 cap there is nowhere left for limit to go, and past page 1 a higher
      // limit re-slices the pages and skips stations — either way, name the next page.
      const nextStep =
        input.limit >= LIMIT_MAX || input.page > 1
          ? `request page ${nextPage}`
          : `raise limit (max ${LIMIT_MAX})`;
      // Name only the area move this search accepts: radius needs coordinates, and
      // bbox cannot join coordinates — either would fail as invalid_search_scope.
      const narrowArea = hasCoordinates
        ? 'a smaller radius'
        : hasBbox
          ? 'a tighter bbox'
          : 'a bbox or coordinates inside the country';
      ctx.enrich({ totalCountIsLowerBound: true });
      ctx.enrich.truncated({
        shown: locations.length,
        cap: input.limit,
        guidance: `Page ${input.page} came back full, so at least ${counted} ${counted === 1 ? 'station matches' : 'stations match'} and page ${nextPage} may hold more. Narrow with parametersId, monitor, mobile, providersId, or ${narrowArea}, or ${nextStep}.`,
      });
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
        `${loc.country.name} (${loc.country.code}) · locality: ${locality} · ${dist} · ${kind} · ${mobile} · provider: ${loc.provider} (${loc.providerId != null ? `providersId ${loc.providerId}` : 'no provider id'})`,
        `coords: ${loc.coordinates.latitude}, ${loc.coordinates.longitude}`,
        `data span: ${first} → ${last}`,
        `parameters: ${params}`,
      ].join('\n');
    });
    return [{ type: 'text', text: lines.join('\n\n') }];
  },
});
