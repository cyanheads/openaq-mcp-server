/**
 * @fileoverview openaq_list_countries — catalog of country-level coverage: id,
 * ISO code, name, the date span of available station data, and which parameters
 * are measured anywhere in that country. The availability check before a regional
 * openaq_find_locations sweep — answers "which countries have NO2 monitoring?".
 * @module mcp-server/tools/definitions/list-countries.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getOpenAqService } from '@/services/openaq/openaq-service.js';

export const listCountries = tool('openaq_list_countries', {
  title: 'openaq-mcp-server: list countries',
  description:
    'Catalog of country-level coverage: id, ISO code, name, the date span of available station data (datetimeFirst/datetimeLast), and which parameters are measured anywhere in that country. The availability check before a regional sweep — answers "which countries have NO2 monitoring?" and tells you whether a country has recent data before you call openaq_find_locations. Coverage is uneven worldwide; this surfaces where measured data exists.',
  annotations: { readOnlyHint: true, idempotentHint: true },
  input: z.object({
    query: z
      .string()
      .optional()
      .describe(
        'Case-insensitive filter over the bounded country catalog (~153) by code and name. A two-letter query is treated as an exact ISO 3166-1 alpha-2 code (e.g. "US" → United States); longer queries match as substrings (e.g. "united", "germany"). Omit to list all.',
      ),
  }),
  output: z.object({
    countries: z
      .array(
        z
          .object({
            id: z.number().describe('Country id (OpenAQ internal)'),
            code: z
              .string()
              .describe('ISO 3166-1 alpha-2 code — pass as iso to openaq_find_locations'),
            name: z.string().describe('Country name'),
            datetimeFirst: z
              .string()
              .nullable()
              .describe(
                'UTC timestamp of the earliest available measurement in this country (ISO 8601)',
              ),
            datetimeLast: z
              .string()
              .nullable()
              .describe(
                'UTC timestamp of the most recent measurement — recent means the country has live coverage',
              ),
            parameters: z
              .array(
                z
                  .object({
                    id: z.number().describe('Parameter id measured somewhere in this country'),
                    name: z.string().describe('Pollutant code'),
                    unit: z.string().describe('Unit for this parameter id'),
                  })
                  .describe('A parameter measured somewhere in this country'),
              )
              .describe(
                'Parameters measured anywhere in this country — a coverage hint, not a per-station guarantee',
              ),
          })
          .describe('A country with its coverage span and measured parameters'),
      )
      .describe('Matching countries with coverage metadata.'),
  }),
  enrichment: {
    totalCount: z.number().describe('Total countries matched after filtering.'),
    notice: z.string().optional().describe('Guidance when the query matched nothing.'),
  },
  errors: [
    {
      reason: 'upstream_error',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'OpenAQ /countries returned 5xx, a rate-limit, or timed out.',
      recovery: 'Retry after a short backoff. The free tier allows about 60 requests per minute.',
      retryable: true,
    },
  ],

  async handler(input, ctx) {
    const all = await getOpenAqService().listCountries(ctx);
    let filtered = all;

    if (input.query) {
      const q = input.query.toLowerCase();
      // A two-letter query is an ISO 3166-1 alpha-2 lookup first: an exact code match
      // wins outright (so "US" → United States, not every name containing "us").
      // Fall back to substring when there's no exact code match, or for longer queries.
      const exactCode = q.length === 2 ? all.find((c) => c.code.toLowerCase() === q) : undefined;
      filtered = exactCode
        ? [exactCode]
        : all.filter((c) => c.code.toLowerCase().includes(q) || c.name.toLowerCase().includes(q));
    }

    ctx.enrich.total(filtered.length);
    if (filtered.length === 0) {
      ctx.enrich.notice(
        input.query
          ? `No countries matched "${input.query}". Broaden or drop the filter to browse the full list.`
          : 'No countries returned from OpenAQ.',
      );
    }

    ctx.log.info('Listed countries', { total: all.length, shown: filtered.length });

    return {
      countries: filtered.map((c) => ({
        id: c.id,
        code: c.code,
        name: c.name,
        datetimeFirst: c.datetimeFirst,
        datetimeLast: c.datetimeLast,
        parameters: (c.parameters ?? []).map((p) => ({ id: p.id, name: p.name, unit: p.units })),
      })),
    };
  },

  format: (result) => {
    if (result.countries.length === 0) {
      return [{ type: 'text', text: 'No countries matched.' }];
    }
    const lines = result.countries.map((c) => {
      const span = `${c.datetimeFirst ?? 'unknown'} → ${c.datetimeLast ?? 'unknown'}`;
      const params =
        c.parameters.map((p) => `${p.name} #${p.id} (${p.unit})`).join(', ') || 'none listed';
      return `- **${c.code}** ${c.name} (id ${c.id}) · span ${span}\n  parameters: ${params}`;
    });
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
