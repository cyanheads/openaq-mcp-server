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

import {
  JsonRpcErrorCode,
  type McpError,
  notFound,
  rateLimited,
  serviceUnavailable,
  timeout,
  unauthorized,
} from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { getReadings } from '@/mcp-server/tools/definitions/get-readings.tool.js';
import { setOpenAqService } from '@/services/openaq/openaq-service.js';
import { seattleLatest, seattleLocation } from '../fixtures/openaq.js';
import { installStubService } from '../fixtures/stub-service.js';

const ctxWith = () => createMockContext({ errors: getReadings.errors });

afterEach(() => setOpenAqService(undefined as never));

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
    // Nearest resolution pulls a candidate pool (not limit:1) so the distance sort
    // can surface the true nearest; radius 25000 + the parameter filter still apply.
    expect(findArgs).toMatchObject({ radius: 25000, parametersId: 2, limit: 100 });
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
    const err = await getReadings
      .handler(getReadings.input.parse({ coordinates: '47.6,-122.3' }), ctxWith())
      .catch((e: McpError) => e);
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
    const err = await getReadings
      .handler(getReadings.input.parse({ coordinates: '0,-160', parametersId: 2 }), ctxWith())
      .catch((e: McpError) => e);

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
});
