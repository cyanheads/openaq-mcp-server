/**
 * @fileoverview openaq://parameters resource — the full pollutant + unit catalog,
 * the same data as openaq_list_parameters. Injectable context for clients that
 * support resources. The unit-disambiguation reference (the same pollutant appears
 * under several ids with different units).
 * @module mcp-server/resources/definitions/parameters.resource
 */

import { resource, z } from '@cyanheads/mcp-ts-core';
import { getOpenAqService } from '@/services/openaq/openaq-service.js';

export const parametersResource = resource('openaq://parameters', {
  name: 'openaq-parameters',
  description:
    'Full catalog of measurable pollutants and their canonical units (id, code, display name, unit, description). Same data as openaq_list_parameters. The unit-disambiguation reference — the same pollutant appears under several ids with different units (CO is id 4 µg/m³, id 8 ppm, id 102 ppb).',
  mimeType: 'application/json',
  params: z.object({}),
  async handler(_params, ctx) {
    const parameters = await getOpenAqService().listParameters(ctx);
    return {
      parameters: parameters.map((p) => ({
        id: p.id,
        name: p.name,
        displayName: p.displayName,
        unit: p.units,
        description: p.description,
      })),
    };
  },
  list: () => ({
    resources: [
      { uri: 'openaq://parameters', name: 'openaq-parameters', mimeType: 'application/json' },
    ],
  }),
});
