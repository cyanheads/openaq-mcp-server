/**
 * @fileoverview openaq_list_countries tests — headline coverage catalog, local
 * filtering, empty-query notice, and plain-ISO-string datetimes (countries
 * endpoint returns strings, not {utc,local} objects).
 * @module tests/tools/list-countries.tool.test
 */

import {
  JsonRpcErrorCode,
  rateLimited,
  serviceUnavailable,
  timeout,
  unauthorized,
} from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { listCountries } from '@/mcp-server/tools/definitions/list-countries.tool.js';
import { setOpenAqService } from '@/services/openaq/openaq-service.js';
import {
  countries,
  countriesWithNullParameters,
  usSubstringCountries,
} from '../fixtures/openaq.js';
import { installStubService } from '../fixtures/stub-service.js';

afterEach(() => setOpenAqService(undefined as never));

describe('openaq_list_countries', () => {
  it('returns countries with coverage span and measured parameters (the headline goal)', async () => {
    installStubService({ listCountries: async () => countries });
    const ctx = createMockContext();
    const result = await listCountries.handler(listCountries.input.parse({}), ctx);

    expect(result.countries).toHaveLength(2);
    const us = result.countries.find((c) => c.code === 'US');
    expect(us?.datetimeFirst).toBe('2016-01-01T00:00:00Z'); // plain string, not {utc,local}
    expect(us?.parameters.map((p) => p.name)).toContain('pm25');
    expect(getEnrichment(ctx).totalCount).toBe(2);
  });

  it('answers "which countries measure NO2" style queries via local filter', async () => {
    installStubService({ listCountries: async () => countries });
    const ctx = createMockContext();
    const result = await listCountries.handler(listCountries.input.parse({ query: 'india' }), ctx);
    expect(result.countries).toHaveLength(1);
    expect(result.countries[0]?.code).toBe('IN');
  });

  it('returns the exact ISO code match alone for a two-letter query (#4)', async () => {
    installStubService({ listCountries: async () => usSubstringCountries });
    const ctx = createMockContext();
    const result = await listCountries.handler(listCountries.input.parse({ query: 'US' }), ctx);
    expect(result.countries).toHaveLength(1);
    expect(result.countries[0]?.code).toBe('US');
    expect(result.countries[0]?.name).toBe('United States');
  });

  it('treats a lowercase two-letter query as an ISO code, not a substring (#4)', async () => {
    installStubService({ listCountries: async () => usSubstringCountries });
    const ctx = createMockContext();
    const result = await listCountries.handler(listCountries.input.parse({ query: 'us' }), ctx);
    // "us" is a substring of Cyprus/Australia, but the exact US code wins outright.
    expect(result.countries).toHaveLength(1);
    expect(result.countries[0]?.code).toBe('US');
  });

  it('keeps a longer name fragment fuzzy across multiple matches (#4)', async () => {
    installStubService({ listCountries: async () => usSubstringCountries });
    const ctx = createMockContext();
    const result = await listCountries.handler(listCountries.input.parse({ query: 'united' }), ctx);
    expect(result.countries.map((c) => c.code).sort()).toEqual(['GB', 'US']);
  });

  it('emits a notice when the filter matches nothing', async () => {
    installStubService({ listCountries: async () => countries });
    const ctx = createMockContext();
    const result = await listCountries.handler(
      listCountries.input.parse({ query: 'atlantis' }),
      ctx,
    );
    expect(result.countries).toHaveLength(0);
    expect(getEnrichment(ctx).notice).toContain('atlantis');
  });

  it('filters to countries measuring a parameter id (#18)', async () => {
    installStubService({ listCountries: async () => countries });
    const ctx = createMockContext();
    // id 8 (co ppm) is measured in the US fixture only; id 2 (pm25) in both.
    const result = await listCountries.handler(listCountries.input.parse({ parametersId: 8 }), ctx);
    expect(result.countries.map((c) => c.code)).toEqual(['US']);
    expect(getEnrichment(ctx).totalCount).toBe(1);
  });

  it('composes parametersId with query (#18)', async () => {
    installStubService({ listCountries: async () => countries });
    const ctx = createMockContext();
    // "d" is a substring of both "United States" and "India", so the query alone
    // keeps both; parametersId 8 (co ppm, US only) is what narrows to one.
    const result = await listCountries.handler(
      listCountries.input.parse({ query: 'd', parametersId: 8 }),
      ctx,
    );
    expect(result.countries.map((c) => c.code)).toEqual(['US']);
  });

  it('names the missed parameter id and the resolver in the notice (#18)', async () => {
    installStubService({ listCountries: async () => countries });
    const ctx = createMockContext();
    const result = await listCountries.handler(
      listCountries.input.parse({ parametersId: 99999 }),
      ctx,
    );
    expect(result.countries).toHaveLength(0);
    const notice = getEnrichment(ctx).notice as string;
    expect(notice).toContain('parametersId 99999');
    expect(notice).toContain('openaq_list_parameters');
  });

  it('names both filters when a combined query + parametersId misses (#18)', async () => {
    installStubService({ listCountries: async () => countries });
    const ctx = createMockContext();
    await listCountries.handler(
      listCountries.input.parse({ query: 'india', parametersId: 8 }),
      ctx,
    );
    const notice = getEnrichment(ctx).notice as string;
    expect(notice).toContain('query "india"');
    expect(notice).toContain('parametersId 8');
  });

  it('skips a country whose parameters is null instead of throwing (#18, #1)', async () => {
    installStubService({ listCountries: async () => countriesWithNullParameters });
    const ctx = createMockContext();
    const result = await listCountries.handler(listCountries.input.parse({ parametersId: 2 }), ctx);
    expect(result.countries.map((c) => c.code).sort()).toEqual(['IN', 'US']);
  });

  it('returns a country with null parameters as empty array (regression #1)', async () => {
    installStubService({ listCountries: async () => countriesWithNullParameters });
    const ctx = createMockContext();
    const result = await listCountries.handler(listCountries.input.parse({}), ctx);
    const sparse = result.countries.find((c) => c.code === 'XX');
    expect(sparse).toBeDefined();
    expect(sparse?.parameters).toEqual([]);
    expect(getEnrichment(ctx).totalCount).toBe(3);
  });

  it('format emits no block for an empty result so the notice trailer stands alone (#9)', () => {
    // The framework always appends the enrichment trailer (`**0 total**` + the
    // blockquoted notice). Rendering a terse line here too would split the miss
    // from its recovery guidance across two content blocks.
    expect(listCountries.format!({ countries: [] })).toEqual([]);
  });

  it('format renders "none listed" for a country with no parameters (regression #1)', () => {
    const blocks = listCountries.format!({
      countries: [
        {
          id: 999,
          code: 'XX',
          name: 'Sparse Country',
          datetimeFirst: null,
          datetimeLast: null,
          parameters: [],
        },
      ],
    });
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('XX');
    expect(text).toContain('none listed');
  });

  it('format renders code, id, span, and parameter ids/units', () => {
    const blocks = listCountries.format!({
      countries: [
        {
          id: 155,
          code: 'US',
          name: 'United States',
          datetimeFirst: '2016-01-01T00:00:00Z',
          datetimeLast: '2026-06-13T19:00:00Z',
          parameters: [{ id: 2, name: 'pm25', unit: 'µg/m³' }],
        },
      ],
    });
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('US');
    expect(text).toContain('155');
    expect(text).toContain('pm25');
  });
});

describe('openaq_list_countries upstream error contract (#16)', () => {
  const ctxWith = () => createMockContext({ errors: listCountries.errors });

  it('surfaces a 5xx as upstream_error with the declared recovery hint', async () => {
    installStubService({
      listCountries: async () => {
        throw serviceUnavailable('OpenAQ returned HTTP 500.', {
          path: '/countries?limit=1000',
          status: 500,
        });
      },
    });
    await expect(
      listCountries.handler(listCountries.input.parse({}), ctxWith()),
    ).rejects.toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      data: {
        reason: 'upstream_error',
        status: 500,
        retryable: true,
        recovery: { hint: expect.stringContaining('backoff') },
      },
    });
  });

  it('surfaces a 429 as rate_limited, distinct from a generic 5xx', async () => {
    installStubService({
      listCountries: async () => {
        throw rateLimited('OpenAQ rate limit exceeded.', { status: 429, retryAfter: '30' });
      },
    });
    await expect(
      listCountries.handler(listCountries.input.parse({}), ctxWith()),
    ).rejects.toMatchObject({
      code: JsonRpcErrorCode.RateLimited,
      data: {
        reason: 'rate_limited',
        retryAfter: '30',
        recovery: { hint: expect.stringContaining('retryAfter') },
      },
    });
  });

  it('surfaces a timeout as upstream_timeout', async () => {
    installStubService({
      listCountries: async () => {
        throw timeout('OpenAQ did not respond within 15s.', { timeoutMs: 15_000 });
      },
    });
    await expect(
      listCountries.handler(listCountries.input.parse({}), ctxWith()),
    ).rejects.toMatchObject({
      code: JsonRpcErrorCode.Timeout,
      data: { reason: 'upstream_timeout', timeoutMs: 15_000 },
    });
  });

  it('surfaces a 401 as a non-retryable invalid_api_key, not a retryable upstream_error', async () => {
    installStubService({
      listCountries: async () => {
        throw unauthorized('OpenAQ rejected the API key.', { path: '/countries', status: 401 });
      },
    });
    await expect(
      listCountries.handler(listCountries.input.parse({}), ctxWith()),
    ).rejects.toMatchObject({
      code: JsonRpcErrorCode.Unauthorized,
      data: {
        reason: 'invalid_api_key',
        retryable: false,
        status: 401,
        recovery: { hint: expect.stringContaining('OPENAQ_API_KEY') },
      },
    });
  });
});
