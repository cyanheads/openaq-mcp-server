/**
 * @fileoverview openaq_list_countries tests — headline coverage catalog, local
 * filtering, empty-query notice, plain-ISO-string datetimes (countries endpoint
 * returns strings, not {utc,local} objects), paging of the filtered list (#28),
 * and the positive-id bound on parametersId (#33).
 * @module tests/tools/list-countries.tool.test
 */

import { z } from '@cyanheads/mcp-ts-core';
import {
  JsonRpcErrorCode,
  rateLimited,
  serviceUnavailable,
  timeout,
  unauthorized,
} from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { listCountries } from '@/mcp-server/tools/definitions/list-countries.tool.js';
import { setOpenAqService } from '@/services/openaq/openaq-service.js';
import {
  countries,
  countriesWithNullParameters,
  makeCountries,
  usSubstringCountries,
} from '../fixtures/openaq.js';
import { installStubService } from '../fixtures/stub-service.js';

const ctxWith = () => createMockContext({ errors: listCountries.errors });

/**
 * Every test starts with a fetch that rejects, so a path that reaches the network
 * without a stubbed service fails loudly instead of calling the live, rate-limited
 * OpenAQ API.
 */
beforeEach(() => {
  vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('unmocked fetch in a unit test'));
});

afterEach(() => {
  setOpenAqService(undefined as never);
  vi.restoreAllMocks();
});

/** Concatenated text of every content block — the domain render plus the enrichment trailer. */
const contentText = (result: { content: readonly { type: string; text?: string }[] }): string =>
  result.content.map((block) => (block.type === 'text' ? (block.text ?? '') : '')).join('\n');

/** The country codes `format()` rendered, in order — one `- **CODE**` line per row. */
const renderedCodes = (text: string): string[] =>
  [...text.matchAll(/^- \*\*(\S+)\*\* /gm)].map((m) => m[1] as string);

describe('openaq_list_countries', () => {
  it('returns countries with coverage span and measured parameters (the headline goal)', async () => {
    installStubService({ listCountries: async () => countries });
    const ctx = ctxWith();
    const result = await listCountries.handler(listCountries.input.parse({}), ctx);

    expect(result.countries).toHaveLength(2);
    const us = result.countries.find((c) => c.code === 'US');
    expect(us?.datetimeFirst).toBe('2016-01-01T00:00:00Z'); // plain string, not {utc,local}
    expect(us?.parameters.map((p) => p.name)).toContain('pm25');
    expect(getEnrichment(ctx).totalCount).toBe(2);
  });

  it('answers "which countries measure NO2" style queries via local filter', async () => {
    installStubService({ listCountries: async () => countries });
    const ctx = ctxWith();
    const result = await listCountries.handler(listCountries.input.parse({ query: 'india' }), ctx);
    expect(result.countries).toHaveLength(1);
    expect(result.countries[0]?.code).toBe('IN');
  });

  it('returns the exact ISO code match alone for a two-letter query (#4)', async () => {
    installStubService({ listCountries: async () => usSubstringCountries });
    const ctx = ctxWith();
    const result = await listCountries.handler(listCountries.input.parse({ query: 'US' }), ctx);
    expect(result.countries).toHaveLength(1);
    expect(result.countries[0]?.code).toBe('US');
    expect(result.countries[0]?.name).toBe('United States');
  });

  it('treats a lowercase two-letter query as an ISO code, not a substring (#4)', async () => {
    installStubService({ listCountries: async () => usSubstringCountries });
    const ctx = ctxWith();
    const result = await listCountries.handler(listCountries.input.parse({ query: 'us' }), ctx);
    // "us" is a substring of Cyprus/Australia, but the exact US code wins outright.
    expect(result.countries).toHaveLength(1);
    expect(result.countries[0]?.code).toBe('US');
  });

  it('keeps a longer name fragment fuzzy across multiple matches (#4)', async () => {
    installStubService({ listCountries: async () => usSubstringCountries });
    const ctx = ctxWith();
    const result = await listCountries.handler(listCountries.input.parse({ query: 'united' }), ctx);
    expect(result.countries.map((c) => c.code).sort()).toEqual(['GB', 'US']);
  });

  it('emits a notice when the filter matches nothing', async () => {
    installStubService({ listCountries: async () => countries });
    const ctx = ctxWith();
    const result = await listCountries.handler(
      listCountries.input.parse({ query: 'atlantis' }),
      ctx,
    );
    expect(result.countries).toHaveLength(0);
    expect(getEnrichment(ctx).notice).toContain('atlantis');
  });

  it('filters to countries measuring a parameter id (#18)', async () => {
    installStubService({ listCountries: async () => countries });
    const ctx = ctxWith();
    // id 8 (co ppm) is measured in the US fixture only; id 2 (pm25) in both.
    const result = await listCountries.handler(listCountries.input.parse({ parametersId: 8 }), ctx);
    expect(result.countries.map((c) => c.code)).toEqual(['US']);
    expect(getEnrichment(ctx).totalCount).toBe(1);
  });

  it('composes parametersId with query (#18)', async () => {
    installStubService({ listCountries: async () => countries });
    const ctx = ctxWith();
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
    const ctx = ctxWith();
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
    const ctx = ctxWith();
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
    const ctx = ctxWith();
    const result = await listCountries.handler(listCountries.input.parse({ parametersId: 2 }), ctx);
    expect(result.countries.map((c) => c.code).sort()).toEqual(['IN', 'US']);
  });

  it('returns a country with null parameters as empty array (regression #1)', async () => {
    installStubService({ listCountries: async () => countriesWithNullParameters });
    const ctx = ctxWith();
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

  it("describes code as OpenAQ's country code, -99 placeholder included (#39)", () => {
    // OpenAQ lists Dhekelia under "-99"; the description has to agree with what
    // openaq_find_locations accepts as iso, since it tells callers to pass it there.
    const emitted = z.toJSONSchema(listCountries.output) as unknown as {
      properties: {
        countries: { items: { properties: { code: { description: string } } } };
      };
    };
    const description = emitted.properties.countries.items.properties.code.description;
    expect(description).toContain('-99');
    expect(description).toContain('ISO 3166-1 alpha-2');
    expect(description).toContain('openaq_find_locations');
  });

  it('relays the -99 placeholder code verbatim', async () => {
    installStubService({
      listCountries: async () => [
        {
          id: 7,
          code: '-99',
          name: 'Dhekelia',
          datetimeFirst: null,
          datetimeLast: null,
          parameters: [],
        },
      ],
    });
    const result = await listCountries.handler(
      listCountries.input.parse({ query: 'Dhekelia' }),
      ctxWith(),
    );
    expect(result.countries.map((c) => c.code)).toEqual(['-99']);
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

describe('openaq_list_countries assembled result (runToolContract)', () => {
  it('carries a catalog that fits one page on both surfaces, with no truncation fields', async () => {
    installStubService({ listCountries: async () => countries });
    const result = await runToolContract(listCountries, {});
    expect(result.isError).toBeFalsy();
    const structured = result.structuredContent as Record<string, unknown>;
    expect(structured).toMatchObject({ totalCount: 2 });
    expect((structured.countries as { code: string }[]).map((c) => c.code)).toEqual(['US', 'IN']);
    expect(structured).not.toHaveProperty('truncated');
    expect(structured).not.toHaveProperty('notice');
    const text = contentText(result);
    expect(renderedCodes(text)).toEqual(['US', 'IN']);
    expect(text).toContain('2 total');
  });
});

describe('openaq_list_countries paging (#28)', () => {
  /** Run one page through the assembled result; returns both surfaces. */
  const runPage = async (catalog: ReturnType<typeof makeCountries>, input: object) => {
    installStubService({ listCountries: async () => catalog });
    const result = await runToolContract(listCountries, input);
    expect(result.isError).toBeFalsy();
    const structured = result.structuredContent as {
      countries: { id: number; code: string; parameters: { id: number }[] }[];
      totalCount: number;
      truncated?: boolean;
      shown?: number;
      cap?: number;
      notice?: string;
    };
    const text = contentText(result);
    // content[] renders exactly the rows structuredContent carries, on every page.
    expect(renderedCodes(text)).toEqual(structured.countries.map((c) => c.code));
    return { structured, text };
  };

  const ids = (rows: { id: number }[]) => rows.map((r) => r.id);
  const range = (from: number, to: number) =>
    Array.from({ length: to - from + 1 }, (_, i) => from + i);

  it('defaults to the first 20 rows in upstream order and names page 2', async () => {
    const { structured, text } = await runPage(makeCountries(158), {});
    expect(ids(structured.countries)).toEqual(range(1, 20));
    expect(structured).toMatchObject({ totalCount: 158, truncated: true, shown: 20, cap: 20 });
    expect(structured.notice).toContain('page 2');
    expect(text).toContain('158 total');
    expect(text).toContain('page 2');
  });

  it('returns rows 21–40 on page 2, with no overlap with page 1, and names page 3', async () => {
    const catalog = makeCountries(45);
    const first = await runPage(catalog, {});
    const second = await runPage(catalog, { page: 2 });
    expect(ids(second.structured.countries)).toEqual(range(21, 40));
    const overlap = ids(first.structured.countries).filter((id) =>
      ids(second.structured.countries).includes(id),
    );
    expect(overlap).toEqual([]);
    expect(second.structured).toMatchObject({
      totalCount: 45,
      truncated: true,
      shown: 20,
      cap: 20,
    });
    expect(second.structured.notice).toContain('page 3');
  });

  it('walks every page of a catalog and reassembles it exactly once', async () => {
    const catalog = makeCountries(45);
    const seen: number[] = [];
    for (const page of [1, 2, 3]) {
      const { structured } = await runPage(catalog, { page });
      seen.push(...ids(structured.countries));
      expect(structured.totalCount).toBe(45);
    }
    expect(seen).toEqual(range(1, 45));
  });

  it('returns a partial last page with no truncation fields', async () => {
    const { structured } = await runPage(makeCountries(45), { page: 3 });
    expect(ids(structured.countries)).toEqual(range(41, 45));
    expect(structured.totalCount).toBe(45);
    for (const key of ['truncated', 'shown', 'cap', 'notice']) {
      expect(structured).not.toHaveProperty(key);
    }
  });

  it('returns the 58-row remainder of a 158-row catalog at limit 100, untruncated', async () => {
    const { structured } = await runPage(makeCountries(158), { limit: 100, page: 2 });
    expect(ids(structured.countries)).toEqual(range(101, 158));
    expect(structured).not.toHaveProperty('truncated');
  });

  it('does not mark an exactly full last page truncated', async () => {
    const { structured } = await runPage(makeCountries(40), { limit: 20, page: 2 });
    expect(ids(structured.countries)).toEqual(range(21, 40));
    expect(structured.totalCount).toBe(40);
    expect(structured).not.toHaveProperty('truncated');
    expect(structured).not.toHaveProperty('notice');
  });

  it('answers a page past the end with an empty success naming the last page', async () => {
    const { structured, text } = await runPage(makeCountries(45), { page: 99 });
    expect(structured.countries).toEqual([]);
    expect(structured.totalCount).toBe(45);
    expect(structured).not.toHaveProperty('truncated');
    expect(structured.notice).toContain('page 3');
    expect(text).toContain('45 total');
    expect(text).toContain('page 3');
  });

  it('names page 1 alone when a single-page result is paged past its end', async () => {
    const { structured } = await runPage(makeCountries(3), { page: 2 });
    expect(structured.countries).toEqual([]);
    expect(structured.notice).toContain('the last page is 1. Request page 1.');
    expect(structured.notice).not.toContain('or earlier');
  });

  it('applies parametersId before paging: totalCount is the filtered count', async () => {
    // Every third country (15 of 45) measures no2 (id 5).
    const { structured } = await runPage(makeCountries(45), { parametersId: 5, limit: 5 });
    expect(structured.countries).toHaveLength(5);
    for (const c of structured.countries) {
      expect(c.parameters.map((p) => p.id)).toContain(5);
    }
    expect(ids(structured.countries)).toEqual([1, 4, 7, 10, 13]);
    expect(structured).toMatchObject({ totalCount: 15, truncated: true, shown: 5, cap: 5 });
  });

  it('pages a filtered list past its first page', async () => {
    // "country 1" matches Country 1 and Country 10–19: 11 rows, so page 3 at limit 5 holds one.
    const { structured } = await runPage(makeCountries(45), {
      query: 'country 1',
      limit: 5,
      page: 3,
    });
    expect(ids(structured.countries)).toEqual([19]);
    expect(structured.totalCount).toBe(11);
    expect(structured).not.toHaveProperty('truncated');
  });

  it('keeps the no-match notice and sets no truncation fields when a filter matches nothing', async () => {
    for (const page of [1, 4]) {
      const { structured } = await runPage(makeCountries(45), { parametersId: 99999, page });
      expect(structured.countries).toEqual([]);
      expect(structured.totalCount).toBe(0);
      expect(structured.notice).toContain('No countries matched parametersId 99999');
      expect(structured).not.toHaveProperty('truncated');
    }
  });

  it('renders a null-parameters country as an empty list inside a page', async () => {
    const { structured, text } = await runPage(makeCountries(45, 22), { page: 2 });
    const sparse = structured.countries.find((c) => c.id === 22);
    expect(sparse?.parameters).toEqual([]);
    expect(text).toContain('none listed');
  });

  it.each([
    ['limit 0', { limit: 0 }, 'limit'],
    ['limit 101', { limit: 101 }, 'limit'],
    ['page 0', { page: 0 }, 'page'],
    ['fractional limit', { limit: 2.5 }, 'limit'],
  ])('rejects %s at the schema before any request', async (_label, input, field) => {
    const listCountriesSpy = vi.fn(async () => makeCountries(45));
    installStubService({ listCountries: listCountriesSpy });
    const result = await runToolContract(listCountries, input);
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: {
        code: JsonRpcErrorCode.InvalidParams,
        data: { reason: 'invalid_arguments', issues: [{ path: [field] }] },
      },
    });
    expect(listCountriesSpy).not.toHaveBeenCalled();
  });

  it('advertises limit (1–100, default 20) and page (≥ 1, default 1)', () => {
    const emitted = z.toJSONSchema(listCountries.input, { io: 'input' }) as {
      properties: Record<string, Record<string, unknown>>;
    };
    expect(emitted.properties.limit).toMatchObject({
      type: 'integer',
      minimum: 1,
      maximum: 100,
      default: 20,
    });
    expect(emitted.properties.page).toMatchObject({ type: 'integer', minimum: 1, default: 1 });
  });
});

describe('openaq_list_countries parametersId must be positive (#33)', () => {
  it('advertises parametersId as an integer with its description', () => {
    const emitted = z.toJSONSchema(listCountries.input, { io: 'input' }) as {
      properties: Record<string, Record<string, unknown>>;
    };
    expect(emitted.properties.parametersId).toMatchObject({
      type: 'integer',
      description: expect.stringContaining('openaq_list_parameters'),
    });
  });

  it('advertises exclusiveMinimum 0', () => {
    const emitted = z.toJSONSchema(listCountries.input, { io: 'input' }) as {
      properties: Record<string, Record<string, unknown>>;
    };
    expect(emitted.properties.parametersId).toMatchObject({ exclusiveMinimum: 0 });
    expect(emitted.properties.parametersId).not.toHaveProperty('minimum');
  });

  it.each([0, -1])(
    'rejects parametersId %i as invalid_arguments, not an empty result',
    async (parametersId) => {
      const listCountriesSpy = vi.fn(async () => countries);
      installStubService({ listCountries: listCountriesSpy });
      const result = await runToolContract(listCountries, { parametersId });
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        error: {
          code: JsonRpcErrorCode.InvalidParams,
          data: { reason: 'invalid_arguments', issues: [{ path: ['parametersId'] }] },
        },
      });
      expect(contentText(result)).toContain('parametersId');
      expect(listCountriesSpy).not.toHaveBeenCalled();
      expect(globalThis.fetch).not.toHaveBeenCalled();
    },
  );

  it('still accepts parametersId 1, the lowest id in the catalog', () => {
    expect(listCountries.input.parse({ parametersId: 1 }).parametersId).toBe(1);
  });
});
