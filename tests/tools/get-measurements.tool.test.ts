/**
 * @fileoverview openaq_get_measurements tests — sensor resolution (the headline
 * goal: pass a location, the tool finds the sensor), the daily summary, raw vs
 * rollup shaping, the single-reading sd:null trap, date-range + parameter errors,
 * and the DataCanvas spill (degraded notice without DuckDB, staged table with it).
 * @module tests/tools/get-measurements.tool.test
 */

import type { DataCanvas } from '@cyanheads/mcp-ts-core/canvas';
import {
  JsonRpcErrorCode,
  McpError,
  notFound,
  rateLimited,
  serviceUnavailable,
  timeout,
} from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getMeasurements } from '@/mcp-server/tools/definitions/get-measurements.tool.js';
import { setCanvas } from '@/services/canvas-accessor.js';
import type { MeasurementsPage } from '@/services/openaq/openaq-service.js';
import { setOpenAqService } from '@/services/openaq/openaq-service.js';
import type { OpenAqMeasurement } from '@/services/openaq/types.js';
import {
  dailyMeasurement,
  gapBucketHourly,
  impreciseDaily,
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

/** A full page (1000 rows) — the pager keeps going after one of these. */
const fullPage = (row: OpenAqMeasurement, found: number): MeasurementsPage => ({
  results: Array.from({ length: 1000 }, () => row),
  found,
});

/** The text of the single block `format()` returns. */
const formatText = (result: Parameters<NonNullable<typeof getMeasurements.format>>[0]): string =>
  (getMeasurements.format!(result)[0] as { text: string }).text;

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

describe('openaq_get_measurements gap buckets (#11)', () => {
  it('carries a null bucket value through output validation instead of failing the series', async () => {
    installStubService({
      getLocation: async () => seattleLocation,
      getMeasurements: async () =>
        onePage([singleReadingHourly, gapBucketHourly, dailyMeasurement]),
    });
    const result = await getMeasurements.handler(
      getMeasurements.input.parse({ locationId: 931, parametersId: 2, aggregation: 'hourly' }),
      ctxWith(),
    );

    expect(result.series).toHaveLength(3);
    expect(result.series[1]?.value).toBeNull();
    expect(result.series[1]?.summary).toEqual({
      min: null,
      median: null,
      max: null,
      avg: null,
      sd: null,
    });
    // The whole point: a null anywhere in the window used to fail output validation.
    expect(result).toEqual(expect.schemaMatching(getMeasurements.output));
  });

  it('renders a gap bucket as "no data" with no unit, and keeps its coverage', () => {
    const text = formatText({
      location: { id: 1938, name: 'Seattle-Beacon Hill' },
      parameter: { id: 2, name: 'pm25', unit: 'µg/m³', displayName: 'PM2.5' },
      sensorId: 3425,
      aggregation: 'hourly',
      series: [
        {
          datetimeFrom: '2024-01-03T18:00:00Z',
          datetimeTo: '2024-01-03T19:00:00Z',
          value: null,
          summary: { min: null, median: null, max: null, avg: null, sd: null },
          percentComplete: 100,
          flagged: false,
        },
      ],
      rowCount: 1,
    });
    expect(text).toContain('no data');
    expect(text).not.toContain('null');
    expect(text).not.toContain('no data µg/m³');
    expect(text).toContain('100% complete');
  });
});

describe('openaq_get_measurements date-range normalization (#6)', () => {
  /** Installs a stub that records the range forwarded upstream. */
  const recordingStub = () => {
    const seen: { datetimeFrom?: string; datetimeTo?: string } = {};
    installStubService({
      getLocation: async () => seattleLocation,
      getMeasurements: async (_sensorId, params) => {
        seen.datetimeFrom = params.datetimeFrom;
        seen.datetimeTo = params.datetimeTo;
        return onePage([dailyMeasurement]);
      },
    });
    return seen;
  };

  it('accepts a same-day range given as timestamp → date, expanding the date to end of day', async () => {
    const seen = recordingStub();
    const result = await getMeasurements.handler(
      getMeasurements.input.parse({
        locationId: 931,
        parametersId: 2,
        aggregation: 'daily',
        datetimeFrom: '2026-06-25T00:00:00Z',
        datetimeTo: '2026-06-25',
      }),
      ctxWith(),
    );
    expect(result.series).toHaveLength(1);
    expect(seen).toEqual({
      datetimeFrom: '2026-06-25T00:00:00Z',
      datetimeTo: '2026-06-25T23:59:59Z',
    });
  });

  it('accepts a same-day date-only range as a full day', async () => {
    const seen = recordingStub();
    await getMeasurements.handler(
      getMeasurements.input.parse({
        locationId: 931,
        parametersId: 2,
        aggregation: 'daily',
        datetimeFrom: '2026-06-25',
        datetimeTo: '2026-06-25',
      }),
      ctxWith(),
    );
    expect(seen).toEqual({
      datetimeFrom: '2026-06-25T00:00:00Z',
      datetimeTo: '2026-06-25T23:59:59Z',
    });
  });

  it('rejects date → same-day midnight locally rather than forwarding a range OpenAQ 500s on', async () => {
    installStubService({
      getLocation: async () => seattleLocation,
      getMeasurements: async () => {
        throw new Error('upstream must not be called for an empty range');
      },
    });
    await expect(
      getMeasurements.handler(
        getMeasurements.input.parse({
          locationId: 931,
          parametersId: 2,
          aggregation: 'daily',
          datetimeFrom: '2026-06-25',
          datetimeTo: '2026-06-25T00:00:00Z',
        }),
        ctxWith(),
      ),
    ).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: {
        reason: 'invalid_date_range',
        datetimeFrom: '2026-06-25T00:00:00Z',
        datetimeTo: '2026-06-25T00:00:00Z',
      },
    });
  });

  it('still rejects a genuinely reversed mixed-format range', async () => {
    installStubService({ getLocation: async () => seattleLocation });
    await expect(
      getMeasurements.handler(
        getMeasurements.input.parse({
          locationId: 931,
          parametersId: 2,
          datetimeFrom: '2026-06-25T12:00:00Z',
          datetimeTo: '2026-06-24',
        }),
        ctxWith(),
      ),
    ).rejects.toMatchObject({ data: { reason: 'invalid_date_range' } });
  });
});

describe('openaq_get_measurements partial pulls (#12)', () => {
  it('keeps the rows already fetched when a later page fails, and says what was lost', async () => {
    installStubService({
      getLocation: async () => seattleLocation,
      getMeasurements: async (_sensorId, params) => {
        if (params.page >= 3)
          throw timeout('OpenAQ timed out serving the request.', { status: 408 });
        return fullPage(rawMeasurement, Number.POSITIVE_INFINITY);
      },
    });
    const ctx = ctxWith();
    const result = await getMeasurements.handler(
      getMeasurements.input.parse({ locationId: 931, parametersId: 2, aggregation: 'raw' }),
      ctx,
    );

    expect(result.rowCount).toBe(100); // preview of the 2000 rows that survived
    expect(result.truncated).toBe(true);
    expect(getEnrichment(ctx).notice).toMatch(/partial.*page 3.*2000 rows/s);
  });

  it('still throws when the very first page fails — there is nothing to preserve', async () => {
    installStubService({
      getLocation: async () => seattleLocation,
      getMeasurements: async () => {
        throw timeout('OpenAQ timed out serving the request.', { status: 408 });
      },
    });
    await expect(
      getMeasurements.handler(
        getMeasurements.input.parse({ locationId: 931, parametersId: 2, aggregation: 'raw' }),
        ctxWith(),
      ),
    ).rejects.toMatchObject({ data: { reason: 'upstream_timeout' } });
  });

  it('discloses the 5000-row pull cap instead of only setting truncated', async () => {
    installStubService({
      getLocation: async () => seattleLocation,
      getMeasurements: async () => fullPage(rawMeasurement, 12_000),
    });
    const ctx = ctxWith();
    const result = await getMeasurements.handler(
      getMeasurements.input.parse({ locationId: 931, parametersId: 2, aggregation: 'raw' }),
      ctx,
    );

    expect(result.truncated).toBe(true);
    expect(getEnrichment(ctx).totalCount).toBe(12_000);
    expect(getEnrichment(ctx).notice).toMatch(/capped at 5000 rows of 12000/);
  });
});

describe('openaq_get_measurements canvas staging failures (#19)', () => {
  const many = () => Array.from({ length: 150 }, () => dailyMeasurement);

  it('degrades to the truncated preview when the canvas cannot start', async () => {
    installStubService({
      getLocation: async () => seattleLocation,
      getMeasurements: async () => onePage(many()),
    });
    setCanvas({
      acquire: vi.fn(async () => {
        throw new McpError(
          JsonRpcErrorCode.ConfigurationError,
          'Install "@duckdb/node-api" to use the DuckDB canvas provider: bun add @duckdb/node-api',
        );
      }),
    } as unknown as DataCanvas);

    const ctx = ctxWith();
    const result = await getMeasurements.handler(
      getMeasurements.input.parse({ locationId: 931, parametersId: 2, aggregation: 'daily' }),
      ctx,
    );

    expect(result.truncated).toBe(true);
    expect(result.canvasId).toBeUndefined();
    expect(result.series).toHaveLength(100); // the 150 fetched rows are not lost
    expect(getEnrichment(ctx).notice).toMatch(/could not stage.*@duckdb\/node-api/s);
  });

  it('degrades the same way when registerTable throws after a successful acquire', async () => {
    installStubService({
      getLocation: async () => seattleLocation,
      getMeasurements: async () => onePage(many()),
    });
    setCanvas({
      acquire: vi.fn(async () => ({
        canvasId: 'abc1234567',
        isNew: true,
        drop: vi.fn(async () => true),
        registerTable: vi.fn(async () => {
          throw new Error('duckdb instance closed');
        }),
      })),
    } as unknown as DataCanvas);

    const ctx = ctxWith();
    const result = await getMeasurements.handler(
      getMeasurements.input.parse({ locationId: 931, parametersId: 2, aggregation: 'daily' }),
      ctx,
    );

    expect(result.truncated).toBe(true);
    expect(result.canvasId).toBeUndefined();
    expect(getEnrichment(ctx).notice).toMatch(/duckdb instance closed/);
  });

  it('still fails a supplied canvas_id that cannot be resolved — that one is the caller to fix', async () => {
    installStubService({
      getLocation: async () => seattleLocation,
      getMeasurements: async () => onePage(many()),
    });
    setCanvas({
      acquire: vi.fn(async () => {
        throw notFound('Canvas not found.', { reason: 'canvas_not_found' });
      }),
    } as unknown as DataCanvas);

    await expect(
      getMeasurements.handler(
        getMeasurements.input.parse({
          locationId: 931,
          parametersId: 2,
          aggregation: 'daily',
          canvas_id: 'goneCanvas',
        }),
        ctxWith(),
      ),
    ).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'canvas_not_found', canvasId: 'goneCanvas' },
    });
  });
});

describe('openaq_get_measurements format row accounting (#15) and rounding (#10)', () => {
  const previewResult = (rows: number, truncated: boolean) => ({
    location: { id: 1938, name: 'Seattle-Beacon Hill' },
    parameter: { id: 2, name: 'pm25', unit: 'µg/m³', displayName: 'PM2.5' },
    sensorId: 3425,
    aggregation: 'hourly' as const,
    series: Array.from({ length: rows }, (_, i) => ({
      datetimeFrom: `2026-06-01T${String(i % 24).padStart(2, '0')}:00:00Z`,
      datetimeTo: `2026-06-01T${String((i + 1) % 24).padStart(2, '0')}:00:00Z`,
      value: 5.3,
      summary: null,
      percentComplete: 100,
      flagged: false,
    })),
    rowCount: rows,
    ...(truncated
      ? { truncated: true, canvasId: 'abc1234567', tableName: 'measurements_3425' }
      : {}),
  });

  it('states the rendered count honestly when the preview exceeds the display slice', () => {
    const text = formatText(previewResult(100, true));
    const rendered = text.split('\n').filter((l) => l.startsWith('- ')).length;

    expect(rendered).toBe(20);
    expect(text).toContain('20 of 100 preview rows shown');
    expect(text).not.toContain('100 rows shown');
    expect(text).toContain('80 further rows');
    expect(text).toContain('structuredContent.series');
  });

  it('renders every row and drops the split note when the series fits the display slice', () => {
    const text = formatText(previewResult(12, false));
    const rendered = text.split('\n').filter((l) => l.startsWith('- ')).length;

    expect(rendered).toBe(12);
    expect(text).toContain('12 rows shown');
    expect(text).not.toContain('further row');
  });

  it('rounds display values in content[] while structuredContent keeps exact precision', async () => {
    installStubService({
      getLocation: async () => seattleLocation,
      getMeasurements: async () => onePage([impreciseDaily]),
    });
    const result = await getMeasurements.handler(
      getMeasurements.input.parse({ locationId: 931, parametersId: 2, aggregation: 'daily' }),
      ctxWith(),
    );

    // Exact upstream numbers survive on the machine-readable surface.
    expect(result.series[0]?.summary?.avg).toBe(0.02070833333333334);
    expect(result.series[0]?.summary?.sd).toBe(0.0074977049628633);

    const text = formatText(result);
    expect(text).toContain('avg 0.02071');
    expect(text).toContain('sd 0.007498');
    expect(text).not.toContain('0.02070833333333334');
    expect(text).not.toContain('0.0074977049628633');
  });
});

describe('openaq_get_measurements error contract (#16)', () => {
  const args = { locationId: 931, parametersId: 2 };

  it('surfaces a 5xx on the location lookup as upstream_error, not location_not_found', async () => {
    installStubService({
      getLocation: async () => {
        throw serviceUnavailable('OpenAQ returned HTTP 500.', {
          path: '/locations/931',
          status: 500,
        });
      },
    });
    await expect(
      getMeasurements.handler(getMeasurements.input.parse(args), ctxWith()),
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

  it('surfaces a 429 raised mid-paging as rate_limited', async () => {
    installStubService({
      getLocation: async () => seattleLocation,
      getMeasurements: async () => {
        throw rateLimited('OpenAQ rate limit exceeded.', { status: 429, retryAfter: '30' });
      },
    });
    await expect(
      getMeasurements.handler(getMeasurements.input.parse(args), ctxWith()),
    ).rejects.toMatchObject({
      code: JsonRpcErrorCode.RateLimited,
      data: {
        reason: 'rate_limited',
        retryAfter: '30',
        recovery: { hint: expect.stringContaining('daily') },
      },
    });
  });

  it('surfaces a timeout raised mid-paging as upstream_timeout', async () => {
    installStubService({
      getLocation: async () => seattleLocation,
      getMeasurements: async () => {
        throw timeout('OpenAQ did not respond within 15s.', { timeoutMs: 15_000 });
      },
    });
    await expect(
      getMeasurements.handler(getMeasurements.input.parse(args), ctxWith()),
    ).rejects.toMatchObject({
      code: JsonRpcErrorCode.Timeout,
      data: { reason: 'upstream_timeout', timeoutMs: 15_000 },
    });
  });

  it('declares canvas_not_found for the canvas_id reuse input', () => {
    // canvas.acquire() throws it from inside the framework, so the contract is the
    // only place it can be advertised to a client.
    expect(getMeasurements.errors?.map((e) => e.reason)).toContain('canvas_not_found');
  });
});
