/**
 * @fileoverview openaq_list_parameters — catalog of measurable pollutants and
 * their canonical units. The unit-disambiguation reference: the same pollutant
 * appears under several ids with different units (co is id 4 µg/m³, id 8 ppm,
 * id 102 ppb), so this maps a pollutant + desired unit to the exact parametersId
 * the other tools take.
 * @module mcp-server/tools/definitions/list-parameters.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getOpenAqService } from '@/services/openaq/openaq-service.js';
import type { OpenAqParameter } from '@/services/openaq/types.js';

/**
 * Codes/name-fragments for the meteorological & particle-count channels excluded
 * by `pollutantsOnly`. Matched against the parameter `name` (lowercased).
 */
const NON_POLLUTANT_PATTERNS = [
  'temperature',
  'humidity',
  'pressure',
  'wind_speed',
  'wind_direction',
  'um003',
  'um010',
  'um025',
  'um100',
  'ufp',
];

const isPollutant = (p: OpenAqParameter): boolean => {
  const name = p.name.toLowerCase();
  return !NON_POLLUTANT_PATTERNS.some((pat) => name.includes(pat));
};

export const listParameters = tool('openaq_list_parameters', {
  title: 'openaq-mcp-server: list parameters',
  description:
    "Catalog of every measurable pollutant and its canonical unit: id, code, display name, unit, and a one-line description (pm25, pm10, o3, no2, so2, co, bc, and ~38 more). This is the unit-disambiguation reference — the same pollutant exists under several ids with different units (CO is id 4 in µg/m³, id 8 in ppm, id 102 in ppb), so use this to pick the exact parametersId for openaq_find_locations / openaq_get_readings / openaq_get_measurements and to interpret a reading's unit. A small bounded catalog fetched live from OpenAQ.",
  annotations: { readOnlyHint: true, idempotentHint: true },
  input: z.object({
    query: z
      .string()
      .optional()
      .describe(
        'Local case-insensitive filter on code, display name, and description (e.g. "pm" for particulates, "ozone", "co"). The full catalog is small (~44 entries); omit to list everything. This filters the fetched list on our side — it is not an upstream search.',
      ),
    pollutantsOnly: z
      .boolean()
      .default(false)
      .describe(
        'When true, exclude meteorological/auxiliary parameters (temperature, humidity, wind, pressure, particle-count channels) and return only air pollutants. Default false (full catalog).',
      ),
  }),
  output: z.object({
    parameters: z
      .array(
        z
          .object({
            id: z
              .number()
              .describe('Parameter id — the precise selector for the other tools (unit-specific)'),
            name: z.string().describe('Pollutant code (e.g. "pm25", "o3", "co")'),
            displayName: z
              .string()
              .nullable()
              .describe('Human-readable name (e.g. "PM2.5", "O₃ mass")'),
            unit: z
              .string()
              .describe(
                'Canonical measurement unit for this id (e.g. "µg/m³", "ppm", "ppb"). The same pollutant code appears under multiple ids with different units.',
              ),
            description: z.string().nullable().describe('One-line description of the pollutant'),
          })
          .describe('A measurable parameter with its canonical unit'),
      )
      .describe(
        'Matching parameters. Multiple rows can share a name with different ids/units — pick the id whose unit you want.',
      ),
  }),
  enrichment: {
    totalCount: z.number().describe('Total parameters matched after filtering.'),
    notice: z.string().optional().describe('Guidance when the query matched nothing.'),
  },
  errors: [
    {
      reason: 'upstream_error',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'OpenAQ /parameters returned 5xx, a rate-limit, or timed out.',
      recovery: 'Retry after a short backoff. The free tier allows about 60 requests per minute.',
      retryable: true,
    },
  ],

  async handler(input, ctx) {
    const all = await getOpenAqService().listParameters(ctx);
    let filtered = input.pollutantsOnly ? all.filter(isPollutant) : all;

    if (input.query) {
      const q = input.query.toLowerCase();
      filtered = filtered.filter(
        (p) =>
          p.name.toLowerCase().includes(q) ||
          (p.displayName?.toLowerCase().includes(q) ?? false) ||
          (p.description?.toLowerCase().includes(q) ?? false),
      );
    }

    ctx.enrich.total(filtered.length);
    if (filtered.length === 0) {
      ctx.enrich.notice(
        input.query
          ? `No parameters matched "${input.query}". Broaden or drop the filter to browse the full catalog.`
          : 'No parameters returned from OpenAQ.',
      );
    }

    ctx.log.info('Listed parameters', {
      total: all.length,
      shown: filtered.length,
      pollutantsOnly: input.pollutantsOnly,
    });

    return {
      parameters: filtered.map((p) => ({
        id: p.id,
        name: p.name,
        displayName: p.displayName,
        unit: p.units,
        description: p.description,
      })),
    };
  },

  format: (result) => {
    if (result.parameters.length === 0) {
      return [{ type: 'text', text: 'No parameters matched.' }];
    }
    const lines = result.parameters.map((p) => {
      const display = p.displayName ?? p.name;
      const desc = p.description ? ` — ${p.description}` : '';
      return `- **${p.id}** \`${p.name}\` (${p.unit}) · ${display}${desc}`;
    });
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
