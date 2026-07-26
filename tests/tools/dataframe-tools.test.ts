/**
 * @fileoverview openaq_dataframe_query / openaq_dataframe_describe tests — the
 * canvas_unavailable contract when DuckDB is off, and the happy paths against a
 * fake canvas (SELECT rows, list staged tables).
 * @module tests/tools/dataframe-tools.test
 */

import type { DataCanvas } from '@cyanheads/mcp-ts-core/canvas';
import { JsonRpcErrorCode, notFound } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { dataframeDescribe } from '@/mcp-server/tools/definitions/dataframe-describe.tool.js';
import { dataframeQuery } from '@/mcp-server/tools/definitions/dataframe-query.tool.js';
import { setCanvas } from '@/services/canvas-accessor.js';

afterEach(() => {
  setCanvas(undefined);
  vi.restoreAllMocks();
});

describe('openaq_dataframe_query', () => {
  it('throws canvas_unavailable when DuckDB is not enabled', async () => {
    setCanvas(undefined);
    await expect(
      dataframeQuery.handler(
        dataframeQuery.input.parse({ canvas_id: 'abc1234567', sql: 'SELECT 1' }),
        createMockContext({ errors: dataframeQuery.errors }),
      ),
    ).rejects.toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      data: { reason: 'canvas_unavailable' },
    });
  });

  it('runs SQL against the canvas and returns rows + rowCount', async () => {
    const query = vi.fn(async () => ({
      columns: ['value'],
      rows: [{ value: 7.89 }, { value: 9.88 }],
      rowCount: 2,
    }));
    const fakeCanvas = {
      acquire: vi.fn(async () => ({ canvasId: 'abc1234567', query })),
    } as unknown as DataCanvas;
    setCanvas(fakeCanvas);

    const result = await dataframeQuery.handler(
      dataframeQuery.input.parse({
        canvas_id: 'abc1234567',
        sql: 'SELECT value FROM measurements_1701',
      }),
      createMockContext({ errors: dataframeQuery.errors }),
    );
    expect(result.rowCount).toBe(2);
    expect(result.rows).toHaveLength(2);
    expect(query).toHaveBeenCalledWith('SELECT value FROM measurements_1701', expect.anything());
  });
});

describe('openaq_dataframe_describe', () => {
  it('throws canvas_unavailable when DuckDB is not enabled', async () => {
    setCanvas(undefined);
    await expect(
      dataframeDescribe.handler(
        dataframeDescribe.input.parse({ canvas_id: 'abc1234567' }),
        createMockContext({ errors: dataframeDescribe.errors }),
      ),
    ).rejects.toMatchObject({ data: { reason: 'canvas_unavailable' } });
  });

  it('lists staged tables with row counts and columns', async () => {
    const describe = vi.fn(async () => [
      {
        name: 'measurements_1701',
        kind: 'table' as const,
        rowCount: 150,
        columns: [{ name: 'datetimeFrom' }, { name: 'value' }, { name: 'sd' }],
      },
    ]);
    const fakeCanvas = {
      acquire: vi.fn(async () => ({ canvasId: 'abc1234567', describe })),
    } as unknown as DataCanvas;
    setCanvas(fakeCanvas);

    const result = await dataframeDescribe.handler(
      dataframeDescribe.input.parse({ canvas_id: 'abc1234567' }),
      createMockContext({ errors: dataframeDescribe.errors }),
    );
    expect(result.tables).toHaveLength(1);
    expect(result.tables[0]).toMatchObject({ name: 'measurements_1701', rowCount: 150 });
    expect(result.tables[0]?.columns).toEqual(['datetimeFrom', 'value', 'sd']);
  });

  it('emits a notice when the canvas holds no tables', async () => {
    const fakeCanvas = {
      acquire: vi.fn(async () => ({ canvasId: 'abc1234567', describe: async () => [] })),
    } as unknown as DataCanvas;
    setCanvas(fakeCanvas);
    const ctx = createMockContext({ errors: dataframeDescribe.errors });
    const result = await dataframeDescribe.handler(
      dataframeDescribe.input.parse({ canvas_id: 'abc1234567' }),
      ctx,
    );
    expect(result.tables).toHaveLength(0);
    expect(getEnrichment(ctx).notice).toMatch(/no tables|get_measurements/i);
  });
});

/**
 * The canvas throws these from inside the framework, before handler code runs, so
 * `ctx.fail` can never be the source — the contract is the only place they can be
 * advertised. These assert the declaration exists and that the runtime error the
 * framework raises actually matches the code and reason declared for it.
 */
describe('canvas failure modes are declared, not just thrown (#16)', () => {
  const throwingCanvas = (err: Error) =>
    ({
      acquire: vi.fn(async () => {
        throw err;
      }),
    }) as unknown as DataCanvas;

  const canvasNotFound = () =>
    notFound('Canvas not found or expired.', {
      reason: 'canvas_not_found',
      canvasId: 'gone',
      recovery: { hint: 'Re-run the tool that produced this canvas_id to stage fresh data.' },
    });

  it('openaq_dataframe_describe declares canvas_not_found at the code it arrives with', async () => {
    const entry = dataframeDescribe.errors?.find((e) => e.reason === 'canvas_not_found');
    expect(entry?.code).toBe(JsonRpcErrorCode.NotFound);

    setCanvas(throwingCanvas(canvasNotFound()));
    await expect(
      dataframeDescribe.handler(
        dataframeDescribe.input.parse({ canvas_id: 'gone' }),
        createMockContext({ errors: dataframeDescribe.errors }),
      ),
    ).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'canvas_not_found' },
    });
  });

  it('openaq_dataframe_query declares canvas_not_found at the code it arrives with', async () => {
    const entry = dataframeQuery.errors?.find((e) => e.reason === 'canvas_not_found');
    expect(entry?.code).toBe(JsonRpcErrorCode.NotFound);

    setCanvas(throwingCanvas(canvasNotFound()));
    await expect(
      dataframeQuery.handler(
        dataframeQuery.input.parse({ canvas_id: 'gone', sql: 'SELECT 1' }),
        createMockContext({ errors: dataframeQuery.errors }),
      ),
    ).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'canvas_not_found' },
    });
  });

  it('openaq_dataframe_query declares missing_table and points at describe for recovery', async () => {
    const entry = dataframeQuery.errors?.find((e) => e.reason === 'missing_table');
    expect(entry?.code).toBe(JsonRpcErrorCode.NotFound);
    expect(entry?.recovery).toContain('openaq_dataframe_describe');

    const query = vi.fn(async () => {
      throw notFound('Canvas table "measurements_9" does not exist.', {
        reason: 'missing_table',
        tableName: 'measurements_9',
      });
    });
    setCanvas({
      acquire: vi.fn(async () => ({ canvasId: 'abc1234567', query })),
    } as unknown as DataCanvas);

    await expect(
      dataframeQuery.handler(
        dataframeQuery.input.parse({
          canvas_id: 'abc1234567',
          sql: 'SELECT * FROM measurements_9',
        }),
        createMockContext({ errors: dataframeQuery.errors }),
      ),
    ).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'missing_table', tableName: 'measurements_9' },
    });
  });
});
