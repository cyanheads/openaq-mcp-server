/**
 * @fileoverview openaq_get_measurements tests — sensor resolution (the headline
 * goal: pass a location, the tool finds the sensor), the daily summary, raw vs
 * rollup shaping, the single-reading sd:null trap, date-range + parameter errors,
 * and the DataCanvas spill (degraded notice without DuckDB, staged table with it).
 * @module tests/tools/get-measurements.tool.test
 */

import { z } from '@cyanheads/mcp-ts-core';
import type { DataCanvas } from '@cyanheads/mcp-ts-core/canvas';
import {
  JsonRpcErrorCode,
  McpError,
  notFound,
  rateLimited,
  serviceUnavailable,
  timeout,
} from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
  foundIsLowerBound: false,
});

/**
 * A full page (1000 rows) — the pager keeps going after one of these. `found` is
 * the numeric floor the service reads out of `meta.found`; pass
 * `foundIsLowerBound: true` for the `">N"` shape, where more rows exist than the
 * number says.
 */
const fullPage = (
  row: OpenAqMeasurement,
  found: number,
  foundIsLowerBound = false,
): MeasurementsPage => ({
  results: Array.from({ length: 1000 }, () => row),
  found,
  foundIsLowerBound,
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
      pulledCount: 983,
      pullComplete: true,
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
      pulledCount: 1,
      pullComplete: true,
    });
    expect(text).toContain('no data');
    expect(text).not.toContain('null');
    expect(text).not.toContain('no data µg/m³');
    expect(text).toContain('100% complete');
  });
});

describe('openaq_get_measurements cancellation', () => {
  it('stops paging when the request is aborted instead of reporting a partial series', async () => {
    const controller = new AbortController();
    let pagesServed = 0;
    installStubService({
      getLocation: async () => seattleLocation,
      getMeasurements: async () => {
        pagesServed++;
        controller.abort();
        return fullPage(dailyMeasurement, 100_000);
      },
    });
    const ctx = createMockContext({
      errors: getMeasurements.errors,
      signal: controller.signal,
    });

    await expect(
      getMeasurements.handler(
        getMeasurements.input.parse({ locationId: 931, parametersId: 2, aggregation: 'daily' }),
        ctx,
      ),
    ).rejects.toThrow();
    // One page, then the abort — not the ceiling's worth, and no "series is partial" notice.
    expect(pagesServed).toBe(1);
  });

  it('propagates an abort that interrupts an in-flight page fetch', async () => {
    // The realistic shape: the signal fires while a page request is outstanding,
    // so the abort reaches the handler as a rejection from inside the try — the
    // one place a partial-series degradation could swallow it.
    const controller = new AbortController();
    let pagesServed = 0;
    installStubService({
      getLocation: async () => seattleLocation,
      getMeasurements: async () => {
        pagesServed++;
        if (pagesServed === 1) return fullPage(dailyMeasurement, 100_000);
        controller.abort(new Error('client went away'));
        throw new Error('OpenAQ request failed.');
      },
    });
    const ctx = createMockContext({
      errors: getMeasurements.errors,
      signal: controller.signal,
    });

    // Page 1 succeeded, so the degradation path is live — an abort must still win.
    await expect(
      getMeasurements.handler(
        getMeasurements.input.parse({ locationId: 931, parametersId: 2, aggregation: 'daily' }),
        ctx,
      ),
    ).rejects.toThrow('client went away');
    expect(pagesServed).toBe(2);
  });
});

describe('openaq_get_measurements date-range normalization (#6)', () => {
  /** Installs a stub that records the range forwarded upstream. */
  const recordingStub = () => {
    const seen: { datetimeFrom?: string | undefined; datetimeTo?: string | undefined } = {};
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
        return fullPage(rawMeasurement, 1000, true);
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
    // An exact upstream total stays exact — the cap bounds the pull, not the count.
    expect(getEnrichment(ctx).totalCountIsLowerBound).toBeUndefined();
    expect(result.pulledCount).toBe(5000);
    expect(result.pullComplete).toBe(false);
  });
});

/**
 * `meta.found` arrives as `">N"` for a multi-page raw series, so the number in it
 * is a floor. A pull that stops early cannot turn that floor into an exact total,
 * and publishing the rows it managed to pull as the series total made 5,001
 * matching rows indistinguishable from 500,000.
 */
describe('openaq_get_measurements incomplete pulls report a floor (#23)', () => {
  /** A pager that never exhausts, reporting `found` (optionally as a lower bound). */
  const endlessSeries = (found: number, isLowerBound: boolean) =>
    installStubService({
      getLocation: async () => seattleLocation,
      getMeasurements: async () => fullPage(rawMeasurement, found, isLowerBound),
    });

  const pullRaw = async () => {
    const ctx = ctxWith();
    const result = await getMeasurements.handler(
      getMeasurements.input.parse({ locationId: 931, parametersId: 2, aggregation: 'raw' }),
      ctx,
    );
    return { ctx, result };
  };

  it('flags the total as a floor when the cap stops a ">N" series, never below what it pulled', async () => {
    endlessSeries(1000, true);
    const { ctx, result } = await pullRaw();

    expect(result.pulledCount).toBe(5000);
    expect(result.pullComplete).toBe(false);
    expect(getEnrichment(ctx).totalCountIsLowerBound).toBe(true);
    // The floor never drops below the rows actually in hand.
    expect(getEnrichment(ctx).totalCount).toBe(5000);
    // A floor below the rows in hand names no total — the flag carries "more exist".
    expect(getEnrichment(ctx).notice).toMatch(/capped at 5000 rows — this series is not complete/);
    expect(getEnrichment(ctx).notice).not.toMatch(/of at least/);
  });

  it('names the upstream floor when it exceeds the rows pulled', async () => {
    endlessSeries(8000, true);
    const { ctx, result } = await pullRaw();

    expect(result.pulledCount).toBe(5000);
    expect(getEnrichment(ctx).totalCount).toBe(8000);
    expect(getEnrichment(ctx).totalCountIsLowerBound).toBe(true);
    expect(getEnrichment(ctx).notice).toMatch(/capped at 5000 rows of at least 8000/);
  });

  it('flags the total as a floor when a mid-pager page failure stops a ">N" series', async () => {
    installStubService({
      getLocation: async () => seattleLocation,
      getMeasurements: async (_sensorId, params) => {
        if (params.page >= 3)
          throw timeout('OpenAQ timed out serving the request.', { status: 408 });
        return fullPage(rawMeasurement, 1000, true);
      },
    });
    const { ctx, result } = await pullRaw();

    expect(result.pulledCount).toBe(2000);
    expect(result.pullComplete).toBe(false);
    expect(getEnrichment(ctx).totalCount).toBe(2000);
    expect(getEnrichment(ctx).totalCountIsLowerBound).toBe(true);
  });

  it('keeps an exact upstream total exact when a page failure stops the pull', async () => {
    installStubService({
      getLocation: async () => seattleLocation,
      getMeasurements: async (_sensorId, params) => {
        if (params.page >= 3)
          throw timeout('OpenAQ timed out serving the request.', { status: 408 });
        return fullPage(rawMeasurement, 9000);
      },
    });
    const { ctx, result } = await pullRaw();

    expect(result.pullComplete).toBe(false);
    expect(getEnrichment(ctx).totalCount).toBe(9000);
    expect(getEnrichment(ctx).totalCountIsLowerBound).toBeUndefined();
  });

  it('reports an exhausted pull as exact and complete, whatever meta.found said', async () => {
    installStubService({
      getLocation: async () => seattleLocation,
      getMeasurements: async () => ({
        results: Array.from({ length: 40 }, () => dailyMeasurement),
        found: 5,
        foundIsLowerBound: true,
      }),
    });
    const ctx = ctxWith();
    const result = await getMeasurements.handler(
      getMeasurements.input.parse({ locationId: 931, parametersId: 2, aggregation: 'daily' }),
      ctx,
    );

    expect(result.pullComplete).toBe(true);
    expect(result.pulledCount).toBe(40);
    expect(getEnrichment(ctx).totalCount).toBe(40);
    expect(getEnrichment(ctx).totalCountIsLowerBound).toBeUndefined();
  });

  it('never publishes a total below the rows pulled, or a complete pull beside a cap notice', async () => {
    for (const [found, isLowerBound] of [
      [0, false],
      [12_000, false],
      [1000, true],
    ] as const) {
      endlessSeries(found, isLowerBound);
      const { ctx, result } = await pullRaw();
      const enrichment = getEnrichment(ctx);

      expect(enrichment.totalCount as number).toBeGreaterThanOrEqual(result.pulledCount);
      expect(result.pullComplete).toBe(false);
      expect(enrichment.notice).toMatch(/capped at 5000 rows/);
      // "of 5000" beside "not complete" would contradict itself.
      expect(enrichment.notice).not.toMatch(/5000 rows of (at least )?5000/);
    }
  });

  it('renders the pulled count and pull completeness in content[] (#24 parity)', async () => {
    endlessSeries(1000, true);
    const { result } = await pullRaw();
    const text = formatText(result);

    expect(text).toContain('5000 pulled');
    expect(text).toContain('pull incomplete');
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
    expect(getEnrichment(ctx).notice).toMatch(/Narrow the range/);
  });

  it('tells an inline series on a supplied canvas to fix the provider, not to narrow the range', async () => {
    installStubService({
      getLocation: async () => seattleLocation,
      getMeasurements: async () => onePage(Array.from({ length: 12 }, () => dailyMeasurement)),
    });
    setCanvas({
      acquire: vi.fn(async () => ({
        canvasId: 'abc1234567',
        isNew: false,
        drop: vi.fn(async () => false),
        registerTable: vi.fn(async () => {
          throw new Error('duckdb instance closed');
        }),
      })),
    } as unknown as DataCanvas);

    const ctx = ctxWith();
    const result = await getMeasurements.handler(
      getMeasurements.input.parse({
        locationId: 931,
        parametersId: 2,
        aggregation: 'daily',
        canvas_id: 'abc1234567',
      }),
      ctx,
    );

    expect(result.truncated).toBeUndefined();
    expect(result.canvasId).toBeUndefined();
    expect(result.series).toHaveLength(12);
    const notice = getEnrichment(ctx).notice as string;
    expect(notice).toMatch(/Canvas abc1234567 could not be reused/);
    expect(notice).toMatch(/12-row series is inline here but staged nowhere/);
    expect(notice).toMatch(/Fix the canvas provider/);
    expect(notice).not.toMatch(/Narrow the range|truncated|capped/);
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

/**
 * A supplied `canvas_id` is a request to put this series on that canvas, and a
 * side-by-side comparison needs both series there whatever their sizes. Reading
 * the id only inside the overflow branch discarded it silently on a narrow range
 * and made the verdict on a bad id depend on the result size.
 */
describe('openaq_get_measurements honours a supplied canvas_id at any size (#35)', () => {
  /** 71 rows — comfortably inside the 100-row inline preview. */
  const narrowSeries = () =>
    installStubService({
      getLocation: async () => seattleLocation,
      getMeasurements: async () => onePage(Array.from({ length: 71 }, () => dailyMeasurement)),
    });

  const stagingCanvas = (dropped = false) => {
    const registerTable = vi.fn(async (name: string, rows: unknown[]) => ({
      tableName: name,
      rowCount: rows.length,
      columns: ['datetimeFrom', 'value'],
    }));
    const drop = vi.fn(async () => dropped);
    const acquire = vi.fn(async () => ({
      canvasId: 'abc1234567',
      isNew: !dropped,
      registerTable,
      drop,
    }));
    setCanvas({ acquire } as unknown as DataCanvas);
    return { acquire, drop, registerTable };
  };

  const callNarrow = async (canvas_id?: string) => {
    const ctx = ctxWith();
    const result = await getMeasurements.handler(
      getMeasurements.input.parse({
        locationId: 931,
        parametersId: 2,
        aggregation: 'daily',
        ...(canvas_id ? { canvas_id } : {}),
      }),
      ctx,
    );
    return { ctx, result };
  };

  it('stages a series that fits inline onto a valid supplied canvas, without marking it truncated', async () => {
    narrowSeries();
    const { acquire, registerTable } = stagingCanvas();
    const { result } = await callNarrow('abc1234567');

    expect(acquire).toHaveBeenCalledWith('abc1234567', expect.anything());
    expect(registerTable).toHaveBeenCalledWith(
      'measurements_1701',
      expect.any(Array),
      expect.anything(),
    );
    expect(result.canvasId).toBe('abc1234567');
    expect(result.tableName).toBe('measurements_1701');
    expect(result.truncated).toBeUndefined();
    expect(result.series).toHaveLength(71); // nothing withheld
  });

  it('raises canvas_not_found for an unresolvable id on a narrow range too', async () => {
    narrowSeries();
    setCanvas({
      acquire: vi.fn(async () => {
        throw notFound('Canvas not found.', { reason: 'canvas_not_found' });
      }),
    } as unknown as DataCanvas);

    await expect(callNarrow('goneCanvs1')).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'canvas_not_found', canvasId: 'goneCanvs1' },
    });
  });

  it('touches no canvas when canvas_id is omitted and the series fits inline', async () => {
    narrowSeries();
    const { acquire } = stagingCanvas();
    const { ctx, result } = await callNarrow();

    expect(acquire).not.toHaveBeenCalled();
    expect(result.canvasId).toBeUndefined();
    expect(result.truncated).toBeUndefined();
    expect(getEnrichment(ctx).notice).toBeUndefined();
  });

  it('names the canvas and table in content[] on a staged-but-not-truncated response', () => {
    const text = formatText({
      location: { id: 931, name: 'Seattle-10th & Weller' },
      parameter: { id: 2, name: 'pm25', unit: 'µg/m³', displayName: 'PM2.5' },
      sensorId: 1701,
      aggregation: 'daily',
      series: [],
      rowCount: 0,
      pulledCount: 71,
      pullComplete: true,
      canvasId: 'abc1234567',
      tableName: 'measurements_1701',
    });

    expect(text).toContain('abc1234567');
    expect(text).toContain('measurements_1701');
    expect(text).not.toContain('**Truncated**');
  });

  it('degrades with an accurate notice when a supplied id cannot be staged at all', async () => {
    narrowSeries();
    setCanvas(undefined);
    const { ctx, result } = await callNarrow('abc1234567');

    expect(result.canvasId).toBeUndefined();
    expect(result.truncated).toBeUndefined();
    expect(getEnrichment(ctx).notice).toMatch(/DataCanvas|CANVAS_PROVIDER_TYPE/);
    expect(getEnrichment(ctx).notice).toMatch(/Canvas abc1234567 could not be reused/);
    expect(getEnrichment(ctx).notice).not.toMatch(/truncated/i);
  });

  it('names the supplied id on the no-canvas overflow path too', async () => {
    installStubService({
      getLocation: async () => seattleLocation,
      getMeasurements: async () => onePage(Array.from({ length: 150 }, () => dailyMeasurement)),
    });
    setCanvas(undefined);
    const ctx = ctxWith();
    const result = await getMeasurements.handler(
      getMeasurements.input.parse({
        locationId: 931,
        parametersId: 2,
        aggregation: 'daily',
        canvas_id: 'abc1234567',
      }),
      ctx,
    );

    expect(result.truncated).toBe(true);
    expect(result.canvasId).toBeUndefined();
    const notice = getEnrichment(ctx).notice as string;
    expect(notice).toMatch(/Canvas abc1234567 could not be reused/);
    expect(notice).toMatch(/capped at 100 of 150 rows/);
    expect(notice).toMatch(/Rows 101–150 are not in this response/);
  });
});

/**
 * The response that mints a canvas handle is the only place an agent learns the
 * handle exists, so it has to name the tools that can read it — describe first,
 * because the staged table is flat (`min`, `sd`) while the response `series` is
 * nested (`summary.min`), and SQL written from the response shape misses.
 */
describe('openaq_get_measurements points at the dataframe tools when it stages (#32, #36)', () => {
  const series = (rows: number) =>
    installStubService({
      getLocation: async () => seattleLocation,
      getMeasurements: async () => onePage(Array.from({ length: rows }, () => dailyMeasurement)),
    });

  const canvasThatDropped = (dropped: boolean) => {
    const drop = vi.fn(async () => dropped);
    setCanvas({
      acquire: vi.fn(async () => ({
        canvasId: 'abc1234567',
        isNew: !dropped,
        drop,
        registerTable: vi.fn(async (name: string, rows: unknown[]) => ({
          tableName: name,
          rowCount: rows.length,
          columns: ['datetimeFrom', 'value'],
        })),
      })),
    } as unknown as DataCanvas);
    return drop;
  };

  const stage = async (rows: number, dropped: boolean) => {
    series(rows);
    canvasThatDropped(dropped);
    const ctx = ctxWith();
    const result = await getMeasurements.handler(
      getMeasurements.input.parse({ locationId: 931, parametersId: 2, aggregation: 'daily' }),
      ctx,
    );
    return { ctx, result, notice: getEnrichment(ctx).notice as string };
  };

  it('names the staged table, then describe, then query', async () => {
    const { notice } = await stage(150, false);

    expect(notice).toContain('measurements_1701');
    expect(notice.indexOf('measurements_1701')).toBeLessThan(
      notice.indexOf('openaq_dataframe_describe'),
    );
    expect(notice.indexOf('openaq_dataframe_describe')).toBeLessThan(
      notice.indexOf('openaq_dataframe_query'),
    );
  });

  it('does not claim truncation on a staged response that fits inline', async () => {
    series(71);
    canvasThatDropped(false);
    const ctx = ctxWith();
    const result = await getMeasurements.handler(
      getMeasurements.input.parse({
        locationId: 931,
        parametersId: 2,
        aggregation: 'daily',
        canvas_id: 'abc1234567',
      }),
      ctx,
    );

    expect(result.truncated).toBeUndefined();
    expect(getEnrichment(ctx).notice).toContain('openaq_dataframe_describe');
    expect(getEnrichment(ctx).notice).not.toMatch(/truncated/i);
  });

  it('names both dataframe tools in the content[] spill line', async () => {
    const { result } = await stage(150, false);
    const text = formatText(result);

    expect(text).toContain('openaq_dataframe_describe');
    expect(text).toContain('openaq_dataframe_query');
    expect(text.indexOf('openaq_dataframe_describe')).toBeLessThan(
      text.indexOf('openaq_dataframe_query'),
    );
  });

  it('names both dataframe tools in the canvasId and tableName descriptions', () => {
    const shape = getMeasurements.output.shape;
    for (const field of [shape.canvasId, shape.tableName]) {
      const described = field.description ?? '';
      expect(described).toContain('openaq_dataframe_describe');
      expect(described).toContain('openaq_dataframe_query');
    }
  });

  it('reports that an earlier series for this sensor was replaced (#36)', async () => {
    const { notice } = await stage(150, true);

    expect(notice).toMatch(/replaced/i);
    expect(notice).toContain('measurements_1701');
  });

  it('says nothing about replacement when the canvas held no table for this sensor (#36)', async () => {
    const { notice } = await stage(150, false);

    expect(notice).not.toMatch(/replaced/i);
  });

  it('carries the staging notice — replacement line included — into content[] (#32, #36)', async () => {
    series(150);
    canvasThatDropped(true);
    const result = await runToolContract(getMeasurements, {
      locationId: 931,
      parametersId: 2,
      aggregation: 'daily',
    });
    const text = result.content
      .map((block) => (block.type === 'text' ? block.text : ''))
      .join('\n');

    expect(result.isError).toBeFalsy();
    expect(text).toContain('openaq_dataframe_describe');
    expect(text).toContain('openaq_dataframe_query');
    expect(text).toMatch(/replaced/i);
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
    pulledCount: truncated ? rows * 10 : rows,
    pullComplete: true,
    ...(truncated
      ? { truncated: true, canvasId: 'abc1234567', tableName: 'measurements_3425' }
      : {}),
  });

  it('renders every row the response carries, so both surfaces see the same set', () => {
    const text = formatText(previewResult(100, true));
    const rendered = text.split('\n').filter((l) => l.startsWith('- ')).length;

    expect(rendered).toBe(100);
    expect(text).toContain('100 rows shown');
    expect(text).not.toContain('20 of 100 preview rows shown');
    expect(text).not.toContain('further rows');
    expect(text).not.toContain('preview rows shown');
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

describe('openaq_get_measurements id inputs must be positive (#33)', () => {
  /** Rejects any fetch, so a path that reaches the network without a stub fails loudly. */
  beforeEach(() => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('unmocked fetch in a unit test'));
  });

  const emitted = () =>
    z.toJSONSchema(getMeasurements.input, { io: 'input' }) as {
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
    ['locationId', { locationId: 0, parametersId: 2 }],
    ['locationId', { locationId: -1, parametersId: 2 }],
    ['parametersId', { locationId: 931, parametersId: 0 }],
    ['parametersId', { locationId: 931, parametersId: -1 }],
  ])('rejects a non-positive %s as invalid_arguments before any request', async (field, input) => {
    const getLocation = vi.fn(async () => seattleLocation);
    const getMeasurementsSpy = vi.fn(async () => onePage([dailyMeasurement]));
    installStubService({ getLocation, getMeasurements: getMeasurementsSpy });
    const result = await runToolContract(getMeasurements, input);
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: {
        code: JsonRpcErrorCode.InvalidParams,
        data: { reason: 'invalid_arguments', issues: [{ path: [field] }] },
      },
    });
    const text = result.content.map((b) => (b.type === 'text' ? b.text : '')).join('\n');
    expect(text).toContain(field);
    expect(getLocation).not.toHaveBeenCalled();
    expect(getMeasurementsSpy).not.toHaveBeenCalled();
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('still accepts the lowest real ids', () => {
    expect(getMeasurements.input.parse({ locationId: 1, parametersId: 1 })).toMatchObject({
      locationId: 1,
      parametersId: 1,
    });
  });
});
