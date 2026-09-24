/**
 * @fileoverview openaq_find_locations tests — near-me discovery (the headline
 * goal), scope validation, empty-result NotFound (empty ≠ clean air), truncation
 * disclosure, and sparse-payload handling (null distance/name/displayName).
 * @module tests/tools/find-locations.tool.test
 */

import { z } from '@cyanheads/mcp-ts-core';
import {
  JsonRpcErrorCode,
  rateLimited,
  serviceUnavailable,
  timeout,
} from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetServerConfig } from '@/config/server-config.js';
import { findLocations } from '@/mcp-server/tools/definitions/find-locations.tool.js';
import type { FindLocationsParams } from '@/services/openaq/openaq-service.js';
import { OpenAqService, setOpenAqService } from '@/services/openaq/openaq-service.js';
import type { OpenAqLocation } from '@/services/openaq/types.js';
import { seattleLocation, sparseLocation } from '../fixtures/openaq.js';
import { installStubService } from '../fixtures/stub-service.js';

const ctxWith = () => createMockContext({ errors: findLocations.errors });

/**
 * Every test starts with a fetch that rejects, so a path that reaches the network
 * without a test-installed mock fails loudly instead of calling the live,
 * rate-limited OpenAQ API.
 */
beforeEach(() => {
  vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('unmocked fetch in a unit test'));
});

afterEach(() => {
  setOpenAqService(undefined as never);
  vi.restoreAllMocks();
});

/** The error a handler call rejects with; fails the test if the call resolves. */
async function failureOf(call: () => unknown): Promise<{
  code: number;
  data: { reason: string; recovery: { hint: string } } & Record<string, unknown>;
}> {
  try {
    await call();
  } catch (err) {
    return err as Awaited<ReturnType<typeof failureOf>>;
  }
  throw new Error('expected the handler to reject');
}

/** Concatenated text of every content block — the domain render plus the enrichment trailer. */
const contentText = (result: { content: readonly { type: string; text?: string }[] }): string =>
  result.content.map((block) => (block.type === 'text' ? (block.text ?? '') : '')).join('\n');

describe('openaq_find_locations', () => {
  it('finds stations near a point with distance, units, and datetimeLast (the headline goal)', async () => {
    installStubService({
      findLocations: async () => ({ meta: { found: 1 }, results: [seattleLocation] }),
    });
    const ctx = ctxWith();
    const result = await findLocations.handler(
      findLocations.input.parse({ coordinates: '47.6062,-122.3321', radius: 12000, limit: 20 }),
      ctx,
    );

    expect(result.locations).toHaveLength(1);
    const loc = result.locations[0]!;
    expect(loc.id).toBe(931);
    expect(loc.distanceMeters).toBe(1364.84);
    // sensors[] reshaped into parameters[] with native units preserved verbatim.
    expect(loc.parameters).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 2, name: 'pm25', unit: 'µg/m³' }),
        expect.objectContaining({ id: 8, name: 'co', unit: 'ppm' }),
      ]),
    );
    expect(loc.datetimeLast).toEqual({
      utc: '2026-06-13T19:00:00Z',
      local: '2026-06-13T12:00:00-07:00',
    });
    expect(getEnrichment(ctx).totalCount).toBe(1);
  });

  it('rejects out-of-range coordinates/bbox at the schema edge (never reaches the API)', () => {
    // The live OpenAQ API returns a plain-text HTTP 500 for these and retries it;
    // bounding lat/lon in Zod fails them before any network call.
    expect(() => findLocations.input.parse({ coordinates: '999,999' })).toThrow(/out of range/i);
    expect(() => findLocations.input.parse({ bbox: '200,100,-200,-100' })).toThrow(/out of range/i);
    // Valid input still parses.
    expect(findLocations.input.parse({ coordinates: '47.6,-122.3' }).coordinates).toBe(
      '47.6,-122.3',
    );
  });

  it('throws no_search_scope when no coordinates/bbox/iso provided', async () => {
    installStubService({});
    await expect(
      findLocations.handler(findLocations.input.parse({}), ctxWith()),
    ).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'no_search_scope' },
    });
  });

  it('throws no_locations_found (empty ≠ clean air) and the recovery names the modeled fallback', async () => {
    installStubService({ findLocations: async () => ({ meta: { found: 0 }, results: [] }) });
    await expect(
      findLocations.handler(findLocations.input.parse({ iso: 'AQ' }), ctxWith()),
    ).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: {
        reason: 'no_locations_found',
        recovery: { hint: expect.stringMatching(/open-meteo|clean air/i) },
      },
    });
  });

  it('discloses truncation when the result count hits the limit', async () => {
    installStubService({
      findLocations: async () => ({
        meta: { found: '>2' },
        results: [seattleLocation, sparseLocation],
      }),
    });
    const ctx = ctxWith();
    await findLocations.handler(
      findLocations.input.parse({ coordinates: '47.6,-122.3', limit: 2 }),
      ctx,
    );
    const enrich = getEnrichment(ctx);
    expect(enrich.truncated).toBe(true);
    expect(enrich.shown).toBe(2);
    expect(enrich.cap).toBe(2);
    // #3, #27: a full page is a floor (the next page may hold more), flagged as inexact.
    expect(enrich.totalCount).toBe(2);
    expect(enrich.totalCountIsLowerBound).toBe(true);
  });

  it('reports a partial page as an exact total from its rows, whatever meta.found says (#3, #27)', async () => {
    // On /v3/locations meta.found counts only the page returned, so the total is
    // derived from the rows and the limit, never read from meta.found.
    installStubService({
      findLocations: async () => ({
        meta: { found: 5 },
        results: [seattleLocation, sparseLocation],
      }),
    });
    const ctx = ctxWith();
    await findLocations.handler(
      findLocations.input.parse({ coordinates: '47.6,-122.3', limit: 20 }),
      ctx,
    );
    const enrich = getEnrichment(ctx);
    expect(enrich.totalCount).toBe(2);
    expect(enrich.totalCountIsLowerBound).toBeUndefined();
    expect(enrich.truncated).toBeUndefined();
  });

  it('forwards page to the service and defaults it to 1 (#14)', async () => {
    const seen: FindLocationsParams[] = [];
    installStubService({
      findLocations: async (params) => {
        seen.push(params);
        return { meta: { found: 1 }, results: [seattleLocation] };
      },
    });
    await findLocations.handler(findLocations.input.parse({ iso: 'US' }), ctxWith());
    await findLocations.handler(findLocations.input.parse({ iso: 'US', page: 3 }), ctxWith());
    expect(seen.map((p) => p.page)).toEqual([1, 3]);
  });

  it('names the next page (not "raise limit") once limit is at the 100 cap (#14)', async () => {
    installStubService({
      findLocations: async () => ({
        meta: { found: '>100' },
        results: Array.from({ length: 100 }, (_, i) => ({ ...seattleLocation, id: 1000 + i })),
      }),
    });
    const ctx = ctxWith();
    await findLocations.handler(findLocations.input.parse({ iso: 'US', limit: 100 }), ctx);
    const guidance = getEnrichment(ctx).notice as string;
    expect(guidance).toContain('request page 2');
    expect(guidance).not.toContain('raise limit');
  });

  it('still says "raise limit" below the cap, where limit has somewhere to go (#14)', async () => {
    installStubService({
      findLocations: async () => ({
        meta: { found: '>2' },
        results: [seattleLocation, sparseLocation],
      }),
    });
    const ctx = ctxWith();
    await findLocations.handler(findLocations.input.parse({ iso: 'US', limit: 2 }), ctx);
    const guidance = getEnrichment(ctx).notice as string;
    expect(guidance).toContain('raise limit (max 100)');
    expect(guidance).not.toContain('request page');
  });

  it('handles a sparse bbox location (null distance/name/displayName) without inventing facts', async () => {
    installStubService({
      findLocations: async () => ({ meta: { found: 1 }, results: [sparseLocation] }),
    });
    const ctx = ctxWith();
    const result = await findLocations.handler(
      findLocations.input.parse({ bbox: '77.0,28.4,77.4,28.8' }),
      ctx,
    );
    const loc = result.locations[0]!;
    expect(loc.distanceMeters).toBeNull();
    expect(loc.datetimeLast).toBeNull();
    expect(loc.parameters[0]?.displayName).toBeNull();
    // No truncation when below the limit.
    expect(getEnrichment(ctx).truncated).toBeUndefined();
  });

  it('format renders name, locality, provider, mobile flag, data span, and parameter ids', () => {
    const blocks = findLocations.format!({
      locations: [
        {
          id: 931,
          name: 'Seattle-10th & Weller',
          locality: 'Seattle',
          country: { code: 'US', name: 'United States' },
          coordinates: { latitude: 47.6, longitude: -122.3 },
          distanceMeters: 1364.84,
          provider: 'AirNow',
          providerId: 119,
          isMonitor: true,
          isMobile: false,
          parameters: [{ id: 2, name: 'pm25', unit: 'µg/m³', displayName: 'PM2.5' }],
          datetimeLast: { utc: '2026-06-13T19:00:00Z', local: '2026-06-13T12:00:00-07:00' },
          datetimeFirst: { utc: '2016-03-15T20:00:00Z', local: '2016-03-15T13:00:00-07:00' },
        },
      ],
    });
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('AirNow');
    expect(text).toContain('Seattle');
    expect(text).toContain('pm25 #2');
    expect(text).toContain('µg/m³');
  });
});

describe('openaq_find_locations upstream error contract (#16)', () => {
  it('surfaces a 5xx as upstream_error with the declared recovery hint', async () => {
    installStubService({
      findLocations: async () => {
        throw serviceUnavailable('OpenAQ returned HTTP 500.', {
          path: '/locations?limit=20',
          status: 500,
        });
      },
    });
    await expect(
      findLocations.handler(findLocations.input.parse({ iso: 'US' }), ctxWith()),
    ).rejects.toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      data: {
        reason: 'upstream_error',
        status: 500,
        retryable: true,
        // An upstream failure must not read as "no coverage here".
        recovery: { hint: expect.stringContaining('coverage') },
      },
    });
  });

  it('surfaces a 429 as rate_limited', async () => {
    installStubService({
      findLocations: async () => {
        throw rateLimited('OpenAQ rate limit exceeded.', { status: 429, retryAfter: '30' });
      },
    });
    await expect(
      findLocations.handler(findLocations.input.parse({ iso: 'US' }), ctxWith()),
    ).rejects.toMatchObject({
      code: JsonRpcErrorCode.RateLimited,
      data: { reason: 'rate_limited', retryAfter: '30' },
    });
  });

  it('surfaces a timeout as upstream_timeout, not no_locations_found', async () => {
    installStubService({
      findLocations: async () => {
        throw timeout('OpenAQ did not respond within 15s.', { timeoutMs: 15_000 });
      },
    });
    await expect(
      findLocations.handler(findLocations.input.parse({ coordinates: '47.6,-122.3' }), ctxWith()),
    ).rejects.toMatchObject({
      code: JsonRpcErrorCode.Timeout,
      data: { reason: 'upstream_timeout' },
    });
  });
});

/**
 * The handler driven through the real OpenAqService down to `fetch`, so the
 * assertions read the query string OpenAQ actually receives — the handler's
 * parameter spreading and the service's defaults both sit inside the seam.
 */
describe('openaq_find_locations → OpenAQ query string', () => {
  let requested: URL[];

  /** Answer every request with one page of `results`; record each URL. */
  const serveLocations = (results: OpenAqLocation[], found: number | string = results.length) => {
    vi.mocked(globalThis.fetch).mockImplementation(async (url) => {
      requested.push(new URL(String(url)));
      return new Response(JSON.stringify({ meta: { found }, results }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
  };

  beforeEach(() => {
    requested = [];
    vi.stubEnv('OPENAQ_API_KEY', 'test-key');
    vi.stubEnv('OPENAQ_API_BASE_URL', 'https://api.openaq.org/v3');
    resetServerConfig();
    setOpenAqService(new OpenAqService({} as never, {} as never));
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    resetServerConfig();
  });

  const run = (input: Record<string, unknown>) =>
    findLocations.handler(findLocations.input.parse(input), ctxWith());

  it('sends a 12000 m radius when a coordinates search omits radius', async () => {
    serveLocations([seattleLocation]);
    await run({ coordinates: '47.6062,-122.3321' });
    expect(requested).toHaveLength(1);
    const qs = requested[0]!.searchParams;
    expect(requested[0]!.pathname).toBe('/v3/locations');
    expect(qs.get('coordinates')).toBe('47.6062,-122.3321');
    expect(qs.get('radius')).toBe('12000');
    expect(qs.get('limit')).toBe('20');
    expect(qs.get('page')).toBe('1');
    expect(qs.has('bbox')).toBe(false);
    expect(qs.has('iso')).toBe(false);
  });

  it('sends the caller radius with coordinates', async () => {
    serveLocations([seattleLocation]);
    await run({ coordinates: '47.6062,-122.3321', radius: 5000 });
    expect(requested[0]!.searchParams.get('radius')).toBe('5000');
  });

  it('combines iso with coordinates in one request', async () => {
    serveLocations([seattleLocation]);
    await run({ iso: 'US', coordinates: '47.6062,-122.3321' });
    const qs = requested[0]!.searchParams;
    expect(qs.get('iso')).toBe('US');
    expect(qs.get('coordinates')).toBe('47.6062,-122.3321');
    expect(qs.get('radius')).toBe('12000');
  });

  it('combines iso with bbox in one request, with no radius', async () => {
    serveLocations([sparseLocation]);
    await run({ iso: 'IN', bbox: '77.0,28.4,77.4,28.8' });
    const qs = requested[0]!.searchParams;
    expect(qs.get('iso')).toBe('IN');
    expect(qs.get('bbox')).toBe('77.0,28.4,77.4,28.8');
    expect(qs.has('radius')).toBe(false);
    expect(qs.has('coordinates')).toBe(false);
  });

  it('forwards parametersId as parameters_id and nothing else unasked', async () => {
    serveLocations([seattleLocation]);
    await run({ iso: 'US', parametersId: 2, limit: 5, page: 2 });
    expect([...requested[0]!.searchParams.keys()].sort()).toEqual(
      ['iso', 'limit', 'page', 'parameters_id'].sort(),
    );
    expect(requested[0]!.searchParams.get('parameters_id')).toBe('2');
  });

  it('sends a lowercase or padded iso as the uppercase code OpenAQ matches (#26)', async () => {
    serveLocations([seattleLocation]);
    await run({ iso: ' us ' });
    expect(requested[0]!.searchParams.get('iso')).toBe('US');
  });

  it('forwards the -99 placeholder unchanged (#39)', async () => {
    serveLocations([{ ...sparseLocation, country: { id: 7, code: '-99', name: 'Dhekelia' } }]);
    const result = await run({ iso: '-99' });
    expect(requested[0]!.searchParams.get('iso')).toBe('-99');
    expect(result.locations[0]?.country?.code).toBe('-99');
  });

  it.each([
    [true, 'true'],
    [false, 'false'],
  ])('forwards monitor %s as monitor=%s (#31)', async (monitor, sent) => {
    serveLocations([seattleLocation]);
    await run({ iso: 'GB', monitor });
    expect(requested[0]!.searchParams.get('monitor')).toBe(sent);
    expect(requested[0]!.searchParams.has('mobile')).toBe(false);
  });

  it.each([
    [true, 'true'],
    [false, 'false'],
  ])('forwards mobile %s as mobile=%s (#31)', async (mobile, sent) => {
    serveLocations([seattleLocation]);
    await run({ iso: 'GB', mobile });
    expect(requested[0]!.searchParams.get('mobile')).toBe(sent);
    expect(requested[0]!.searchParams.has('monitor')).toBe(false);
  });

  it('sends none of the station filters when they are omitted (#31)', async () => {
    serveLocations([seattleLocation]);
    await run({ iso: 'GB' });
    const qs = requested[0]!.searchParams;
    expect(qs.has('monitor')).toBe(false);
    expect(qs.has('mobile')).toBe(false);
    expect(qs.has('providers_id')).toBe(false);
  });

  it.each([
    ['coordinates', { coordinates: '47.6062,-122.3321' }],
    ['bbox', { bbox: '-122.5,47.4,-122.1,47.8' }],
    ['iso', { iso: 'GB' }],
  ])(
    'combines every station filter with %s and parametersId in one request (#31)',
    async (_label, scope) => {
      serveLocations([seattleLocation]);
      await run({ ...scope, parametersId: 2, monitor: false, mobile: false, providersId: 70 });
      expect(requested).toHaveLength(1);
      const qs = requested[0]!.searchParams;
      expect(qs.get('monitor')).toBe('false');
      expect(qs.get('mobile')).toBe('false');
      expect(qs.get('providers_id')).toBe('70');
      expect(qs.get('parameters_id')).toBe('2');
      for (const [key, value] of Object.entries(scope)) expect(qs.get(key)).toBe(value);
    },
  );
});

describe('openaq_find_locations search scope (#26)', () => {
  /** A service stub whose findLocations records calls; the scope guards must never reach it. */
  const guardedService = () => {
    const findLocationsSpy = vi.fn(async () => ({
      meta: { found: 1 },
      results: [seattleLocation],
    }));
    installStubService({ findLocations: findLocationsSpy });
    return findLocationsSpy;
  };

  it.each([
    [
      'coordinates with bbox',
      { coordinates: '47.6062,-122.3321', bbox: '-122.5,47.4,-122.1,47.8' },
    ],
    ['iso with radius and no coordinates', { iso: 'US', radius: 1 }],
    ['bbox with radius and no coordinates', { bbox: '-122.5,47.4,-122.1,47.8', radius: 1 }],
  ])('rejects %s as invalid_search_scope before any request', async (_label, input) => {
    const findLocationsSpy = guardedService();
    await expect(
      findLocations.handler(findLocations.input.parse(input), ctxWith()),
    ).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: {
        reason: 'invalid_search_scope',
        recovery: { hint: expect.stringContaining('radius applies only with coordinates') },
      },
    });
    expect(findLocationsSpy).not.toHaveBeenCalled();
  });

  it('names the offending combination in the message', async () => {
    guardedService();
    await expect(
      findLocations.handler(
        findLocations.input.parse({ coordinates: '47.6,-122.3', bbox: '-122.5,47.4,-122.1,47.8' }),
        ctxWith(),
      ),
    ).rejects.toThrow(/coordinates and bbox/);
    await expect(
      findLocations.handler(findLocations.input.parse({ iso: 'US', radius: 5 }), ctxWith()),
    ).rejects.toThrow(/radius.*without coordinates/);
  });

  it('keeps no_search_scope for a call with no area at all, radius alone included', async () => {
    const findLocationsSpy = guardedService();
    for (const input of [{}, { radius: 5000 }, { parametersId: 2 }]) {
      await expect(
        findLocations.handler(findLocations.input.parse(input), ctxWith()),
      ).rejects.toMatchObject({ data: { reason: 'no_search_scope' } });
    }
    expect(findLocationsSpy).not.toHaveBeenCalled();
  });

  it('leaves radius unset when the caller omits it (the service owns the 12000 default)', async () => {
    const findLocationsSpy = guardedService();
    await findLocations.handler(
      findLocations.input.parse({ coordinates: '47.6062,-122.3321' }),
      ctxWith(),
    );
    expect(findLocationsSpy).toHaveBeenCalledTimes(1);
    expect(findLocationsSpy.mock.calls[0]).toBeDefined();
    const params = (findLocationsSpy.mock.calls[0] as unknown as [FindLocationsParams])[0];
    expect(params.radius).toBeUndefined();
    expect(findLocations.input.parse({ iso: 'US' }).radius).toBeUndefined();
  });

  it('normalizes iso case and surrounding whitespace to the uppercase code OpenAQ matches', () => {
    expect(findLocations.input.parse({ iso: 'us' }).iso).toBe('US');
    expect(findLocations.input.parse({ iso: ' us ' }).iso).toBe('US');
    expect(findLocations.input.parse({ iso: 'De' }).iso).toBe('DE');
  });

  it.each(['1!', 'USA', 'U', ''])('rejects iso %j at the schema', (iso) => {
    expect(findLocations.input.safeParse({ iso }).success).toBe(false);
  });

  it('carries invalid_search_scope and its recovery through the assembled result', async () => {
    const findLocationsSpy = guardedService();
    const result = await runToolContract(findLocations, {
      coordinates: '47.6062,-122.3321',
      bbox: '-122.5,47.4,-122.1,47.8',
    });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: { code: JsonRpcErrorCode.ValidationError, data: { reason: 'invalid_search_scope' } },
    });
    const text = contentText(result);
    expect(text).toContain('Recovery:');
    expect(text).toContain('radius applies only with coordinates');
    expect(text).toContain('invalid_search_scope');
    expect(findLocationsSpy).not.toHaveBeenCalled();
  });

  it('rejects an inverted bbox at the schema before the handler runs', async () => {
    const findLocationsSpy = guardedService();
    const result = await runToolContract(findLocations, { bbox: '-122.1,47.8,-122.5,47.4' });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: { code: JsonRpcErrorCode.InvalidParams },
    });
    expect(contentText(result)).toMatch(/minLon.*maxLon/);
    expect(findLocationsSpy).not.toHaveBeenCalled();
  });
});

describe('openaq_find_locations advertised input schema (#26, #31, #39)', () => {
  const emitted = z.toJSONSchema(findLocations.input, { io: 'input' }) as {
    properties: Record<string, Record<string, unknown>>;
  };

  it('advertises radius with no default', () => {
    expect(emitted.properties.radius).toBeDefined();
    expect(emitted.properties.radius).not.toHaveProperty('default');
    expect(emitted.properties.radius?.description).toMatch(/Default 12000/);
    expect(emitted.properties.radius?.description).toMatch(/coordinates/);
  });

  it('advertises iso with a pattern admitting either letter case and the -99 placeholder', () => {
    const pattern = new RegExp(emitted.properties.iso?.pattern as string);
    for (const ok of ['US', 'us', 'De', '-99']) expect(pattern.test(ok)).toBe(true);
    for (const bad of ['USA', '1!', '-9', '99', '-999']) expect(pattern.test(bad)).toBe(false);
    expect(emitted.properties.iso?.type).toBe('string');
    expect(emitted.properties.iso?.description).toContain('-99');
  });

  it('keeps coordinates and bbox type + pattern', () => {
    expect(emitted.properties.coordinates).toMatchObject({
      type: 'string',
      pattern: expect.any(String),
    });
    expect(emitted.properties.bbox).toMatchObject({ type: 'string', pattern: expect.any(String) });
  });

  it('advertises the three station filters', () => {
    expect(emitted.properties.monitor).toMatchObject({ type: 'boolean' });
    expect(emitted.properties.mobile).toMatchObject({ type: 'boolean' });
    expect(emitted.properties.providersId).toMatchObject({ type: 'integer', exclusiveMinimum: 0 });
  });
});

describe("openaq_find_locations iso accepts OpenAQ's -99 placeholder (#39)", () => {
  it('parses "-99" unchanged', () => {
    expect(findLocations.input.parse({ iso: '-99' }).iso).toBe('-99');
    expect(findLocations.input.parse({ iso: ' -99 ' }).iso).toBe('-99');
  });

  it.each(['-9', '99', '-999', '--9'])('rejects %j at the schema', (iso) => {
    expect(findLocations.input.safeParse({ iso }).success).toBe(false);
  });
});

/**
 * A fake `/v3/locations` over a fixed station set that reproduces OpenAQ's
 * per-page `meta.found`: `">limit"` on a full page (even when nothing follows),
 * the page's own row count on a partial one, `0` past the end — measured live.
 */
function pagedUpstream(stationCount: number) {
  const stations = Array.from({ length: stationCount }, (_, i) => ({
    ...sparseLocation,
    id: 5000 + i,
  }));
  return async (params: FindLocationsParams) => {
    const page = params.page ?? 1;
    const results = stations.slice((page - 1) * params.limit, page * params.limit);
    const found = results.length === params.limit ? `>${params.limit}` : results.length;
    return { meta: { found }, results };
  };
}

describe('openaq_find_locations paging state from rows, not meta.found (#27)', () => {
  const runPage = async (input: Record<string, unknown>) => {
    const ctx = ctxWith();
    const result = await findLocations.handler(findLocations.input.parse(input), ctx);
    return { result, enrich: getEnrichment(ctx) };
  };

  it('fails an empty page past the first with page_exhausted, never a coverage verdict', async () => {
    installStubService({ findLocations: async () => ({ meta: { found: 0 }, results: [] }) });
    const err = await failureOf(() =>
      findLocations.handler(
        findLocations.input.parse({ iso: 'US', limit: 100, page: 2 }),
        ctxWith(),
      ),
    );
    expect(err).toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'page_exhausted', page: 2, limit: 100 },
    });
    const hint = err.data.recovery.hint;
    expect(hint).toMatch(/earlier page/);
    expect(hint).toMatch(/page 1/);
    expect(hint).not.toMatch(/radius|coverage|clean air/i);
  });

  it('keeps no_locations_found for an empty first page', async () => {
    installStubService({ findLocations: async () => ({ meta: { found: 0 }, results: [] }) });
    await expect(
      findLocations.handler(findLocations.input.parse({ iso: 'US', page: 1 }), ctxWith()),
    ).rejects.toMatchObject({ data: { reason: 'no_locations_found' } });
  });

  it('counts a partial last page exactly from the rows before it', async () => {
    installStubService({
      findLocations: async () => ({ meta: { found: 1 }, results: [sparseLocation] }),
    });
    const { enrich } = await runPage({ bbox: '-122.40,47.55,-122.25,47.65', limit: 10, page: 3 });
    expect(enrich.totalCount).toBe(21);
    expect(enrich.totalCountIsLowerBound).toBeUndefined();
    expect(enrich.truncated).toBeUndefined();
    expect(enrich.notice).toBeUndefined();
  });

  it('reports a full later page as a floor and points at the next page without claiming more exist', async () => {
    installStubService({
      findLocations: async () => ({
        meta: { found: '>10' },
        results: Array.from({ length: 10 }, (_, i) => ({ ...sparseLocation, id: 100 + i })),
      }),
    });
    const { enrich } = await runPage({ bbox: '-122.40,47.55,-122.25,47.65', limit: 10, page: 2 });
    expect(enrich.totalCount).toBe(20);
    expect(enrich.totalCountIsLowerBound).toBe(true);
    expect(enrich.truncated).toBe(true);
    const guidance = enrich.notice as string;
    expect(guidance).toContain('page 3');
    expect(guidance).not.toContain('more than');
  });

  it('reads a full first page as "at least N", not "more than N" (#3 rewritten)', async () => {
    installStubService({
      findLocations: async () => ({
        meta: { found: '>2' },
        results: [seattleLocation, sparseLocation],
      }),
    });
    const { enrich } = await runPage({ iso: 'AQ', limit: 2 });
    expect(enrich.totalCount).toBe(2);
    expect(enrich.totalCountIsLowerBound).toBe(true);
    expect(enrich.notice).not.toContain('more than');
    expect(enrich.notice).toContain('at least 2 stations match');
  });

  it('keeps the floor wording grammatical for a single station', async () => {
    installStubService({
      findLocations: async () => ({ meta: { found: '>1' }, results: [seattleLocation] }),
    });
    const { enrich } = await runPage({ bbox: '-122.34,47.59,-122.31,47.61', limit: 1 });
    expect(enrich).toMatchObject({ totalCount: 1, totalCountIsLowerBound: true });
    expect(enrich.notice).toContain('at least 1 station matches');
  });

  it('walks a 21-station result set page by page to an exact total, then page_exhausted', async () => {
    installStubService({ findLocations: pagedUpstream(21) });
    const scope = { bbox: '-122.40,47.55,-122.25,47.65', limit: 10 };

    const first = await runPage({ ...scope, page: 1 });
    expect(first.result.locations.map((l) => l.id)).toEqual(
      Array.from({ length: 10 }, (_, i) => 5000 + i),
    );
    expect(first.enrich).toMatchObject({
      totalCount: 10,
      totalCountIsLowerBound: true,
      truncated: true,
    });

    const second = await runPage({ ...scope, page: 2 });
    expect(second.result.locations[0]?.id).toBe(5010);
    expect(second.enrich).toMatchObject({
      totalCount: 20,
      totalCountIsLowerBound: true,
      truncated: true,
    });
    expect(second.enrich.notice).toContain('page 3');

    const last = await runPage({ ...scope, page: 3 });
    expect(last.result.locations.map((l) => l.id)).toEqual([5020]);
    expect(last.enrich.totalCount).toBe(21);
    expect(last.enrich.totalCountIsLowerBound).toBeUndefined();
    expect(last.enrich.truncated).toBeUndefined();

    await expect(
      findLocations.handler(findLocations.input.parse({ ...scope, page: 4 }), ctxWith()),
    ).rejects.toMatchObject({ data: { reason: 'page_exhausted', page: 4, limit: 10 } });
  });

  it('treats an exactly-full last page as a floor, then page_exhausted on the next (AQ, 2 stations)', async () => {
    installStubService({ findLocations: pagedUpstream(2) });
    const full = await runPage({ iso: 'AQ', limit: 2 });
    expect(full.enrich).toMatchObject({
      totalCount: 2,
      totalCountIsLowerBound: true,
      truncated: true,
    });
    await expect(
      findLocations.handler(findLocations.input.parse({ iso: 'AQ', limit: 2, page: 2 }), ctxWith()),
    ).rejects.toMatchObject({ data: { reason: 'page_exhausted' } });
  });

  it('names the next page, not a higher limit, on a full page past the first below the cap', async () => {
    installStubService({ findLocations: pagedUpstream(21) });
    const { enrich } = await runPage({ iso: 'US', limit: 10, page: 2 });
    expect(enrich.notice).toContain('request page 3');
    expect(enrich.notice).not.toContain('raise limit');
  });

  /**
   * The full-page guidance is followed literally, so each narrowing move it names
   * must be one the same search accepts: radius needs coordinates, and bbox cannot
   * join coordinates — either would come back as invalid_search_scope (#26).
   */
  it.each([
    ['coordinates', { coordinates: '47.6062,-122.3321' }, 'a smaller radius', /bbox/],
    ['bbox', { bbox: '-122.40,47.55,-122.25,47.65' }, 'a tighter bbox', /radius/],
    ['iso', { iso: 'US' }, 'a bbox or coordinates inside the country', /radius/],
  ])(
    'names only area moves a %s search accepts in the full-page guidance',
    async (_label, scope, move, rejected) => {
      installStubService({ findLocations: pagedUpstream(21) });
      const { enrich } = await runPage({ ...scope, limit: 10 });
      const guidance = enrich.notice as string;
      expect(guidance).toContain(move);
      expect(guidance).not.toMatch(rejected);
      expect(guidance).toContain('parametersId, monitor, mobile, providersId');
    },
  );

  it('carries page_exhausted and its recovery through the assembled result', async () => {
    installStubService({ findLocations: async () => ({ meta: { found: 0 }, results: [] }) });
    const result = await runToolContract(findLocations, { iso: 'US', limit: 100, page: 999 });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: {
        code: JsonRpcErrorCode.NotFound,
        data: { reason: 'page_exhausted', page: 999, limit: 100 },
      },
    });
    const text = contentText(result);
    expect(text).toContain('page_exhausted');
    expect(text).toContain('Recovery:');
    expect(text).not.toMatch(/clean air/);
  });

  it('discloses a full page as a floor on both surfaces of the assembled result', async () => {
    installStubService({ findLocations: pagedUpstream(21) });
    const result = await runToolContract(findLocations, {
      bbox: '-122.40,47.55,-122.25,47.65',
      limit: 10,
      page: 2,
    });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      totalCount: 20,
      totalCountIsLowerBound: true,
      truncated: true,
      shown: 10,
      cap: 10,
    });
    const text = contentText(result);
    expect(text).toContain('20 total');
    expect(text).toContain('page 3');
    expect(text).not.toContain('more than');
  });
});

describe('openaq_find_locations station filters (#31)', () => {
  it('accepts a positive providersId and rejects a non-positive one at the schema', () => {
    expect(findLocations.input.parse({ iso: 'GB', providersId: 70 }).providersId).toBe(70);
    expect(findLocations.input.safeParse({ iso: 'GB', providersId: 0 }).success).toBe(false);
    expect(findLocations.input.safeParse({ iso: 'GB', providersId: -1 }).success).toBe(false);
    expect(findLocations.input.safeParse({ iso: 'GB', providersId: 1.5 }).success).toBe(false);
  });

  it('does not treat the filters as a search scope', async () => {
    const findLocationsSpy = vi.fn();
    installStubService({ findLocations: findLocationsSpy });
    await expect(
      findLocations.handler(
        findLocations.input.parse({ monitor: true, mobile: false, providersId: 70 }),
        ctxWith(),
      ),
    ).rejects.toMatchObject({ data: { reason: 'no_search_scope' } });
    expect(findLocationsSpy).not.toHaveBeenCalled();
  });

  it('names the station filters in the no_locations_found recovery', async () => {
    installStubService({ findLocations: async () => ({ meta: { found: 0 }, results: [] }) });
    const err = await failureOf(() =>
      findLocations.handler(findLocations.input.parse({ iso: 'GB', monitor: true }), ctxWith()),
    );
    expect(err.data.reason).toBe('no_locations_found');
    for (const filter of ['parametersId', 'monitor', 'mobile', 'providersId']) {
      expect(err.data.recovery.hint).toContain(filter);
    }
  });

  it('ties the radius advice in the no_locations_found recovery to a coordinates search', async () => {
    // A radius sent with only iso or bbox fails as invalid_search_scope (#26), so the
    // recovery must not offer it as a move for every scope.
    installStubService({ findLocations: async () => ({ meta: { found: 0 }, results: [] }) });
    const err = await failureOf(() =>
      findLocations.handler(findLocations.input.parse({ iso: 'AQ' }), ctxWith()),
    );
    expect(err.data.recovery.hint).toMatch(/radius up to 25000m around coordinates/);
    expect(err.data.recovery.hint).toMatch(/larger bbox/);
  });

  it('carries each location provider and id, both null when OpenAQ lists no provider (#40)', async () => {
    installStubService({
      findLocations: async () => ({
        meta: { found: 2 },
        results: [seattleLocation, { ...sparseLocation, provider: null }],
      }),
    });
    const result = await findLocations.handler(
      findLocations.input.parse({ bbox: '-122.5,47.4,-122.1,47.8' }),
      ctxWith(),
    );
    expect(result.locations.map((l) => [l.provider, l.providerId])).toEqual([
      ['AirNow', 119],
      [null, null],
    ]);
  });

  it('renders the provider id beside the provider name on both surfaces', async () => {
    installStubService({
      findLocations: async () => ({
        meta: { found: 2 },
        results: [seattleLocation, { ...sparseLocation, provider: null }],
      }),
    });
    const result = await runToolContract(findLocations, { bbox: '-122.5,47.4,-122.1,47.8' });
    expect(result.structuredContent).toMatchObject({
      locations: [{ providerId: 119 }, { providerId: null }],
    });
    const text = contentText(result);
    expect(text).toContain('provider: AirNow (providersId 119)');
    expect(text).toContain('provider: not listed by OpenAQ');
    expect(text).not.toContain('Unknown');
  });
});

describe('openaq_find_locations missing upstream values stay missing (#40)', () => {
  /** Serve one populated station beside `sparse`, and return the assembled result. */
  const runWith = async (sparse: OpenAqLocation) => {
    installStubService({
      findLocations: async () => ({ meta: { found: 2 }, results: [seattleLocation, sparse] }),
    });
    return runToolContract(findLocations, { bbox: '-122.5,47.4,-122.1,47.8' });
  };

  /** The rendered block for station `id` — one `## ` section of the text. */
  const blockFor = (text: string, id: number): string =>
    text.split('\n\n').find((block) => block.includes(`— id ${id}`)) ?? '';

  it.each([
    ['only latitude null', { latitude: null, longitude: -122.3 }],
    ['only longitude null', { latitude: 47.6, longitude: null }],
    ['coordinates null', null],
  ])('yields coordinates: null with %s, never 0', async (_label, coordinates) => {
    const result = await runWith({ ...sparseLocation, coordinates });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      locations: [
        { coordinates: { latitude: 47.5972, longitude: -122.3197 } },
        { coordinates: null },
      ],
    });
    const block = blockFor(contentText(result), 42);
    expect(block).toContain('coords: not listed by OpenAQ');
    expect(block).not.toMatch(/coords: [^\n]*\b0\b/);
    expect(block).not.toContain('Unknown');
    // The populated station beside it renders as before.
    expect(blockFor(contentText(result), 931)).toContain('coords: 47.5972, -122.3197');
  });

  it('yields country: null, rendered without an XX code or an Unknown name', async () => {
    const result = await runWith({ ...sparseLocation, country: null });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      locations: [{ country: { code: 'US', name: 'United States' } }, { country: null }],
    });
    const block = blockFor(contentText(result), 42);
    expect(block).toContain('country not listed by OpenAQ · locality: n/a');
    expect(block).not.toContain('XX');
    expect(block).not.toContain('Unknown');
  });

  it('keeps every other field when coordinates, country, and provider are all missing', async () => {
    const result = await runWith({
      ...sparseLocation,
      coordinates: null,
      country: null,
      provider: null,
    });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      locations: [
        { id: 931 },
        {
          id: 42,
          coordinates: null,
          country: null,
          provider: null,
          providerId: null,
          parameters: [{ id: 2, name: 'pm25', unit: 'µg/m³' }],
        },
      ],
    });
    const block = blockFor(contentText(result), 42);
    expect(block).toBe(`## location 42 — id 42
country not listed by OpenAQ · locality: n/a · no distance · low-cost sensor · fixed · provider: not listed by OpenAQ
coords: not listed by OpenAQ
data span: unknown → never reported
parameters: pm25 #2 (µg/m³, no display name)`);
  });
});

describe('openaq_find_locations assembled result (runToolContract)', () => {
  it('carries no_locations_found with its recovery on both surfaces', async () => {
    installStubService({ findLocations: async () => ({ meta: { found: 0 }, results: [] }) });
    const result = await runToolContract(findLocations, { iso: 'AQ' });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: {
        code: JsonRpcErrorCode.NotFound,
        data: {
          reason: 'no_locations_found',
          recovery: { hint: expect.stringMatching(/clean air/) },
        },
      },
    });
    const text = contentText(result);
    expect(text).toContain('Recovery:');
    expect(text).toContain('no_locations_found');
    expect(text).toMatch(/clean air/);
  });

  it('renders the station line with provider, class, and mobility', async () => {
    installStubService({
      findLocations: async () => ({ meta: { found: 1 }, results: [seattleLocation] }),
    });
    const result = await runToolContract(findLocations, { coordinates: '47.6062,-122.3321' });
    expect(result.isError).toBeFalsy();
    const text = contentText(result);
    expect(text).toContain('## Seattle-10th & Weller — id 931');
    expect(text).toContain(
      'United States (US) · locality: Seattle-Tacoma-Bellevue · 1365m away · reference monitor · fixed · provider: AirNow',
    );
  });
});

describe('openaq_find_locations populated rendering (characterization)', () => {
  it('renders a fully populated station exactly', async () => {
    installStubService({
      findLocations: async () => ({ meta: { found: 1 }, results: [seattleLocation] }),
    });
    const result = await runToolContract(findLocations, { coordinates: '47.6062,-122.3321' });
    expect(result.structuredContent).toMatchObject({
      locations: [
        {
          country: { code: 'US', name: 'United States' },
          coordinates: { latitude: 47.5972, longitude: -122.3197 },
          provider: 'AirNow',
          providerId: 119,
        },
      ],
    });
    expect(
      (findLocations.format!(result.structuredContent as never)[0] as { text: string }).text,
    ).toBe(`## Seattle-10th & Weller — id 931
United States (US) · locality: Seattle-Tacoma-Bellevue · 1365m away · reference monitor · fixed · provider: AirNow (providersId 119)
coords: 47.5972, -122.3197
data span: 2016-03-15T20:00:00Z (local 2016-03-15T13:00:00-07:00) → 2026-06-13T19:00:00Z (local 2026-06-13T12:00:00-07:00)
parameters: pm25 #2 (µg/m³, PM2.5), co #8 (ppm, CO)`);
  });

  it('renders a sparse station with populated country, coordinates, and provider exactly', async () => {
    installStubService({
      findLocations: async () => ({ meta: { found: 1 }, results: [sparseLocation] }),
    });
    const result = await runToolContract(findLocations, { bbox: '77.0,28.4,77.4,28.8' });
    expect(
      (findLocations.format!(result.structuredContent as never)[0] as { text: string }).text,
    ).toBe(`## location 42 — id 42
India (IN) · locality: n/a · no distance · low-cost sensor · fixed · provider: OpenAQ LCS (providersId 99)
coords: 28.6, 77.2
data span: unknown → never reported
parameters: pm25 #2 (µg/m³, no display name)`);
  });
});

describe('openaq_find_locations parametersId must be positive (#33)', () => {
  const emitted = () =>
    z.toJSONSchema(findLocations.input, { io: 'input' }) as {
      properties: Record<string, Record<string, unknown>>;
    };

  it('advertises parametersId as an integer', () => {
    expect(emitted().properties.parametersId).toMatchObject({
      type: 'integer',
      description: expect.stringContaining('openaq_list_parameters'),
    });
  });

  it('advertises parametersId with exclusiveMinimum 0, like providersId', () => {
    expect(emitted().properties.parametersId).toMatchObject({ exclusiveMinimum: 0 });
    expect(emitted().properties.parametersId).not.toHaveProperty('minimum');
  });

  it.each([0, -1])(
    'rejects parametersId %i as invalid_arguments, never no_locations_found',
    async (parametersId) => {
      const findLocationsSpy = vi.fn(async () => ({ meta: { found: 0 }, results: [] }));
      installStubService({ findLocations: findLocationsSpy });
      const result = await runToolContract(findLocations, { iso: 'US', parametersId });
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        error: {
          code: JsonRpcErrorCode.InvalidParams,
          data: { reason: 'invalid_arguments', issues: [{ path: ['parametersId'] }] },
        },
      });
      const text = contentText(result);
      expect(text).toContain('parametersId');
      expect(text).not.toContain('no_locations_found');
      expect(findLocationsSpy).not.toHaveBeenCalled();
      expect(globalThis.fetch).not.toHaveBeenCalled();
    },
  );

  it('still accepts parametersId 1, the lowest id in the catalog', () => {
    expect(findLocations.input.parse({ iso: 'US', parametersId: 1 }).parametersId).toBe(1);
  });
});
