/**
 * @fileoverview openaq_find_locations tests — near-me discovery (the headline
 * goal), scope validation, empty-result NotFound (empty ≠ clean air), truncation
 * disclosure, and sparse-payload handling (null distance/name/displayName).
 * @module tests/tools/find-locations.tool.test
 */

import {
  JsonRpcErrorCode,
  rateLimited,
  serviceUnavailable,
  timeout,
} from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { findLocations } from '@/mcp-server/tools/definitions/find-locations.tool.js';
import type { FindLocationsParams } from '@/services/openaq/openaq-service.js';
import { setOpenAqService } from '@/services/openaq/openaq-service.js';
import { seattleLocation, sparseLocation } from '../fixtures/openaq.js';
import { installStubService } from '../fixtures/stub-service.js';

const ctxWith = () => createMockContext({ errors: findLocations.errors });

afterEach(() => setOpenAqService(undefined as never));

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
    const err = await findLocations
      .handler(findLocations.input.parse({ iso: 'AQ' }), ctxWith())
      .catch((e) => e);
    expect(err.code).toBe(JsonRpcErrorCode.NotFound);
    expect(err.data.reason).toBe('no_locations_found');
    expect(err.data.recovery.hint).toMatch(/open-meteo|clean air/i);
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
    // #3: ">2" is a lower bound — totalCount is the floor, flagged as inexact.
    expect(enrich.totalCount).toBe(2);
    expect(enrich.totalCountIsLowerBound).toBe(true);
  });

  it('reports an exact numeric total without the lower-bound flag (#3)', async () => {
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
    expect(enrich.totalCount).toBe(5);
    expect(enrich.totalCountIsLowerBound).toBeUndefined();
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
