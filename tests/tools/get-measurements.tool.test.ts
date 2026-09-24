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
import type { MeasurementsPage, MeasurementsParams } from '@/services/openaq/openaq-service.js';
import { setOpenAqService } from '@/services/openaq/openaq-service.js';
import type { OpenAqMeasurement } from '@/services/openaq/types.js';
import {
  dailyMeasurement,
  dstBoundaries,
  gapBucketHourly,
  impreciseDaily,
  makeBucket,
  rawMeasurement,
  seattleLocation,
  singleReadingHourly,
  sparseLocation,
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

/** Provenance fields every `location` output carries, for hand-built `format()` inputs. */
const stationMeta = { provider: 'AirNow', providerId: 119, timezone: 'America/Los_Angeles' };

/** The text of the single block `format()` returns. */
const formatText = (result: Parameters<NonNullable<typeof getMeasurements.format>>[0]): string =>
  (getMeasurements.format!(result)[0] as { text: string }).text;

/** Every OpenAQ call goes through a stub; a path that reaches the network fails loudly. */
beforeEach(() => {
  vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('unmocked fetch in a unit test'));
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
      location: { id: 931, name: 'Seattle', ...stationMeta },
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
      location: { id: 1938, name: 'Seattle-Beacon Hill', ...stationMeta },
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

  it('accepts a same-day range given as timestamp → date, expanding the date to the end of the station-local day', async () => {
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
    // The explicit timestamp passes through; the date closes at the next local
    // midnight in America/Los_Angeles (PDT, UTC-7).
    expect(seen).toEqual({
      datetimeFrom: '2026-06-25T00:00:00Z',
      datetimeTo: '2026-06-26T07:00:00Z',
    });
  });

  it('accepts a same-day date-only range as a full station-local day', async () => {
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
      datetimeFrom: '2026-06-25T07:00:00Z',
      datetimeTo: '2026-06-26T07:00:00Z',
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
        // The date opens at local midnight (07:00Z), already past the timestamp.
        datetimeFrom: '2026-06-25T07:00:00Z',
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
      location: { id: 931, name: 'Seattle-10th & Weller', ...stationMeta },
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
    location: { id: 1938, name: 'Seattle-Beacon Hill', ...stationMeta },
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

/** The text of every text block on a wire result, joined. */
const wireText = (result: Awaited<ReturnType<typeof runToolContract>>): string =>
  result.content.map((block) => (block.type === 'text' ? block.text : '')).join('\n');

/** `structuredContent` of a wire result, loosely typed for field assertions. */
const structured = (result: Awaited<ReturnType<typeof runToolContract>>) =>
  result.structuredContent as Record<string, unknown> & {
    effectiveRange?: { datetimeFrom: string | null; datetimeTo: string | null };
    gapCount?: number;
    gaps?: { datetimeFrom: string; datetimeTo: string }[];
    location: Record<string, unknown>;
    notice?: string;
  };

/** Buckets from `[datetimeFrom, datetimeTo]` UTC pairs. */
const bucketsFrom = (
  pairs: readonly (readonly [string, string])[],
  opts?: Parameters<typeof makeBucket>[2],
): OpenAqMeasurement[] => pairs.map(([from, to]) => makeBucket(from, to, opts));

/** Hourly buckets for each UTC start hour given as `YYYY-MM-DDTHH`. */
const hourlyAt = (starts: string[]): OpenAqMeasurement[] =>
  starts.map((s) => {
    const from = `${s}:00:00Z`;
    const to = new Date(Date.parse(from) + 3_600_000).toISOString().replace('.000Z', 'Z');
    return makeBucket(from, to);
  });

/**
 * Serves `rows` as one page and records every measurements request, so a test can
 * assert the bounds forwarded upstream and how many requests went out.
 */
const serveRows = (rows: OpenAqMeasurement[], location = seattleLocation) => {
  const calls: MeasurementsParams[] = [];
  const getLocation = vi.fn(async () => location);
  installStubService({
    getLocation,
    getMeasurements: async (_sensorId, params) => {
      calls.push(params);
      return onePage(rows);
    },
  });
  return { calls, getLocation };
};

describe('openaq_get_measurements location provenance (#30)', () => {
  it('keeps the station id and name, falling back to "location <id>" for an unnamed station', async () => {
    serveRows([dailyMeasurement]);
    const named = await getMeasurements.handler(
      getMeasurements.input.parse({ locationId: 931, parametersId: 2, aggregation: 'daily' }),
      ctxWith(),
    );
    expect(named.location).toMatchObject({ id: 931, name: 'Seattle-10th & Weller' });

    serveRows([dailyMeasurement], sparseLocation);
    const unnamed = await getMeasurements.handler(
      getMeasurements.input.parse({ locationId: 42, parametersId: 2, aggregation: 'daily' }),
      ctxWith(),
    );
    expect(unnamed.location).toMatchObject({ id: 42, name: 'location 42' });
  });

  it('returns provider, providerId, and timezone on both surfaces', async () => {
    serveRows([dailyMeasurement]);
    const result = await runToolContract(getMeasurements, {
      locationId: 931,
      parametersId: 2,
      aggregation: 'daily',
    });

    expect(result.isError).toBeFalsy();
    expect(structured(result).location).toEqual({
      id: 931,
      name: 'Seattle-10th & Weller',
      provider: 'AirNow',
      providerId: 119,
      timezone: 'America/Los_Angeles',
    });
    const text = wireText(result);
    expect(text).toContain('AirNow');
    expect(text).toContain('119');
    expect(text).toContain('America/Los_Angeles');
  });

  it('yields null provider, providerId, and timezone when OpenAQ lists none — never "Unknown"', async () => {
    serveRows([dailyMeasurement], { ...seattleLocation, provider: null, timezone: null });
    const result = await runToolContract(getMeasurements, {
      locationId: 931,
      parametersId: 2,
      aggregation: 'daily',
    });

    expect(result.isError).toBeFalsy();
    expect(structured(result).location).toMatchObject({
      provider: null,
      providerId: null,
      timezone: null,
    });
    const text = wireText(result);
    expect(text).not.toMatch(/unknown/i);
    expect(text).not.toContain('null');
  });

  it('adds no upstream request: one location lookup plus one per page', async () => {
    const { calls, getLocation } = serveRows([dailyMeasurement]);
    await runToolContract(getMeasurements, {
      locationId: 931,
      parametersId: 2,
      aggregation: 'daily',
      datetimeFrom: '2026-05-01',
      datetimeTo: '2026-05-01',
    });

    expect(getLocation).toHaveBeenCalledTimes(1);
    expect(calls).toHaveLength(1);
  });
});

describe('openaq_get_measurements date-only bounds are station-local days (#29)', () => {
  it('reads a same-day daily range as exactly one local day and echoes the bounds sent', async () => {
    const { calls } = serveRows(
      bucketsFrom([['2026-08-01T07:00:00Z', '2026-08-02T07:00:00Z']], { label: '1 day' }),
    );
    const result = await runToolContract(getMeasurements, {
      locationId: 931,
      parametersId: 2,
      aggregation: 'daily',
      datetimeFrom: '2026-08-01',
      datetimeTo: '2026-08-01',
    });

    expect(calls[0]).toMatchObject({
      datetimeFrom: '2026-08-01T07:00:00Z',
      datetimeTo: '2026-08-02T07:00:00Z',
    });
    const sc = structured(result);
    expect(sc.effectiveRange).toEqual({
      datetimeFrom: '2026-08-01T07:00:00Z',
      datetimeTo: '2026-08-02T07:00:00Z',
    });
    expect(sc.gapCount).toBe(0);
    expect(sc).not.toHaveProperty('gaps');
    expect(sc).not.toHaveProperty('notice');
    expect(wireText(result)).toMatch(
      /Range sent to OpenAQ:\*\* 2026-08-01T07:00:00Z → 2026-08-02T07:00:00Z/,
    );
  });

  it('closes a date-only raw day at the next local midnight, so the last hour is kept', async () => {
    const rows = hourlyAt(
      Array.from({ length: 24 }, (_, h) =>
        new Date(Date.parse('2026-08-03T07:00:00Z') + h * 3_600_000).toISOString().slice(0, 13),
      ),
    );
    const { calls } = serveRows(rows);
    const result = await runToolContract(getMeasurements, {
      locationId: 931,
      parametersId: 2,
      aggregation: 'raw',
      datetimeFrom: '2026-08-03',
      datetimeTo: '2026-08-03',
    });

    expect(calls[0]).toMatchObject({
      datetimeFrom: '2026-08-03T07:00:00Z',
      datetimeTo: '2026-08-04T07:00:00Z',
    });
    const sc = structured(result);
    expect(sc.rowCount).toBe(24);
    expect((sc.series as { datetimeTo: string }[]).at(-1)?.datetimeTo).toBe('2026-08-04T07:00:00Z');
  });

  it('passes explicit timestamps through unchanged', async () => {
    const { calls } = serveRows(hourlyAt(['2026-08-08T07']));
    await runToolContract(getMeasurements, {
      locationId: 931,
      parametersId: 2,
      aggregation: 'hourly',
      datetimeFrom: '2026-08-08T07:00:00Z',
      datetimeTo: '2026-08-10T07:00:00Z',
    });
    expect(calls[0]).toMatchObject({
      datetimeFrom: '2026-08-08T07:00:00Z',
      datetimeTo: '2026-08-10T07:00:00Z',
    });
  });

  it('echoes an omitted bound as null', async () => {
    const { calls } = serveRows([dailyMeasurement]);
    const result = await runToolContract(getMeasurements, {
      locationId: 931,
      parametersId: 2,
      aggregation: 'daily',
      datetimeFrom: '2026-05-01',
    });
    expect(calls[0]).not.toHaveProperty('datetimeTo');
    expect(structured(result).effectiveRange).toEqual({
      datetimeFrom: '2026-05-01T07:00:00Z',
      datetimeTo: null,
    });
  });

  /**
   * Each case is a local calendar day and the UTC instants that open and close it.
   * Southern-hemisphere, half-hour, and midnight-transition zones are here because
   * a fixed-offset or single-lookup conversion gets them wrong. The conversion reads
   * only the station zone, so the expectations hold under any process TZ.
   */
  it.each([
    ['America/Los_Angeles', '2026-08-01', '2026-08-01T07:00:00Z', '2026-08-02T07:00:00Z'],
    // Fall back: 25-hour day. Spring forward: 23-hour day.
    ['America/Los_Angeles', '2025-11-02', '2025-11-02T07:00:00Z', '2025-11-03T08:00:00Z'],
    ['America/Los_Angeles', '2026-03-08', '2026-03-08T08:00:00Z', '2026-03-09T07:00:00Z'],
    ['Europe/Berlin', '2026-03-29', '2026-03-28T23:00:00Z', '2026-03-29T22:00:00Z'],
    ['Europe/Berlin', '2025-10-26', '2025-10-25T22:00:00Z', '2025-10-26T23:00:00Z'],
    ['Asia/Kolkata', '2026-08-01', '2026-07-31T18:30:00Z', '2026-08-01T18:30:00Z'],
    ['Australia/Sydney', '2026-04-05', '2026-04-04T13:00:00Z', '2026-04-05T14:00:00Z'],
    // Chile moves its clocks at midnight: on 2026-09-06 local midnight never
    // happens (the day opens at 01:00), and on 2026-04-05 23:00 repeats first.
    ['America/Santiago', '2026-09-06', '2026-09-06T04:00:00Z', '2026-09-07T03:00:00Z'],
    ['America/Santiago', '2026-04-05', '2026-04-05T04:00:00Z', '2026-04-06T04:00:00Z'],
  ])('opens and closes %s day %s at local midnight', async (timezone, day, from, to) => {
    const { calls } = serveRows([dailyMeasurement], { ...seattleLocation, timezone });
    await runToolContract(getMeasurements, {
      locationId: 931,
      parametersId: 2,
      aggregation: 'daily',
      datetimeFrom: day,
      datetimeTo: day,
    });
    expect(calls[0]).toMatchObject({ datetimeFrom: from, datetimeTo: to });
  });

  it('falls back to UTC days with a notice when the station has no timezone', async () => {
    const { calls } = serveRows([dailyMeasurement], sparseLocation);
    const result = await runToolContract(getMeasurements, {
      locationId: 42,
      parametersId: 2,
      aggregation: 'daily',
      datetimeFrom: '2026-08-01',
      datetimeTo: '2026-08-01',
    });

    expect(calls[0]).toMatchObject({
      datetimeFrom: '2026-08-01T00:00:00Z',
      datetimeTo: '2026-08-02T00:00:00Z',
    });
    const sc = structured(result);
    expect(sc.location).toMatchObject({ timezone: null });
    expect(sc.notice).toMatch(/no timezone for station 42.*UTC days/s);
    expect(wireText(result)).toMatch(/no timezone for station 42/);
  });

  it('falls back the same way on a timezone the runtime does not recognize, naming it', async () => {
    const { calls } = serveRows([dailyMeasurement], {
      ...seattleLocation,
      timezone: 'Mars/Olympus_Mons',
    });
    const result = await runToolContract(getMeasurements, {
      locationId: 931,
      parametersId: 2,
      aggregation: 'daily',
      datetimeFrom: '2026-08-01',
      datetimeTo: '2026-08-01',
    });

    expect(result.isError).toBeFalsy();
    expect(calls[0]).toMatchObject({
      datetimeFrom: '2026-08-01T00:00:00Z',
      datetimeTo: '2026-08-02T00:00:00Z',
    });
    expect(structured(result).notice).toMatch(/Mars\/Olympus_Mons.*UTC days/s);
  });

  it('says nothing about the timezone when no bound is date-only', async () => {
    serveRows([dailyMeasurement], sparseLocation);
    const result = await runToolContract(getMeasurements, {
      locationId: 42,
      parametersId: 2,
      aggregation: 'daily',
      datetimeFrom: '2026-05-01T07:00:00Z',
      datetimeTo: '2026-05-02T07:00:00Z',
    });
    expect(structured(result).notice ?? '').not.toMatch(/timezone/);
  });

  it('still rejects an inverted mixed pair before any measurements request', async () => {
    const getMeasurementsSpy = vi.fn(async () => onePage([dailyMeasurement]));
    installStubService({
      getLocation: async () => seattleLocation,
      getMeasurements: getMeasurementsSpy,
    });
    const result = await runToolContract(getMeasurements, {
      locationId: 931,
      parametersId: 2,
      datetimeFrom: '2026-06-25',
      datetimeTo: '2026-06-25T06:59:59Z',
    });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: { data: { reason: 'invalid_date_range' } },
    });
    expect(getMeasurementsSpy).not.toHaveBeenCalled();
  });

  it('rejects an inverted same-form pair with no request at all', async () => {
    const getLocation = vi.fn(async () => seattleLocation);
    const getMeasurementsSpy = vi.fn(async () => onePage([dailyMeasurement]));
    installStubService({ getLocation, getMeasurements: getMeasurementsSpy });
    for (const [datetimeFrom, datetimeTo] of [
      ['2026-06-02', '2026-06-01'],
      ['2026-06-01T07:00:00Z', '2026-06-01T07:00:00Z'],
    ]) {
      const result = await runToolContract(getMeasurements, {
        locationId: 931,
        parametersId: 2,
        datetimeFrom,
        datetimeTo,
      });
      expect(result.structuredContent).toMatchObject({
        error: { data: { reason: 'invalid_date_range' } },
      });
    }
    expect(getLocation).not.toHaveBeenCalled();
    expect(getMeasurementsSpy).not.toHaveBeenCalled();
  });

  it('names the station timezone on daily output', async () => {
    serveRows([dailyMeasurement]);
    const result = await runToolContract(getMeasurements, {
      locationId: 931,
      parametersId: 2,
      aggregation: 'daily',
    });
    expect(wireText(result)).toMatch(/local calendar days in America\/Los_Angeles/);
  });
});

describe('openaq_get_measurements clipped edge buckets (#29)', () => {
  it('flags a first bucket that opens before an explicit datetimeFrom', async () => {
    serveRows(
      bucketsFrom(
        [
          ['2026-07-31T07:00:00Z', '2026-08-01T07:00:00Z'],
          ['2026-08-01T07:00:00Z', '2026-08-02T07:00:00Z'],
        ],
        { label: '1 day' },
      ),
    );
    const result = await runToolContract(getMeasurements, {
      locationId: 931,
      parametersId: 2,
      aggregation: 'daily',
      datetimeFrom: '2026-08-01T00:00:00Z',
      datetimeTo: '2026-08-01',
    });

    const sc = structured(result);
    expect(sc.notice).toMatch(
      /first bucket \(2026-07-31T07:00:00Z → 2026-08-01T07:00:00Z\) starts before datetimeFrom/,
    );
    expect(sc.notice).toMatch(/only the hours inside the range/);
    expect(sc.notice).not.toMatch(/last bucket/);
    expect(wireText(result)).toMatch(/starts before datetimeFrom/);
  });

  it('flags a last bucket that closes after an explicit datetimeTo', async () => {
    serveRows(bucketsFrom([['2026-08-01T07:00:00Z', '2026-08-02T07:00:00Z']], { label: '1 day' }));
    const result = await runToolContract(getMeasurements, {
      locationId: 931,
      parametersId: 2,
      aggregation: 'daily',
      datetimeFrom: '2026-08-01',
      datetimeTo: '2026-08-01T23:59:59Z',
    });
    const notice = structured(result).notice as string;
    expect(notice).toMatch(
      /last bucket \(2026-08-01T07:00:00Z → 2026-08-02T07:00:00Z\) ends after datetimeTo/,
    );
    expect(notice).not.toMatch(/first bucket/);
  });

  it('never flags raw rows', async () => {
    serveRows(hourlyAt(['2026-07-31T23', '2026-08-01T00']));
    const result = await runToolContract(getMeasurements, {
      locationId: 931,
      parametersId: 2,
      aggregation: 'raw',
      datetimeFrom: '2026-08-01T00:00:00Z',
      datetimeTo: '2026-08-01T00:30:00Z',
    });
    expect(structured(result).notice ?? '').not.toMatch(/bucket/);
  });
});

describe('openaq_get_measurements missing intervals (#29)', () => {
  const run = async (
    rows: OpenAqMeasurement[],
    aggregation: 'raw' | 'hourly' | 'daily',
    range: { datetimeFrom?: string; datetimeTo?: string } = {},
  ) => {
    serveRows(rows);
    const result = await runToolContract(getMeasurements, {
      locationId: 931,
      parametersId: 2,
      aggregation,
      ...range,
    });
    expect(result.isError).toBeFalsy();
    return { result, sc: structured(result), text: wireText(result) };
  };

  it('reports the missing local day in a ten-day daily range on both surfaces', async () => {
    const days = [1, 2, 3, 4, 5, 6, 7, 8, 10].map((d) => {
      const from = `2026-08-${String(d).padStart(2, '0')}T07:00:00Z`;
      const to = new Date(Date.parse(from) + 86_400_000).toISOString().replace('.000Z', 'Z');
      return [from, to] as const;
    });
    const { sc, text } = await run(bucketsFrom(days, { label: '1 day' }), 'daily', {
      datetimeFrom: '2026-08-01',
      datetimeTo: '2026-08-10',
    });

    expect(sc.rowCount).toBe(9);
    expect(sc.effectiveRange).toEqual({
      datetimeFrom: '2026-08-01T07:00:00Z',
      datetimeTo: '2026-08-11T07:00:00Z',
    });
    expect(sc.gapCount).toBe(1);
    expect(sc.gaps).toEqual([
      { datetimeFrom: '2026-08-09T07:00:00Z', datetimeTo: '2026-08-10T07:00:00Z' },
    ]);
    expect(sc.notice).toMatch(/1 missing interval.*2026-08-09T07:00:00Z → 2026-08-10T07:00:00Z/s);
    expect(text).toMatch(/1 missing interval/);
    expect(text).toMatch(/- 2026-08-09T07:00:00Z → 2026-08-10T07:00:00Z/);
  });

  it('counts both skipped spans in an hourly window and ignores the uncovered tail', async () => {
    const starts = [
      ...[7, 8, 9, 10, 11, 12, 13, 14].map((h) => `2026-08-08T${String(h).padStart(2, '0')}`),
      ...[20, 21, 22, 23].map((h) => `2026-08-08T${h}`),
      ...[0, 1, 2, 4, 5].map((h) => `2026-08-09T0${h}`),
    ];
    const { sc } = await run(hourlyAt(starts), 'hourly', {
      datetimeFrom: '2026-08-08T07:00:00Z',
      datetimeTo: '2026-08-10T07:00:00Z',
    });

    expect(sc.rowCount).toBe(17);
    expect(sc.gapCount).toBe(2);
    expect(sc.gaps).toEqual([
      { datetimeFrom: '2026-08-08T15:00:00Z', datetimeTo: '2026-08-08T20:00:00Z' },
      { datetimeFrom: '2026-08-09T03:00:00Z', datetimeTo: '2026-08-09T04:00:00Z' },
    ]);
  });

  it.each([
    ['daily fall-back (25-hour day)', 'daily', dstBoundaries.dailyFallBack],
    ['hourly fall-back (2-hour bucket)', 'hourly', dstBoundaries.hourlyFallBack],
    ['hourly spring-forward', 'hourly', dstBoundaries.hourlySpringForward],
    [
      'daily spring-forward (overlapping buckets)',
      'daily',
      dstBoundaries.dailySpringForwardOverlap,
    ],
  ] as const)('finds no gap across a DST %s', async (_label, aggregation, pairs) => {
    const { sc } = await run(bucketsFrom(pairs), aggregation);
    expect(sc.gapCount).toBe(0);
    expect(sc).not.toHaveProperty('gaps');
  });

  it('forwards the DST fall-back daily range as the 72 local hours it names', async () => {
    const { calls } = serveRows(bucketsFrom(dstBoundaries.dailyFallBack, { label: '1 day' }));
    const result = await runToolContract(getMeasurements, {
      locationId: 931,
      parametersId: 2,
      aggregation: 'daily',
      datetimeFrom: '2025-11-01',
      datetimeTo: '2025-11-03',
    });
    expect(calls[0]).toMatchObject({
      datetimeFrom: '2025-11-01T07:00:00Z',
      datetimeTo: '2025-11-04T08:00:00Z',
    });
    const sc = structured(result);
    expect(sc.gapCount).toBe(0);
    // The 25-hour bucket sits inside the local-day bounds, so nothing is clipped.
    expect(sc).not.toHaveProperty('notice');
  });

  it('treats an overlap as covered in whatever order OpenAQ returns the rows', async () => {
    const { sc } = await run(
      bucketsFrom([
        ['2026-03-08T08:00:00Z', '2026-03-09T07:00:00Z'],
        ['2026-03-07T08:00:00Z', '2026-03-09T07:00:00Z'],
      ]),
      'daily',
    );
    expect(sc.gapCount).toBe(0);
  });

  it('counts a null-value bucket between two populated ones as one gap', async () => {
    const { sc } = await run(
      [
        makeBucket('2026-08-08T07:00:00Z', '2026-08-08T08:00:00Z'),
        makeBucket('2026-08-08T08:00:00Z', '2026-08-08T09:00:00Z', { value: null }),
        makeBucket('2026-08-08T09:00:00Z', '2026-08-08T10:00:00Z'),
      ],
      'hourly',
    );
    expect(sc.gapCount).toBe(1);
    expect(sc.gaps).toEqual([
      { datetimeFrom: '2026-08-08T08:00:00Z', datetimeTo: '2026-08-08T09:00:00Z' },
    ]);
  });

  it('merges a skipped hour and an adjacent null bucket into one span', async () => {
    const { sc } = await run(
      [
        makeBucket('2026-08-08T07:00:00Z', '2026-08-08T08:00:00Z'),
        makeBucket('2026-08-08T09:00:00Z', '2026-08-08T10:00:00Z', { value: null }),
        makeBucket('2026-08-08T10:00:00Z', '2026-08-08T11:00:00Z', { value: null }),
        makeBucket('2026-08-08T11:00:00Z', '2026-08-08T12:00:00Z'),
      ],
      'hourly',
    );
    expect(sc.gapCount).toBe(1);
    expect(sc.gaps).toEqual([
      { datetimeFrom: '2026-08-08T08:00:00Z', datetimeTo: '2026-08-08T11:00:00Z' },
    ]);
  });

  it('keeps gapCount exact past the 20 listed spans', async () => {
    // Every other hour present: 31 buckets, 30 one-hour gaps.
    const starts = Array.from({ length: 31 }, (_, i) =>
      new Date(Date.parse('2026-08-01T00:00:00Z') + i * 2 * 3_600_000).toISOString().slice(0, 13),
    );
    const { sc, text } = await run(hourlyAt(starts), 'hourly');

    expect(sc.gapCount).toBe(30);
    expect(sc.gaps).toHaveLength(20);
    expect(sc.gaps?.[0]).toEqual({
      datetimeFrom: '2026-08-01T01:00:00Z',
      datetimeTo: '2026-08-01T02:00:00Z',
    });
    expect(sc.notice).toMatch(/30 missing intervals/);
    expect(text).toMatch(/first 20 of 30/);
  });

  it('finds gaps in every pulled row, not only the inline preview', async () => {
    // 150 every-other-hour buckets: the preview holds 100, the gaps run to row 150.
    const starts = Array.from({ length: 150 }, (_, i) =>
      new Date(Date.parse('2026-06-01T00:00:00Z') + i * 2 * 3_600_000).toISOString().slice(0, 13),
    );
    const { sc } = await run(hourlyAt(starts), 'hourly');

    expect(sc.truncated).toBe(true);
    expect(sc.rowCount).toBe(100);
    expect(sc.gapCount).toBe(149);
    expect(sc.notice).toMatch(/149 missing intervals/);
    expect(sc.notice).toMatch(/DataCanvas is not enabled/);
  });

  it('sets gapCount 0 on a contiguous hourly series', async () => {
    const { sc, text } = await run(hourlyAt(['2026-08-08T07', '2026-08-08T08']), 'hourly');
    expect(sc.gapCount).toBe(0);
    expect(sc).not.toHaveProperty('gaps');
    expect(text).toMatch(/Missing intervals:\*\* 0/);
  });

  it('carries no gapCount or gaps on raw responses, however spaced the rows', async () => {
    const { sc } = await run(hourlyAt(['2026-08-08T07', '2026-08-08T12']), 'raw');
    expect(sc).not.toHaveProperty('gapCount');
    expect(sc).not.toHaveProperty('gaps');
  });
});

/**
 * `ctx.enrich.notice` is last-wins, so every segment this tool can emit is
 * composed into one string. Walk the canvas × preview × canvas_id × gap matrix
 * and check that no arm contradicts another and none is dropped.
 */
describe('openaq_get_measurements notice composition across branches (#29)', () => {
  const rowsFor = (overflow: boolean, gap: boolean) => {
    const n = overflow ? 150 : 12;
    const step = gap ? 2 : 1;
    return hourlyAt(
      Array.from({ length: n }, (_, i) =>
        new Date(Date.parse('2026-06-01T00:00:00Z') + i * step * 3_600_000)
          .toISOString()
          .slice(0, 13),
      ),
    );
  };

  const stagingCanvas = () =>
    setCanvas({
      acquire: vi.fn(async (id?: string) => ({
        canvasId: id ?? 'abc1234567',
        isNew: id === undefined,
        drop: vi.fn(async () => false),
        registerTable: vi.fn(async (name: string, rows: unknown[]) => ({
          tableName: name,
          rowCount: rows.length,
          columns: ['datetimeFrom', 'value'],
        })),
      })),
    } as unknown as DataCanvas);

  const cases = [false, true].flatMap((canvasOn) =>
    [false, true].flatMap((overflow) =>
      [false, true].flatMap((canvasId) =>
        [false, true].map((gap) => ({ canvasOn, overflow, canvasId, gap })),
      ),
    ),
  );

  it.each(cases)(
    'composes one coherent notice: %o',
    async ({ canvasOn, overflow, canvasId, gap }) => {
      serveRows(rowsFor(overflow, gap));
      setCanvas(undefined);
      if (canvasOn) stagingCanvas();
      const result = await runToolContract(getMeasurements, {
        locationId: 931,
        parametersId: 2,
        aggregation: 'hourly',
        datetimeFrom: '2026-06-01T00:00:00Z',
        ...(canvasId ? { canvas_id: 'abc1234567' } : {}),
      });

      expect(result.isError).toBeFalsy();
      const sc = structured(result);
      const notice = sc.notice ?? '';
      const staged = canvasOn && (overflow || canvasId);

      // The gap sentence appears exactly when gaps exist, once.
      expect((notice.match(/missing interval/g) ?? []).length).toBe(gap ? 1 : 0);
      expect(sc.gapCount).toBe(gap ? (overflow ? 149 : 11) : 0);
      // Staging and not-staging never both appear.
      expect(/staged on this canvas/.test(notice)).toBe(staged);
      expect(/not enabled|could not stage/.test(notice)).toBe(!canvasOn && (overflow || canvasId));
      // An inline series is never described as capped; an overflow without a canvas always is.
      if (!overflow) expect(notice).not.toMatch(/capped at 100|Rows 101/);
      if (overflow && !canvasOn) expect(notice).toMatch(/capped at 100 of 150 rows/);
      // A named canvas is accounted for whenever it was not used.
      if (canvasId && !canvasOn) expect(notice).toMatch(/Canvas abc1234567 could not be reused/);
      // The pull finished, so nothing may call it incomplete.
      expect(notice).not.toMatch(/not complete|partial/);
      // No arm, no notice.
      if (!gap && !staged && !(canvasId || overflow)) expect(sc).not.toHaveProperty('notice');
      // Whatever the notice says, content[] says too.
      if (notice) expect(wireText(result)).toContain(notice);
    },
  );

  it('keeps every segment when all five fire at once, each once and in reading order', async () => {
    // A station with no timezone, a first bucket straddling the UTC-day bound, an
    // every-other-hour series (gaps), 6000 rows (the cap), and a working canvas.
    const straddling = makeBucket('2026-05-31T23:00:00Z', '2026-06-01T01:00:00Z');
    const series = [
      straddling,
      ...hourlyAt(
        Array.from({ length: 5999 }, (_, i) =>
          new Date(Date.parse('2026-06-01T02:00:00Z') + i * 2 * 3_600_000)
            .toISOString()
            .slice(0, 13),
        ),
      ),
    ];
    installStubService({
      getLocation: async () => ({ ...sparseLocation, name: 'No-zone station' }),
      getMeasurements: async (_sensorId, params) => ({
        results: series.slice((params.page - 1) * params.limit, params.page * params.limit),
        found: series.length,
        foundIsLowerBound: false,
      }),
    });
    stagingCanvas();
    const result = await runToolContract(getMeasurements, {
      locationId: 42,
      parametersId: 2,
      aggregation: 'hourly',
      datetimeFrom: '2026-06-01',
    });

    expect(result.isError).toBeFalsy();
    const notice = structured(result).notice as string;
    const segments = [
      /no timezone for station 42/g,
      /Pull capped at 5000 rows of 6000/g,
      /first bucket \(2026-05-31T23:00:00Z → 2026-06-01T01:00:00Z\) starts before datetimeFrom/g,
      /4999 missing intervals/g,
      /staged on this canvas as table measurements_7000 \(5000 rows\)/g,
    ];
    const positions = segments.map((re) => {
      const hits = [...notice.matchAll(re)];
      expect(hits, `segment ${re}`).toHaveLength(1);
      return hits[0]?.index ?? -1;
    });
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    expect(wireText(result)).toContain(notice);
  });
});

/**
 * The pager appends whole pages, so a `limit` that does not divide the ceiling
 * used to overshoot it while the cap notice named the ceiling.
 */
describe('openaq_get_measurements pull stops at exactly the row ceiling (#38)', () => {
  /**
   * Serves a series of `total` rows page by page. `raw` mimics the raw endpoint's
   * `meta.found` (`">limit"` on a full page, the page's own count on a short one);
   * otherwise `found` is the exact series total, as the hourly/daily rollups report it.
   */
  const pagedSeries = (total: number, shape: 'raw' | 'rollup') => {
    const pages: number[] = [];
    installStubService({
      getLocation: async () => seattleLocation,
      getMeasurements: async (_sensorId, params) => {
        pages.push(params.page);
        const start = (params.page - 1) * params.limit;
        const n = Math.max(0, Math.min(params.limit, total - start));
        const full = n === params.limit;
        return {
          results: Array.from({ length: n }, () => rawMeasurement),
          found: shape === 'raw' ? n : total,
          foundIsLowerBound: shape === 'raw' && full,
        };
      },
    });
    return pages;
  };

  const staged = () => {
    const registerTable = vi.fn(async (name: string, rows: unknown[]) => ({
      tableName: name,
      rowCount: rows.length,
      columns: ['datetimeFrom', 'value'],
    }));
    setCanvas({
      acquire: vi.fn(async () => ({
        canvasId: 'abc1234567',
        isNew: true,
        drop: vi.fn(async () => false),
        registerTable,
      })),
    } as unknown as DataCanvas);
    return registerTable;
  };

  const pull = async (limit: number, aggregation: 'raw' | 'hourly' = 'raw') => {
    const ctx = ctxWith();
    const result = await getMeasurements.handler(
      getMeasurements.input.parse({ locationId: 931, parametersId: 2, aggregation, limit }),
      ctx,
    );
    return {
      result,
      enrichment: getEnrichment(ctx),
      notice: (getEnrichment(ctx).notice ?? '') as string,
    };
  };

  it('slices a non-divisor limit back to 5000 rows everywhere, keeping the dropped rows in the floor', async () => {
    const pages = pagedSeries(20_000, 'raw');
    const registerTable = staged();
    const { result, enrichment, notice } = await pull(300);

    expect(pages).toHaveLength(17);
    expect(result.pulledCount).toBe(5000);
    expect(registerTable.mock.calls[0]?.[1]).toHaveLength(5000);
    expect(result.pullComplete).toBe(false);
    expect(enrichment.totalCount).toBe(5100);
    expect(enrichment.totalCountIsLowerBound).toBe(true);
    expect(notice).toMatch(/Pull capped at 5000 rows of at least 5100/);
    expect(notice).toMatch(/\(5000 rows\)/);
    expect(notice).not.toMatch(/5100 rows\)/);
  });

  it('reports an exact total when the page that crosses the ceiling is the last one', async () => {
    const pages = pagedSeries(16 * 300 + 250, 'raw');
    const { result, enrichment, notice } = await pull(300);

    expect(pages).toHaveLength(17);
    expect(result.pulledCount).toBe(5000);
    expect(result.pullComplete).toBe(false);
    expect(enrichment.totalCount).toBe(5050);
    expect(enrichment.totalCountIsLowerBound).toBeUndefined();
    expect(notice).toMatch(/capped at 5000 rows of 5050/);
  });

  it('calls a rollup series of exactly 5000 rows complete when OpenAQ reports that exact total', async () => {
    const pages = pagedSeries(5000, 'rollup');
    const { result, enrichment, notice } = await pull(1000, 'hourly');

    expect(pages).toHaveLength(5); // no extra request to prove the end
    expect(result.pulledCount).toBe(5000);
    expect(result.pullComplete).toBe(true);
    expect(enrichment.totalCount).toBe(5000);
    expect(enrichment.totalCountIsLowerBound).toBeUndefined();
    expect(notice).not.toMatch(/capped at 5000|not complete/);
  });

  it('does not call a rollup series partial when a page past its exact total fails', async () => {
    installStubService({
      getLocation: async () => seattleLocation,
      getMeasurements: async (_sensorId, params) => {
        if (params.page >= 3)
          throw timeout('OpenAQ timed out serving the request.', { status: 408 });
        return fullPage(dailyMeasurement, 2000);
      },
    });
    const { result, enrichment, notice } = await pull(1000, 'hourly');

    expect(result.pulledCount).toBe(2000);
    expect(result.pullComplete).toBe(true);
    expect(enrichment.totalCount).toBe(2000);
    expect(notice).not.toMatch(/partial|not complete/);
  });

  it('never pairs a complete pull of exactly 5000 rows with the cap notice', async () => {
    // 16 full pages of 300, then a short page of 200: the pager saw the end.
    pagedSeries(5000, 'raw');
    const { result, notice } = await pull(300);

    expect(result.pulledCount).toBe(5000);
    expect(result.pullComplete).toBe(true);
    expect(notice).not.toMatch(/capped at 5000|not complete/);
  });

  it('leaves a range that ends before the ceiling untouched at a non-divisor limit', async () => {
    const pages = pagedSeries(900, 'raw');
    const { result, enrichment, notice } = await pull(300);

    expect(pages).toEqual([1, 2, 3, 4]);
    expect(result.pulledCount).toBe(900);
    expect(result.pullComplete).toBe(true);
    expect(enrichment.totalCount).toBe(900);
    expect(notice).not.toMatch(/Pull capped/);
  });

  it('keeps the default limit on the ceiling with the notice unchanged', async () => {
    pagedSeries(20_000, 'raw');
    const { result, enrichment, notice } = await pull(1000);

    expect(result.pulledCount).toBe(5000);
    expect(result.pullComplete).toBe(false);
    expect(enrichment.totalCount).toBe(5000);
    expect(notice).toMatch(/Pull capped at 5000 rows — this series is not complete/);
  });
});

describe('openaq_get_measurements percentComplete range', () => {
  it('does not promise a 0–100 range OpenAQ exceeds on a DST fall-back hour', () => {
    const described =
      getMeasurements.output.shape.series.element.shape.percentComplete.description ?? '';
    // "(0–100)" stated the range as a bound; the value can exceed it.
    expect(described).not.toContain('(0–100)');
    expect(described).toMatch(/200/);
  });

  it('carries a 200% bucket through output validation', async () => {
    serveRows([
      makeBucket('2025-11-02T09:00:00Z', '2025-11-02T10:00:00Z', { percentComplete: 200 }),
    ]);
    const result = await runToolContract(getMeasurements, {
      locationId: 931,
      parametersId: 2,
      aggregation: 'hourly',
    });
    expect(result.isError).toBeFalsy();
    expect(wireText(result)).toContain('200% complete');
  });
});

/**
 * Every recovery a notice suggests has to be one the caller can still take: a
 * daily series has no coarser aggregation to fall back to, and a date-only bound
 * cannot be the fix for an edge the date-only bound itself produced.
 */
describe('openaq_get_measurements notice advice fits the request', () => {
  const noticeFor = async (
    aggregation: 'raw' | 'hourly' | 'daily',
    getMeasurementsImpl: (page: number) => MeasurementsPage,
  ) => {
    installStubService({
      getLocation: async () => seattleLocation,
      getMeasurements: async (_sensorId, params) => getMeasurementsImpl(params.page),
    });
    const ctx = ctxWith();
    await getMeasurements.handler(
      getMeasurements.input.parse({ locationId: 931, parametersId: 2, aggregation }),
      ctx,
    );
    return (getEnrichment(ctx).notice ?? '') as string;
  };

  it('never tells a capped daily series to switch to daily or hourly aggregation', async () => {
    const notice = await noticeFor('daily', () => fullPage(dailyMeasurement, 8000));
    expect(notice).toMatch(/Pull capped at 5000 rows of 8000/);
    expect(notice).toMatch(/shorter windows/);
    expect(notice).not.toMatch(/daily aggregation|hourly\/daily/);
  });

  it('points a capped hourly series at daily, not at the hourly it already uses', async () => {
    const notice = await noticeFor('hourly', () => fullPage(dailyMeasurement, 8000));
    expect(notice).toMatch(/use daily aggregation to fit the whole span under the cap/);
    expect(notice).not.toMatch(/hourly\/daily/);
  });

  it('keeps the hourly/daily advice for a capped raw series', async () => {
    const notice = await noticeFor('raw', () => fullPage(rawMeasurement, 1000, true));
    expect(notice).toMatch(/use hourly\/daily aggregation to fit the whole span under the cap/);
    expect(notice).toMatch(/narrow the range \/ use daily aggregation/);
  });

  it('offers no coarser aggregation when a daily pull stops on a failed page', async () => {
    const notice = await noticeFor('daily', (page) => {
      if (page >= 3) throw timeout('OpenAQ timed out serving the request.', { status: 408 });
      return fullPage(dailyMeasurement, 8000);
    });
    expect(notice).toMatch(/Series is partial — page 3 failed/);
    expect(notice).toMatch(/shorter date windows/);
    expect(notice).not.toMatch(/coarser aggregation/);
  });

  it('asks a DataCanvas-less daily overflow to narrow the range, not to use daily', async () => {
    const notice = await noticeFor('daily', (page) =>
      page === 1 ? onePage(Array.from({ length: 150 }, () => dailyMeasurement)) : onePage([]),
    );
    expect(notice).toMatch(/capped at 100 of 150 rows/);
    expect(notice).toMatch(/narrow the range/);
    expect(notice).not.toMatch(/daily aggregation/);
  });

  it('asks a daily overflow the canvas failed to stage to narrow the range, not to use daily', async () => {
    setCanvas({
      acquire: vi.fn(async () => {
        throw new Error('duckdb failed to start');
      }),
    } as unknown as DataCanvas);
    const notice = await noticeFor('daily', () =>
      onePage(Array.from({ length: 150 }, () => dailyMeasurement)),
    );
    expect(notice).toMatch(/could not stage the series \(duckdb failed to start\)/);
    expect(notice).toMatch(/Narrow the range to fit the series inline/);
    expect(notice).not.toMatch(/daily aggregation/);
  });

  it('flags an upstream bucket that overruns a date-only day without advising date-only bounds', async () => {
    // OpenAQ returns the day before spring-forward as a 47-hour bucket.
    serveRows(bucketsFrom([['2026-03-07T08:00:00Z', '2026-03-09T07:00:00Z']], { label: '1 day' }));
    const result = await runToolContract(getMeasurements, {
      locationId: 931,
      parametersId: 2,
      aggregation: 'daily',
      datetimeFrom: '2026-03-07',
      datetimeTo: '2026-03-07',
    });
    const notice = structured(result).notice as string;
    expect(notice).toMatch(/last bucket \(2026-03-07T08:00:00Z → 2026-03-09T07:00:00Z\)/);
    expect(notice).not.toMatch(/Date-only bounds align/);
  });

  it('does not claim date-only bounds align when the station has no timezone', async () => {
    serveRows(
      bucketsFrom([['2026-07-31T07:00:00Z', '2026-08-01T07:00:00Z']], { label: '1 day' }),
      sparseLocation,
    );
    const result = await runToolContract(getMeasurements, {
      locationId: 42,
      parametersId: 2,
      aggregation: 'daily',
      datetimeFrom: '2026-08-01',
      datetimeTo: '2026-08-01',
    });
    const notice = structured(result).notice as string;
    expect(notice).toMatch(/UTC days/);
    expect(notice).toMatch(/starts before datetimeFrom/);
    expect(notice).not.toMatch(/Date-only bounds align/);
  });

  it('points a clipped hourly edge at date-only bounds, not whole UTC hours, in a :45 zone', async () => {
    // Kathmandu (UTC+05:45): OpenAQ's hourly buckets open on the local hour, :15 UTC.
    serveRows([makeBucket('2026-09-09T18:15:00Z', '2026-09-09T19:15:00Z')], {
      ...seattleLocation,
      timezone: 'Asia/Kathmandu',
    });
    const result = await runToolContract(getMeasurements, {
      locationId: 931,
      parametersId: 2,
      aggregation: 'hourly',
      datetimeFrom: '2026-09-09T18:30:00Z',
      datetimeTo: '2026-09-10',
    });
    const notice = structured(result).notice as string;
    expect(notice).toMatch(/first bucket .* starts before datetimeFrom/);
    expect(notice).not.toMatch(/Whole-hour timestamps/);
    expect(notice).toMatch(/Date-only bounds align with the station's local days and hours/);
  });

  it('keeps the date-only hint when an explicit timestamp clipped a daily edge', async () => {
    serveRows(bucketsFrom([['2026-07-31T07:00:00Z', '2026-08-01T07:00:00Z']], { label: '1 day' }));
    const result = await runToolContract(getMeasurements, {
      locationId: 931,
      parametersId: 2,
      aggregation: 'daily',
      datetimeFrom: '2026-08-01T00:00:00Z',
      datetimeTo: '2026-08-01',
    });
    expect(structured(result).notice).toMatch(
      /Date-only bounds align with the station's local days and hours/,
    );
  });
});

describe('openaq_get_measurements date-only disclosure', () => {
  it('does not promise the most recent values when datetimeFrom is omitted — the series runs oldest first', () => {
    const described = getMeasurements.input.shape.datetimeFrom.description ?? '';
    expect(described).not.toMatch(/most recent/);
    expect(described).toMatch(/earliest/);
  });

  it('names the station timezone when a date-only bound empties a mixed range', async () => {
    serveRows([dailyMeasurement]);
    const result = await runToolContract(getMeasurements, {
      locationId: 931,
      parametersId: 2,
      aggregation: 'hourly',
      datetimeFrom: '2026-08-01',
      datetimeTo: '2026-08-01T05:00:00Z',
    });
    expect(result.isError).toBe(true);
    expect(wireText(result)).toMatch(
      /2026-08-01T07:00:00Z to 2026-08-01T05:00:00Z is empty.*local midnight in America\/Los_Angeles/s,
    );
  });
});

describe('openaq_get_measurements rejects bounds that are not real calendar instants', () => {
  it.each([
    ['datetimeFrom', '2026-13-01'],
    ['datetimeFrom', '2026-02-30'],
    ['datetimeTo', '2026-04-31'],
    ['datetimeTo', '2026-06-25T24:00:00Z'],
    ['datetimeFrom', '2026-00-10T00:00:00Z'],
  ])('rejects %s %s as invalid_arguments before any request', async (field, value) => {
    const getLocation = vi.fn(async () => seattleLocation);
    const getMeasurementsSpy = vi.fn(async () => onePage([dailyMeasurement]));
    installStubService({ getLocation, getMeasurements: getMeasurementsSpy });
    const result = await runToolContract(getMeasurements, {
      locationId: 931,
      parametersId: 2,
      aggregation: 'daily',
      [field]: value,
    });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: {
        code: JsonRpcErrorCode.InvalidParams,
        data: { reason: 'invalid_arguments', issues: [{ path: [field] }] },
      },
    });
    expect(getLocation).not.toHaveBeenCalled();
    expect(getMeasurementsSpy).not.toHaveBeenCalled();
  });

  it('still accepts a leap day and a full timestamp', async () => {
    const { calls } = serveRows([dailyMeasurement]);
    const result = await runToolContract(getMeasurements, {
      locationId: 931,
      parametersId: 2,
      aggregation: 'daily',
      datetimeFrom: '2028-02-29',
      datetimeTo: '2028-03-01T12:00:00Z',
    });
    expect(result.isError).toBeFalsy();
    expect(calls[0]).toMatchObject({
      datetimeFrom: '2028-02-29T08:00:00Z',
      datetimeTo: '2028-03-01T12:00:00Z',
    });
  });

  it('keeps the advertised pattern unchanged', () => {
    const emitted = z.toJSONSchema(getMeasurements.input, { io: 'input' }) as {
      properties: Record<string, Record<string, unknown>>;
    };
    for (const field of ['datetimeFrom', 'datetimeTo']) {
      expect(emitted.properties[field]).toMatchObject({
        type: 'string',
        pattern: '^\\d{4}-\\d{2}-\\d{2}(T\\d{2}:\\d{2}:\\d{2}Z)?$',
      });
    }
  });
});
