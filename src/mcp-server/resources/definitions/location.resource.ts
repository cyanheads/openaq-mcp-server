/**
 * @fileoverview openaq://location/{locationId} resource — location metadata
 * (name, coordinates, country, provider, sensors with parameter + unit, and the
 * datetimeFirst/datetimeLast span) for a known location id. A stable-URI mirror of
 * openaq_find_locations / openaq_get_readings output for clients that support resources.
 * @module mcp-server/resources/definitions/location.resource
 */

import { resource, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError, notFound } from '@cyanheads/mcp-ts-core/errors';
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
  async handler(params, ctx) {
    const id = Number(params.locationId);
    if (!Number.isInteger(id) || id <= 0) {
      throw notFound(`Invalid location id "${params.locationId}".`, {
        locationId: params.locationId,
      });
    }
    let location: OpenAqLocation;
    try {
      location = await getOpenAqService().getLocation(id, ctx);
    } catch (err) {
      if (err instanceof McpError && err.code === JsonRpcErrorCode.NotFound) {
        throw notFound(`OpenAQ has no location ${id}.`, { locationId: id }, { cause: err });
      }
      throw err;
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
