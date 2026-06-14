/**
 * @fileoverview openaq_get_measurements tests — sensor resolution (the headline
 * goal: pass a location, the tool finds the sensor), the daily summary, raw vs
 * rollup shaping, the single-reading sd:null trap, date-range + parameter errors,
 * and the DataCanvas spill (degraded notice without DuckDB, staged table with it).
 * @module tests/tools/get-measurements.tool.test
 */

import type { DataCanvas } from '@cyanheads/mcp-ts-core/canvas';
import { JsonRpcErrorCode, notFound } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getMeasurements } from '@/mcp-server/tools/definitions/get-measurements.tool.js';
import { setCanvas } from '@/services/canvas-accessor.js';
import type { MeasurementsPage } from '@/services/openaq/openaq-service.js';
import { setOpenAqService } from '@/services/openaq/openaq-service.js';
import type { OpenAqMeasurement } from '@/services/openaq/types.js';
import {
  dailyMeasurement,
  rawMeasurement,
  seattleLocation,
  singleReadingHourly,
} from '../fixtures/openaq.js';
import { installStubService } from '../fixtures/stub-service.js';

const ctxWith = () => createMockContext({ errors: getMeasurements.errors });

/** One-page result (results shorter than the page limit → exhausted). */
const onePage = (results: OpenAqMeasurement[]): MeasurementsPage => ({
  results,
  found: results.length,
});

afterEach(() => {
  setOpenAqService(undefined as never);
  setCanvas(undefined);
  vi.restoreAllMocks();
});

describe('openaq_get_measurements', () => {
  it('resolves the sensor for the parameter and returns the daily series with summary (headline goal)', async () => {
    installStubService({
      getLocation: async () => seattleLocation,
      getMeasurements: async (sensorId) => {
        expect(sensorId).toBe(1701); // resolved internally from parameter id 2
        return onePage([dailyMeasurement]);
      },
    });
    const ctx = ctxWith();
    const result = await getMeasurements.handler(
      getMeasurements.input.parse({
        locationId: 931,
        parametersId: 2,
        aggregation: 'daily',
        datetimeFrom: '2026-05-01',
        datetimeTo: '2026-06-01',
      }),
      ctx,
    );

    expect(result.sensorId).toBe(1701);
    expect(result.parameter).toMatchObject({ id: 2, name: 'pm25', unit: 'µg/m³' });
    expect(result.series).toHaveLength(1);
    expect(result.series[0]?.summary).toMatchObject({
      min: 4.3,
      median: 7.85,
      max: 14.7,
      sd: 2.68,
    });
    expect(result.truncated).toBeUndefined();
    expect(getEnrichment(ctx).totalCount).toBe(1);
  });

  it('returns summary:null for raw aggregation', async () => {
    installStubService({
      getLocation: async () => seattleLocation,
      getMeasurements: async () => onePage([rawMeasurement]),
    });
    const result = await getMeasurements.handler(
      getMeasurements.input.parse({ locationId: 931, parametersId: 2, aggregation: 'raw' }),
      ctxWith(),
    );
    expect(result.series[0]?.summary).toBeNull();
    expect(result.series[0]?.value).toBe(6.3);
  });

  it('preserves summary.sd:null for a single-reading hourly bucket (the -32007 trap)', async () => {
    installStubService({
      getLocation: async () => seattleLocation,
      getMeasurements: async () => onePage([singleReadingHourly]),
    });
    // Output must validate against the schema with sd === null.
    const ctx = ctxWith();
    const result = await getMeasurements.handler(
      getMeasurements.input.parse({ locationId: 931, parametersId: 2, aggregation: 'hourly' }),
      ctx,
    );
    expect(result.series[0]?.summary?.sd).toBeNull();
    expect(result).toEqual(expect.schemaMatching(getMeasurements.output));
  });

  it('throws parameter_not_at_location when no sensor measures the parameter', async () => {
    installStubService({ getLocation: async () => seattleLocation });
    await expect(
      getMeasurements.handler(
        getMeasurements.input.parse({ locationId: 931, parametersId: 999 }),
        ctxWith(),
      ),
    ).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'parameter_not_at_location' },
    });
  });

  it('throws location_not_found on an upstream 404', async () => {
    installStubService({
      getLocation: async () => {
        throw notFound('Location not found');
      },
    });
    await expect(
      getMeasurements.handler(
        getMeasurements.input.parse({ locationId: 99999999, parametersId: 2 }),
        ctxWith(),
      ),
    ).rejects.toMatchObject({ data: { reason: 'location_not_found' } });
  });

  it('throws invalid_date_range when datetimeTo precedes datetimeFrom', async () => {
    installStubService({});
    await expect(
      getMeasurements.handler(
        getMeasurements.input.parse({
          locationId: 931,
          parametersId: 2,
          datetimeFrom: '2026-06-01',
          datetimeTo: '2026-05-01',
        }),
        ctxWith(),
      ),
    ).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'invalid_date_range' },
    });
  });

  it('throws no_data_for_range when the sensor has no measurements', async () => {
    installStubService({
      getLocation: async () => seattleLocation,
      getMeasurements: async () => onePage([]),
    });
    await expect(
      getMeasurements.handler(
        getMeasurements.input.parse({ locationId: 931, parametersId: 2 }),
        ctxWith(),
      ),
    ).rejects.toMatchObject({ data: { reason: 'no_data_for_range' } });
  });

  it('degrades gracefully without DataCanvas: truncated preview + notice, no throw', async () => {
    const many = Array.from({ length: 150 }, () => dailyMeasurement);
    installStubService({
      getLocation: async () => seattleLocation,
      getMeasurements: async () => onePage(many),
    });
    setCanvas(undefined); // canvas disabled
    const ctx = ctxWith();
    const result = await getMeasurements.handler(
      getMeasurements.input.parse({ locationId: 931, parametersId: 2, aggregation: 'daily' }),
      ctx,
    );
    expect(result.truncated).toBe(true);
    expect(result.canvasId).toBeUndefined();
    expect(result.series.length).toBeLessThan(150); // previewed
    expect(getEnrichment(ctx).notice).toMatch(/DataCanvas|CANVAS_PROVIDER_TYPE/);
  });

  it('stages the full series on a canvas when DuckDB is enabled', async () => {
    const many = Array.from({ length: 150 }, () => dailyMeasurement);
    installStubService({
      getLocation: async () => seattleLocation,
      getMeasurements: async () => onePage(many),
    });
    const registerTable = vi.fn(async (name: string, rows: unknown[]) => ({
      tableName: name,
      rowCount: rows.length,
      columns: ['datetimeFrom', 'value'],
    }));
    const drop = vi.fn(async () => true);
    const fakeCanvas = {
      acquire: vi.fn(async () => ({ canvasId: 'abc1234567', isNew: true, registerTable, drop })),
    } as unknown as DataCanvas;
    setCanvas(fakeCanvas);

    const ctx = ctxWith();
    const result = await getMeasurements.handler(
      getMeasurements.input.parse({ locationId: 931, parametersId: 2, aggregation: 'daily' }),
      ctx,
    );
    expect(result.truncated).toBe(true);
    expect(result.canvasId).toBe('abc1234567');
    expect(result.tableName).toBe('measurements_1701');
    expect(registerTable).toHaveBeenCalledWith(
      'measurements_1701',
      expect.any(Array),
      expect.anything(),
    );
    expect(drop).toHaveBeenCalledWith('measurements_1701'); // idempotent re-stage
  });

  it('format renders location id, parameter id, aggregation, and the spill pointer', () => {
    const blocks = getMeasurements.format!({
      location: { id: 931, name: 'Seattle' },
      parameter: { id: 2, name: 'pm25', unit: 'µg/m³', displayName: 'PM2.5' },
      sensorId: 1701,
      aggregation: 'daily',
      series: [
        {
          datetimeFrom: '2026-05-01T07:00:00Z',
          datetimeTo: '2026-05-02T07:00:00Z',
          value: 7.89,
          summary: { min: 4.3, median: 7.85, max: 14.7, avg: 7.88, sd: 2.68 },
          percentComplete: 100,
          flagged: false,
        },
      ],
      rowCount: 1,
      canvasId: 'abc1234567',
      tableName: 'measurements_1701',
      truncated: true,
    });
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('id 931');
    expect(text).toContain('#2');
    expect(text).toContain('abc1234567');
    expect(text).toContain('measurements_1701');
  });
});
