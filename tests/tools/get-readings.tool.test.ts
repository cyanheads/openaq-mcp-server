/**
 * @fileoverview openaq_get_readings tests — the latest×sensors JOIN (the headline
 * goal: every value carries its pollutant + unit), the coordinates resolution
 * path, scope validation, location_not_found, no_recent_values, and the
 * parametersId filter.
 * @module tests/tools/get-readings.tool.test
 */

import { JsonRpcErrorCode, notFound } from '@cyanheads/mcp-ts-core/errors';
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
    // Nearest-station resolution uses radius 25000 + the parameter filter + limit 1.
    expect(findArgs).toMatchObject({ radius: 25000, parametersId: 2, limit: 1 });
    expect(result.location.distanceMeters).toBe(1364.84);
    expect(result.readings.length).toBeGreaterThan(0);
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

  it('throws missing_coordinates_parameter when both locationId and coordinates are set', async () => {
    installStubService({});
    await expect(
      getReadings.handler(
        getReadings.input.parse({ locationId: 931, coordinates: '47.6,-122.3', parametersId: 2 }),
        ctxWith(),
      ),
    ).rejects.toMatchObject({ data: { reason: 'missing_coordinates_parameter' } });
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
