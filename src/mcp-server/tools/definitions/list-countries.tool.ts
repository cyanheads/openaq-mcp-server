/**
 * @fileoverview openaq_list_countries — catalog of country-level coverage: id,
 * OpenAQ country code, name, the date span of available station data, and which
 * parameters are measured anywhere in that country. The availability check before
 * a regional openaq_find_locations sweep — answers "which countries have NO2
 * monitoring?". The catalog is fetched whole and filtered locally, then paged.
 * @module mcp-server/tools/definitions/list-countries.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { withUpstream } from '@/mcp-server/tools/shared/upstream-errors.js';
import { getOpenAqService } from '@/services/openaq/openaq-service.js';

/** Largest page a caller can request, matching openaq_find_locations. */
const LIMIT_MAX = 100;

export const listCountries = tool('openaq_list_countries', {
  title: 'openaq-mcp-server: list countries',
  description:
    'Catalog of country-level coverage: id, OpenAQ country code, name, the date span of available station data (datetimeFirst/datetimeLast), and which parameters are measured anywhere in that country. The availability check before a regional sweep — answers "which countries have NO2 monitoring?" and tells you whether a country has recent data before you call openaq_find_locations. Coverage is uneven worldwide; this surfaces where measured data exists. Results come a page at a time (20 countries by default); totalCount is the full filtered count.',
  annotations: { readOnlyHint: true, idempotentHint: true },
  input: z.object({
    query: z
      .string()
      .optional()
      .describe(
        'Case-insensitive filter over the country catalog by code and name. A two-letter query matches an exact ISO 3166-1 alpha-2 code first (e.g. "US" → United States) and falls back to substrings when no code matches; longer queries match as substrings (e.g. "united", "germany"). Omit to page through the whole catalog.',
      ),
    parametersId: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(
        'Only return countries that measure this parameter id somewhere (e.g. 2 = PM2.5 µg/m³) — the one-call answer to "which countries have NO2 monitoring?". Get ids from openaq_list_parameters; the same pollutant has several ids for different units. Composes with query.',
      ),
    limit: z
      .number()
      .int()
      .min(1)
      .max(LIMIT_MAX)
      .default(20)
      .describe(
        'Max countries to return (1–100). Default 20. Applied after query and parametersId, in OpenAQ catalog order.',
      ),
    page: z
      .number()
      .int()
      .min(1)
      .default(1)
      .describe(
        'Which page of the filtered list to return (1-based). Default 1. With limit 20, page 2 returns countries 21–40. A page past the last one returns no countries and a notice naming the last page.',
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
              .describe(
                'OpenAQ country code: ISO 3166-1 alpha-2, or "-99" where OpenAQ has none — pass as iso to openaq_find_locations',
              ),
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
    totalCount: z
      .number()
      .describe('Countries matched after query and parametersId, across every page.'),
    truncated: z
      .boolean()
      .optional()
      .describe('True when more matching countries follow on later pages.'),
    shown: z.number().optional().describe('Number of countries returned on this page.'),
    cap: z.number().optional().describe('The limit that was applied.'),
    notice: z
      .string()
      .optional()
      .describe(
        'Guidance when the filters matched nothing, when more pages follow (the next page to request), or when the page is past the last one.',
      ),
  },
  errors: [
    {
      reason: 'upstream_error',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'OpenAQ /countries returned 5xx or an unreadable body on every retry.',
      recovery:
        'Retry after a short backoff; if it keeps failing, OpenAQ is degraded and the catalog is briefly unavailable.',
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
      when: 'OpenAQ /countries did not respond within the request timeout on every retry.',
      recovery:
        'Retry once after a short pause; a timeout here means OpenAQ is slow, not that coverage is missing.',
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
    const all = await withUpstream(ctx, () => getOpenAqService().listCountries(ctx));
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

    // Coverage filter: the country carries the union of parameters measured at any
    // of its stations. `parameters` is nullable upstream (#1), so guard the miss.
    const parametersId = input.parametersId;
    if (parametersId !== undefined) {
      filtered = filtered.filter((c) => c.parameters?.some((p) => p.id === parametersId) ?? false);
    }

    const total = filtered.length;
    ctx.enrich.total(total);

    // Page the filtered list in upstream (ascending country id) order. The total is
    // exact, so truncation means rows remain past this page — an exactly full last
    // page is not truncated.
    const start = (input.page - 1) * input.limit;
    const pageRows = filtered.slice(start, start + input.limit);
    const lastPage = Math.ceil(total / input.limit);

    if (total === 0) {
      const criteria = [
        ...(input.query ? [`query "${input.query}"`] : []),
        ...(parametersId !== undefined ? [`parametersId ${parametersId}`] : []),
      ];
      const recovery =
        parametersId !== undefined
          ? 'Verify the id with openaq_list_parameters, or drop the filter to browse the full list.'
          : 'Broaden or drop the filter to browse the full list.';
      ctx.enrich.notice(
        criteria.length === 0
          ? 'No countries returned from OpenAQ.'
          : `No countries matched ${criteria.join(' and ')}. ${recovery}`,
      );
    } else if (pageRows.length === 0) {
      ctx.enrich.notice(
        `Page ${input.page} is past the end: ${total} ${total === 1 ? 'country matches' : 'countries match'}, so at limit ${input.limit} the last page is ${lastPage}. Request page ${lastPage}${lastPage > 1 ? ' or earlier' : ''}.`,
      );
    } else if (start + pageRows.length < total) {
      const nextPage = input.page + 1;
      // On page 1 below the cap, a higher limit reaches the rest in fewer calls; past
      // page 1 it would re-slice the pages, so name only the next page there.
      const raise =
        input.page === 1 && input.limit < LIMIT_MAX ? ` or raise limit (max ${LIMIT_MAX})` : '';
      ctx.enrich.truncated({
        shown: pageRows.length,
        cap: input.limit,
        guidance: `Page ${input.page} of ${lastPage} shows countries ${start + 1}–${start + pageRows.length} of ${total}. Request page ${nextPage}${raise} for more, or narrow with query or parametersId.`,
      });
    }

    ctx.log.info('Listed countries', {
      total: all.length,
      matched: total,
      page: input.page,
      shown: pageRows.length,
    });

    return {
      countries: pageRows.map((c) => ({
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
    // Empty page: render nothing. The framework unconditionally appends the
    // enrichment trailer (the total plus the blockquoted notice naming the filter
    // that missed, or the last page when this one is past the end), so it stands
    // alone as the single content block — one paragraph. A terse line here would
    // only split the miss from its guidance across two blocks; it can never
    // replace the trailer.
    if (result.countries.length === 0) return [];
    const lines = result.countries.map((c) => {
      const span = `${c.datetimeFirst ?? 'unknown'} → ${c.datetimeLast ?? 'unknown'}`;
      const params =
        c.parameters.map((p) => `${p.name} #${p.id} (${p.unit})`).join(', ') || 'none listed';
      return `- **${c.code}** ${c.name} (id ${c.id}) · span ${span}\n  parameters: ${params}`;
    });
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
