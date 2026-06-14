/**
 * @fileoverview openaq_dataframe_query / openaq_dataframe_describe tests — the
 * canvas_unavailable contract when DuckDB is off, and the happy paths against a
 * fake canvas (SELECT rows, list staged tables).
 * @module tests/tools/dataframe-tools.test
 */

import type { DataCanvas } from '@cyanheads/mcp-ts-core/canvas';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
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
