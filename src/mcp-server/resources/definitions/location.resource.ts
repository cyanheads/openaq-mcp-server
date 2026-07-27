/**
 * @fileoverview openaq://location/{locationId} resource — location metadata
 * (name, coordinates, country, provider, sensors with parameter + unit, and the
 * datetimeFirst/datetimeLast span) for a known location id. A stable-URI mirror of
 * openaq_find_locations / openaq_get_readings output for clients that support resources.
 * @module mcp-server/resources/definitions/location.resource
 */

import { resource, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { upstreamFailure } from '@/mcp-server/tools/shared/upstream-errors.js';
import { getOpenAqService } from '@/services/openaq/openaq-service.js';
import type { OpenAqLocation } from '@/services/openaq/types.js';

export const locationResource = resource('openaq://location/{locationId}', {
  name: 'openaq-location',
  description:
    'Location metadata for a known OpenAQ location id: name, coordinates, country, provider, the sensors it carries (each with parameter + unit), and the datetimeFirst/datetimeLast data span. Mirror of openaq_find_locations output for a single station.',
  mimeType: 'application/json',
  params: z.object({
    locationId: z.string().describe('OpenAQ location id (numeric).'),
  }),
  errors: [
    {
      reason: 'invalid_location_id',
      code: JsonRpcErrorCode.NotFound,
      when: 'The {locationId} path segment is not a positive integer.',
      recovery:
        'Rebuild the URI with the numeric id field from an openaq_find_locations result, e.g. openaq://location/931.',
      retryable: false,
    },
    {
      reason: 'location_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'OpenAQ has no location with this id (returned 404 or an empty result).',
      recovery:
        'Confirm the id with openaq_find_locations for the area you want; a station that was retired keeps its id out of the catalog.',
      retryable: false,
    },
    {
      reason: 'upstream_error',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'OpenAQ /locations/{id} returned 5xx or an unreadable body on every retry.',
      recovery:
        'Retry after a short backoff; if it keeps failing, OpenAQ is degraded rather than the id being wrong.',
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
      when: 'OpenAQ /locations/{id} did not respond within the request timeout on every retry.',
      recovery:
        'Retry once after a short pause; a single-location read is small, so a timeout points at OpenAQ being slow.',
      retryable: true,
    },
    {
      reason: 'invalid_api_key',
      code: JsonRpcErrorCode.Unauthorized,
      when: 'OpenAQ returned 401 — the configured OPENAQ_API_KEY is missing, invalid, or revoked.',
      recovery:
        "Stop retrying — every OpenAQ read fails until the server's OPENAQ_API_KEY is replaced with a valid key from an OpenAQ Explorer account.",
      retryable: false,
    },
  ],
  async handler(params, ctx) {
    const id = Number(params.locationId);
    if (!Number.isInteger(id) || id <= 0) {
      throw ctx.fail('invalid_location_id', `Invalid location id "${params.locationId}".`, {
        locationId: params.locationId,
        ...ctx.recoveryFor('invalid_location_id'),
      });
    }
    let location: OpenAqLocation;
    try {
      location = await getOpenAqService().getLocation(id, ctx);
    } catch (err) {
      if (err instanceof McpError && err.code === JsonRpcErrorCode.NotFound) {
        throw ctx.fail(
          'location_not_found',
          `OpenAQ has no location ${id}.`,
          { locationId: id, ...ctx.recoveryFor('location_not_found') },
          { cause: err },
        );
      }
      throw upstreamFailure(ctx, err);
    }
    return {
      id: location.id,
      name: location.name,
      locality: location.locality,
      timezone: location.timezone,
      country: location.country,
      provider: location.provider,
      isMonitor: location.isMonitor,
      isMobile: location.isMobile,
      coordinates: location.coordinates,
      sensors: location.sensors.map((s) => ({
        id: s.id,
        parameterId: s.parameter.id,
        parameter: s.parameter.name,
        unit: s.parameter.units,
        displayName: s.parameter.displayName,
      })),
      datetimeFirst: location.datetimeFirst,
      datetimeLast: location.datetimeLast,
    };
  },
});
