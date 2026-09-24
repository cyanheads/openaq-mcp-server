/**
 * @fileoverview openaq_get_readings tests — the latest×sensors JOIN (the headline
 * goal: every value carries its pollutant + unit), the coordinates resolution
 * path, scope validation, location_not_found, no_recent_values, the parametersId
 * filter, and the error-contract corrections: each guard owns its reason, a
 * parameter the station lacks reports as parameter_not_at_location, and upstream
 * transport failures arrive as upstream_error / rate_limited / upstream_timeout /
 * invalid_api_key.
 * @module tests/tools/get-readings.tool.test
 */

import { z } from '@cyanheads/mcp-ts-core';
import {
  JsonRpcErrorCode,
  type McpError,
  notFound,
  rateLimited,
  serviceUnavailable,
  timeout,
  unauthorized,
} from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetServerConfig } from '@/config/server-config.js';
import { getReadings } from '@/mcp-server/tools/definitions/get-readings.tool.js';
import { OpenAqService, setOpenAqService } from '@/services/openaq/openaq-service.js';
import type { OpenAqLocation } from '@/services/openaq/types.js';
import { seattleLatest, seattleLocation } from '../fixtures/openaq.js';
import { installStubService } from '../fixtures/stub-service.js';

const ctxWith = () => createMockContext({ errors: getReadings.errors });

/**
 * Await a handler call and return the McpError it rejects with. A definition's
 * handler is typed `T | Promise<T>`, so the promise methods are not directly
 * reachable on the call expression.
 */
async function rejection(run: unknown): Promise<McpError> {
  try {
    await run;
  } catch (error) {
    return error as McpError;
  }
  throw new Error('Expected the handler to reject.');
}

/** Concatenated text of every content block — the domain render plus the enrichment trailer. */
const contentText = (result: { content: readonly { type: string; text?: string }[] }): string =>
  result.content.map((block) => (block.type === 'text' ? (block.text ?? '') : '')).join('\n');

/** Every OpenAQ call goes through a stub or a test-installed fetch; anything else fails loudly. */
beforeEach(() => {
  vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('unmocked fetch in a unit test'));
});

afterEach(() => {
  setOpenAqService(undefined as never);
  vi.restoreAllMocks();
});

describe('openaq_get_readings', () => {
  it('joins latest values to pollutant + unit via the sensor map (the headline goal)', async () => {
    installStubService({
      getLocation: async () => seattleLocation,
      getLatest: async () => seattleLatest,
    });
    const ctx = ctxWith();
    const result = await getReadings.handler(getReadings.input.parse({ locationId: 931 }), ctx);

    expect(result.location.id).toBe(931);
    expect(result.location.timezone).toBe('America/Los_Angeles');
    // The join: sensorsId 1701 → pm25/µg/m³, 1708 → co/ppm. No bare numbers.
    const pm25 = result.readings.find((r) => r.parameter.name === 'pm25')!;
    expect(pm25).toMatchObject({ value: 3.4, unit: 'µg/m³', sensorId: 1701 });
    const co = result.readings.find((r) => r.parameter.name === 'co')!;
    expect(co).toMatchObject({ value: 0.2, unit: 'ppm', sensorId: 1708 });
    expect(pm25.datetimeUtc).toBe('2026-06-13T19:00:00Z');
  });

  it('resolves the nearest station from coordinates+parametersId, then reads it', async () => {
    let findArgs: unknown;
    installStubService({
      findLocations: async (params) => {
        findArgs = params;
        return { meta: { found: 1 }, results: [seattleLocation] };
      },
      getLocation: async () => seattleLocation,
      getLatest: async () => seattleLatest,
    });
    const ctx = ctxWith();
    const result = await getReadings.handler(
      getReadings.input.parse({ coordinates: '47.6,-122.3', parametersId: 2 }),
      ctx,
    );
    // Nearest resolution pulls OpenAQ's full 1,000-row page so the distance sort can
    // surface the true nearest; radius 25000 + the parameter filter still apply.
    expect(findArgs).toMatchObject({ radius: 25000, parametersId: 2, limit: 1000 });
    expect(result.location.distanceMeters).toBe(1364.84);
    expect(result.readings.length).toBeGreaterThan(0);
  });

  it('picks results[0] (the service-sorted nearest) from a candidate pool (#2)', async () => {
    installStubService({
      // The service returns coordinate results distance-sorted; get_readings must
      // trust results[0] as nearest rather than a farther candidate in the pool.
      findLocations: async () => ({
        meta: { found: 2 },
        results: [
          { ...seattleLocation, id: 931, distance: 1364.84 },
          { ...seattleLocation, id: 917, name: 'Bremerton-Spruce Ave', distance: 22257.53 },
        ],
      }),
      getLocation: async () => seattleLocation,
      getLatest: async () => seattleLatest,
    });
    const result = await getReadings.handler(
      getReadings.input.parse({ coordinates: '47.6,-122.3', parametersId: 2 }),
      ctxWith(),
    );
    // 1364.84 (the near Seattle station), not 22257.53 (far Bremerton).
    expect(result.location.distanceMeters).toBe(1364.84);
  });

  it('throws missing_coordinates_parameter when coordinates lacks parametersId', async () => {
    installStubService({});
    await expect(
      getReadings.handler(getReadings.input.parse({ coordinates: '47.6,-122.3' }), ctxWith()),
    ).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'missing_coordinates_parameter' },
    });
  });

  it('throws invalid_location_scope when both locationId and coordinates are set (#13)', async () => {
    installStubService({});
    await expect(
      getReadings.handler(
        getReadings.input.parse({ locationId: 931, coordinates: '47.6,-122.3', parametersId: 2 }),
        ctxWith(),
      ),
    ).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      message: expect.stringContaining('not both'),
      data: {
        reason: 'invalid_location_scope',
        recovery: { hint: expect.stringContaining('exactly one') },
      },
    });
  });

  it('throws invalid_location_scope when neither locationId nor coordinates is set (#13)', async () => {
    installStubService({});
    await expect(getReadings.handler(getReadings.input.parse({}), ctxWith())).rejects.toMatchObject(
      {
        code: JsonRpcErrorCode.ValidationError,
        message: expect.stringContaining('neither'),
        data: {
          reason: 'invalid_location_scope',
          recovery: { hint: expect.stringContaining('exactly one') },
        },
      },
    );
  });

  it('reserves missing_coordinates_parameter for coordinates without parametersId (#13)', async () => {
    installStubService({});
    const err = await rejection(
      getReadings.handler(getReadings.input.parse({ coordinates: '47.6,-122.3' }), ctxWith()),
    );
    // The two guards must not share a reason — this one keeps the parametersId hint.
    expect(err.data).toMatchObject({ reason: 'missing_coordinates_parameter' });
    expect((err.data as { recovery: { hint: string } }).recovery.hint).toContain('parametersId');
  });

  it('throws parameter_not_at_location, not no_recent_values, for a parameter the station lacks (#13)', async () => {
    installStubService({
      getLocation: async () => seattleLocation,
      getLatest: async () => seattleLatest,
    });
    // Station 931 is live (sensors 1701/pm25 id 2, 1708/co id 8) but has no sensor
    // for parameter 11 — a wrong-parameter error, not a dormant station.
    await expect(
      getReadings.handler(
        getReadings.input.parse({ locationId: 931, parametersId: 11 }),
        ctxWith(),
      ),
    ).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: {
        reason: 'parameter_not_at_location',
        locationId: 931,
        parametersId: 11,
        available: [2, 8],
      },
    });
  });

  it('no_station_near_coordinates recovery no longer advises widening past the ceiling (#13)', async () => {
    installStubService({ findLocations: async () => ({ meta: { found: 0 }, results: [] }) });
    const err = await rejection(
      getReadings.handler(
        getReadings.input.parse({ coordinates: '0,-160', parametersId: 2 }),
        ctxWith(),
      ),
    );

    expect(err.data).toMatchObject({ reason: 'no_station_near_coordinates' });
    // The sweep already ran at the API's 25000m maximum, so "widen the radius" is a dead end.
    const hint = (err.data as { recovery: { hint: string } }).recovery.hint;
    expect(hint).not.toMatch(/radius/i);
    expect(hint).not.toContain('25000');
    expect(hint).toMatch(/bbox|different parametersId/i);
  });

  it('still throws no_recent_values when a present sensor has no current value (#13)', async () => {
    installStubService({
      getLocation: async () => seattleLocation,
      // Station reports pm25 (1701) but nothing for the co sensor (1708).
      getLatest: async () => seattleLatest.filter((l) => l.sensorsId === 1701),
    });
    await expect(
      getReadings.handler(getReadings.input.parse({ locationId: 931, parametersId: 8 }), ctxWith()),
    ).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'no_recent_values', locationId: 931, parametersId: 8 },
    });
  });

  it('routes an upstream 5xx to upstream_error with the declared recovery (#16)', async () => {
    installStubService({
      getLocation: async () => {
        throw serviceUnavailable('OpenAQ returned HTTP 500.', {
          path: '/locations/931',
          status: 500,
        });
      },
      getLatest: async () => seattleLatest,
    });
    await expect(
      getReadings.handler(getReadings.input.parse({ locationId: 931 }), ctxWith()),
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

  it('routes a 429 to rate_limited during coordinate resolution (#16)', async () => {
    installStubService({
      findLocations: async () => {
        throw rateLimited('OpenAQ rate limit exceeded.', { status: 429, retryAfter: '30' });
      },
    });
    await expect(
      getReadings.handler(
        getReadings.input.parse({ coordinates: '47.6,-122.3', parametersId: 2 }),
        ctxWith(),
      ),
    ).rejects.toMatchObject({
      code: JsonRpcErrorCode.RateLimited,
      data: { reason: 'rate_limited', retryAfter: '30' },
    });
  });

  it('routes a request timeout to upstream_timeout (#16)', async () => {
    installStubService({
      getLocation: async () => {
        throw timeout('OpenAQ did not respond within 15s.', { timeoutMs: 15_000 });
      },
      getLatest: async () => seattleLatest,
    });
    await expect(
      getReadings.handler(getReadings.input.parse({ locationId: 931 }), ctxWith()),
    ).rejects.toMatchObject({
      code: JsonRpcErrorCode.Timeout,
      data: { reason: 'upstream_timeout', retryable: true },
    });
  });

  it('routes a 401 to a non-retryable invalid_api_key', async () => {
    installStubService({
      getLocation: async () => {
        throw unauthorized('OpenAQ rejected the API key.', { path: '/locations/931', status: 401 });
      },
      getLatest: async () => seattleLatest,
    });
    await expect(
      getReadings.handler(getReadings.input.parse({ locationId: 931 }), ctxWith()),
    ).rejects.toMatchObject({
      code: JsonRpcErrorCode.Unauthorized,
      data: {
        reason: 'invalid_api_key',
        retryable: false,
        recovery: { hint: expect.stringContaining('OPENAQ_API_KEY') },
      },
    });
  });

  it('maps an upstream 404 to location_not_found', async () => {
    installStubService({
      getLocation: async () => {
        throw notFound('Location not found');
      },
      getLatest: async () => [],
    });
    await expect(
      getReadings.handler(getReadings.input.parse({ locationId: 99999999 }), ctxWith()),
    ).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'location_not_found' },
    });
  });

  it('throws no_recent_values when the latest feed is empty', async () => {
    installStubService({
      getLocation: async () => seattleLocation,
      getLatest: async () => [],
    });
    await expect(
      getReadings.handler(getReadings.input.parse({ locationId: 931 }), ctxWith()),
    ).rejects.toMatchObject({ data: { reason: 'no_recent_values' } });
  });

  it('filters readings to a single parametersId when provided with locationId', async () => {
    installStubService({
      getLocation: async () => seattleLocation,
      getLatest: async () => seattleLatest,
    });
    const ctx = ctxWith();
    const result = await getReadings.handler(
      getReadings.input.parse({ locationId: 931, parametersId: 8 }),
      ctx,
    );
    expect(result.readings).toHaveLength(1);
    expect(result.readings[0]?.parameter.name).toBe('co');
  });

  it('format renders coordinates, timezone, units, and per-value timestamps', () => {
    const blocks = getReadings.format!({
      location: {
        id: 931,
        name: 'Seattle-10th & Weller',
        coordinates: { latitude: 47.6, longitude: -122.3 },
        provider: 'AirNow',
        providerId: 119,
        timezone: 'America/Los_Angeles',
        distanceMeters: null,
        datetimeLast: { utc: '2026-06-13T19:00:00Z', local: '2026-06-13T12:00:00-07:00' },
      },
      readings: [
        {
          parameter: { id: 2, name: 'pm25', displayName: 'PM2.5' },
          value: 3.4,
          unit: 'µg/m³',
          sensorId: 1701,
          datetimeUtc: '2026-06-13T19:00:00Z',
          datetimeLocal: '2026-06-13T12:00:00-07:00',
        },
      ],
    });
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('America/Los_Angeles');
    expect(text).toContain('µg/m³');
    expect(text).toContain('3.4');
    expect(text).toContain('sensor 1701');
  });

  it('rounds display values in content[] while the handler keeps upstream precision (#10)', async () => {
    installStubService({
      getLocation: async () => seattleLocation,
      getLatest: async () => [
        { ...seattleLatest[0]!, value: 0.019899999999999998 },
        { ...seattleLatest[1]!, value: 2.0874999999999995 },
      ],
    });
    const result = await getReadings.handler(
      getReadings.input.parse({ locationId: 931 }),
      ctxWith(),
    );

    // structuredContent keeps the exact upstream numbers.
    expect(result.readings.map((r) => r.value)).toEqual([0.019899999999999998, 2.0874999999999995]);

    const text = (getReadings.format!(result)[0] as { text: string }).text;
    expect(text).toContain('0.0199');
    expect(text).toContain('2.0875');
    expect(text).not.toContain('0.019899999999999998');
    expect(text).not.toContain('2.0874999999999995');
  });
});

describe('openaq_get_readings populated rendering (characterization)', () => {
  it('keeps the station block and reading rows for a fully populated station', async () => {
    installStubService({
      getLocation: async () => seattleLocation,
      getLatest: async () => seattleLatest,
    });
    const result = await runToolContract(getReadings, { locationId: 931 });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      location: {
        id: 931,
        name: 'Seattle-10th & Weller',
        coordinates: { latitude: 47.5972, longitude: -122.3197 },
        timezone: 'America/Los_Angeles',
        distanceMeters: null,
        datetimeLast: { utc: '2026-06-13T19:00:00Z', local: '2026-06-13T12:00:00-07:00' },
      },
    });
    const lines = contentText(result).split('\n');
    expect(lines.slice(0, 3)).toEqual([
      '## Seattle-10th & Weller — id 931',
      'latest data: 2026-06-13T19:00:00Z (local 2026-06-13T12:00:00-07:00)',
      'coords: 47.5972, -122.3197 · timezone: America/Los_Angeles',
    ]);
    expect(lines).toContain(
      '- **PM2.5** (`pm25` #2): 3.4 µg/m³ · 2026-06-13T19:00:00Z (local 2026-06-13T12:00:00-07:00) · sensor 1701',
    );
    expect(lines).toContain(
      '- **CO** (`co` #8): 0.2 ppm · 2026-06-13T19:00:00Z (local 2026-06-13T12:00:00-07:00) · sensor 1708',
    );
  });
});

/**
 * The handler driven through the real OpenAqService down to `fetch`, so the query
 * string OpenAQ receives and the service's distance sort both sit inside the seam.
 * The fake `/v3/locations` honors `limit` the way OpenAQ does: rows come back in
 * ascending id order, cut at the page size, so a small pool drops the newest ids.
 */
describe('openaq_get_readings nearest-station candidate pool (#22)', () => {
  let requested: URL[];

  /**
   * `count` candidates in ascending id order, all measuring parameter 2. Distance
   * falls slowly with row index (24000 m → ~14000 m), except the row at
   * `nearestAt`, which is the true nearest at 937.33 m.
   */
  const makePool = (count: number, nearestAt: number): OpenAqLocation[] =>
    Array.from({ length: count }, (_, i) => ({
      ...seattleLocation,
      id: 100_000 + i,
      name: `Candidate ${i}`,
      distance: i === nearestAt ? 937.33 : 24_000 - i * 10,
    }));

  /** Serve the pool on `/v3/locations`, and any candidate's detail + latest feed by id. */
  const serveUpstream = (pool: OpenAqLocation[]) => {
    vi.mocked(globalThis.fetch).mockImplementation(async (input) => {
      const url = new URL(String(input));
      requested.push(url);
      const json = (body: unknown) =>
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      if (url.pathname === '/v3/locations') {
        const limit = Number(url.searchParams.get('limit'));
        const page = pool.slice(0, limit);
        return json({
          meta: { found: page.length === limit ? `>${limit}` : page.length },
          results: page,
        });
      }
      const [, id, latest] = url.pathname.match(/^\/v3\/locations\/(\d+)(\/latest)?$/) ?? [];
      const location = pool.find((l) => l.id === Number(id)) ?? {
        ...seattleLocation,
        id: Number(id),
      };
      if (latest) {
        return json({ results: seattleLatest.map((l) => ({ ...l, locationsId: location.id })) });
      }
      return json({ results: [location] });
    });
  };

  const searches = () => requested.filter((u) => u.pathname === '/v3/locations');

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

  const byCoordinates = { coordinates: '34.0522,-118.2437', parametersId: 2 };

  it('requests the 1,000-row page cap at the 25 km radius, filtered to the parameter', async () => {
    serveUpstream(makePool(283, 275));
    await runToolContract(getReadings, byCoordinates);
    expect(searches()).toHaveLength(1);
    const qs = searches()[0]!.searchParams;
    expect(qs.get('limit')).toBe('1000');
    expect(qs.get('radius')).toBe('25000');
    expect(qs.get('parameters_id')).toBe('2');
    expect(qs.get('coordinates')).toBe('34.0522,-118.2437');
  });

  it('finds the nearest station when it sits past row 100 of the id-ordered list', async () => {
    serveUpstream(makePool(283, 275));
    const result = await runToolContract(getReadings, byCoordinates);
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      location: { id: 100_275, distanceMeters: 937.33 },
    });
    expect(contentText(result)).toContain('## Candidate 275 — id 100275');
    expect(contentText(result)).toContain('937m from query');
    // A pool under the page cap compared every match, so nothing is disclosed.
    expect(result.structuredContent).not.toHaveProperty('notice');
  });

  it('discloses a full 1,000-row pool as the nearest of the first 1,000 on both surfaces', async () => {
    serveUpstream(makePool(1000, 999));
    const result = await runToolContract(getReadings, byCoordinates);
    expect(result.isError).toBeFalsy();
    const structured = result.structuredContent as { location: { id: number }; notice?: string };
    expect(structured.location.id).toBe(100_999);
    expect(structured.notice).toMatch(/nearest of the first 1,000/);
    expect(structured.notice).toMatch(/not necessarily the nearest/);
    expect(contentText(result)).toContain(structured.notice as string);
  });

  it('sets no notice on a 999-row pool, and still reaches its last row', async () => {
    serveUpstream(makePool(999, 998));
    const result = await runToolContract(getReadings, byCoordinates);
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({ location: { id: 100_998 } });
    expect(result.structuredContent).not.toHaveProperty('notice');
    expect(contentText(result)).not.toMatch(/first 1,000/);
  });

  it('still fails an empty pool with no_station_near_coordinates', async () => {
    serveUpstream([]);
    const result = await runToolContract(getReadings, byCoordinates);
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: { data: { reason: 'no_station_near_coordinates' } },
    });
    expect(searches()[0]!.searchParams.get('limit')).toBe('1000');
  });

  it('makes no /v3/locations search when called by locationId', async () => {
    serveUpstream(makePool(5, 0));
    const result = await runToolContract(getReadings, { locationId: 100_003 });
    expect(result.isError).toBeFalsy();
    expect(searches()).toHaveLength(0);
    expect(requested.map((u) => u.pathname).sort()).toEqual([
      '/v3/locations/100003',
      '/v3/locations/100003/latest',
    ]);
  });
});

describe('openaq_get_readings station provider (#30)', () => {
  it('returns provider and providerId on both surfaces by locationId, in two requests', async () => {
    const findLocations = vi.fn();
    const getLocation = vi.fn(async () => seattleLocation);
    const getLatest = vi.fn(async () => seattleLatest);
    installStubService({ findLocations, getLocation, getLatest });
    const result = await runToolContract(getReadings, { locationId: 931 });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      location: {
        provider: 'AirNow',
        providerId: 119,
        timezone: 'America/Los_Angeles',
      },
    });
    expect(contentText(result)).toContain('provider: AirNow (providerId 119)');
    expect(findLocations).not.toHaveBeenCalled();
    expect(getLocation).toHaveBeenCalledTimes(1);
    expect(getLatest).toHaveBeenCalledTimes(1);
  });

  it('returns provider and providerId by coordinates, in three requests', async () => {
    const findLocations = vi.fn(async () => ({ meta: { found: 1 }, results: [seattleLocation] }));
    const getLocation = vi.fn(async () => seattleLocation);
    const getLatest = vi.fn(async () => seattleLatest);
    installStubService({ findLocations, getLocation, getLatest });
    const result = await runToolContract(getReadings, {
      coordinates: '47.6062,-122.3321',
      parametersId: 2,
    });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      location: { id: 931, provider: 'AirNow', providerId: 119 },
    });
    expect(contentText(result)).toContain('provider: AirNow (providerId 119)');
    expect(findLocations).toHaveBeenCalledTimes(1);
    expect(getLocation).toHaveBeenCalledTimes(1);
    expect(getLatest).toHaveBeenCalledTimes(1);
  });

  it('yields null provider and providerId when OpenAQ lists none — never "Unknown"', async () => {
    installStubService({
      getLocation: async () => ({ ...seattleLocation, provider: null }),
      getLatest: async () => seattleLatest,
    });
    const result = await runToolContract(getReadings, { locationId: 931 });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      location: { provider: null, providerId: null },
    });
    const text = contentText(result);
    expect(text).toContain('provider: not listed by OpenAQ');
    expect(text).not.toMatch(/unknown/i);
    expect(text).not.toContain('null');
  });
});

describe('openaq_get_readings missing coordinates stay missing (#40)', () => {
  it.each([
    ['only latitude null', { latitude: null, longitude: -122.3197 }],
    ['only longitude null', { latitude: 47.5972, longitude: null }],
    ['coordinates null', null],
  ])('yields coordinates: null with %s, never 0', async (_label, coordinates) => {
    installStubService({
      getLocation: async () => ({ ...seattleLocation, coordinates }),
      getLatest: async () => seattleLatest,
    });
    const result = await runToolContract(getReadings, { locationId: 931 });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({ location: { coordinates: null } });
    const text = contentText(result);
    expect(text).toContain('coords: not listed by OpenAQ · timezone: America/Los_Angeles');
    expect(text).not.toMatch(/coords: [^\n·]*\b0\b/);
    expect(text).not.toMatch(/unknown/i);
    expect(text).not.toContain('null');
  });
});

describe('openaq_get_readings id inputs must be positive (#33)', () => {
  /** Rejects any fetch, so a path that reaches the network without a stub fails loudly. */
  beforeEach(() => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('unmocked fetch in a unit test'));
  });
  afterEach(() => vi.restoreAllMocks());

  const emitted = () =>
    z.toJSONSchema(getReadings.input, { io: 'input' }) as {
      properties: Record<string, Record<string, unknown>>;
    };

  it.each(['locationId', 'parametersId'])('advertises %s as an integer', (field) => {
    expect(emitted().properties[field]).toMatchObject({
      type: 'integer',
      description: expect.any(String),
    });
  });

  it.each(['locationId', 'parametersId'])('advertises %s with exclusiveMinimum 0', (field) => {
    expect(emitted().properties[field]).toMatchObject({ exclusiveMinimum: 0 });
    expect(emitted().properties[field]).not.toHaveProperty('minimum');
  });

  it.each([
    ['locationId', { locationId: 0 }],
    ['locationId', { locationId: -1 }],
    ['parametersId', { locationId: 931, parametersId: 0 }],
    ['parametersId', { locationId: 931, parametersId: -3 }],
    ['parametersId', { coordinates: '47.6062,-122.3321', parametersId: 0 }],
    ['parametersId', { coordinates: '47.6062,-122.3321', parametersId: -1 }],
  ])('rejects a non-positive %s as invalid_arguments before any request', async (field, input) => {
    const findLocations = vi.fn(async () => ({ meta: { found: 1 }, results: [seattleLocation] }));
    const getLocation = vi.fn(async () => seattleLocation);
    const getLatest = vi.fn(async () => seattleLatest);
    installStubService({ findLocations, getLocation, getLatest });
    const result = await runToolContract(getReadings, input);
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: {
        code: JsonRpcErrorCode.InvalidParams,
        data: { reason: 'invalid_arguments', issues: [{ path: [field] }] },
      },
    });
    const text = result.content.map((b) => (b.type === 'text' ? b.text : '')).join('\n');
    expect(text).toContain(field);
    // Never a false no-coverage or wrong-parameter answer for an id that cannot exist.
    expect(text).not.toMatch(/no_station_near_coordinates|parameter_not_at_location/);
    expect(findLocations).not.toHaveBeenCalled();
    expect(getLocation).not.toHaveBeenCalled();
    expect(getLatest).not.toHaveBeenCalled();
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('still accepts the lowest real ids', () => {
    expect(getReadings.input.parse({ locationId: 1, parametersId: 1 })).toMatchObject({
      locationId: 1,
      parametersId: 1,
    });
  });
});
