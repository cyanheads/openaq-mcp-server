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
import { getMeasurements } from '@/mcp-server/tools/definitions/get-measurements.tool.js';
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

/**
 * The canvas row limit defaults to 10,000 — a DuckDB ceiling, not a response
 * budget — so the tool passes its own cap and reports when the cap bit. These
 * drive a fake `query` that honours the `rowLimit` it is handed, exactly as the
 * DuckDB provider does (`rowCount === rowLimit` and `truncated: true` when more
 * rows exist, `truncated` absent otherwise).
 */
describe('openaq_dataframe_query response cap (#25)', () => {
  /** A fake `query` that produces `available` rows, capped at the passed `rowLimit`. */
  const cappingQuery = (available: number) =>
    vi.fn(async (_sql: string, options?: { rowLimit?: number }) => {
      const rowLimit = options?.rowLimit ?? 10_000;
      const returned = Math.min(available, rowLimit);
      return {
        columns: ['value'],
        rows: Array.from({ length: returned }, (_, i) => ({ value: i })),
        rowCount: returned,
        ...(available > rowLimit ? { truncated: true as const } : {}),
      };
    });

  const runQuery = async (query: ReturnType<typeof cappingQuery>) => {
    setCanvas({
      acquire: vi.fn(async () => ({ canvasId: 'abc1234567', query })),
    } as unknown as DataCanvas);
    const ctx = createMockContext({ errors: dataframeQuery.errors });
    const result = await dataframeQuery.handler(
      dataframeQuery.input.parse({
        canvas_id: 'abc1234567',
        sql: 'SELECT value FROM measurements_1701',
      }),
      ctx,
    );
    return { ctx, result };
  };

  const formatText = (result: Parameters<NonNullable<typeof dataframeQuery.format>>[0]): string =>
    (dataframeQuery.format?.(result) ?? [])
      .map((b) => (b.type === 'text' ? b.text : ''))
      .join('\n');

  it('forwards a 200-row cap to the canvas and bounds the response at it', async () => {
    const query = cappingQuery(966_289);
    const { result } = await runQuery(query);

    expect(query).toHaveBeenCalledWith(
      'SELECT value FROM measurements_1701',
      expect.objectContaining({ rowLimit: 200 }),
    );
    expect(result.rows).toHaveLength(200);
    expect(result.rowCount).toBe(200);
    expect(result.truncated).toBe(true);
  });

  it('names ORDER BY … LIMIT … OFFSET as the continuation when the cap bit', async () => {
    const { ctx } = await runQuery(cappingQuery(1966));
    const notice = getEnrichment(ctx).notice as string;

    expect(notice).toContain('ORDER BY <column> LIMIT 200 OFFSET <n>');
    expect(notice).toContain('200-row cap');
  });

  it('leaves truncated absent and reports the exact count when the result fits', async () => {
    const { ctx, result } = await runQuery(cappingQuery(42));

    expect(result.truncated).toBeUndefined();
    expect(result.rowCount).toBe(42);
    expect(result.rowCount).toBe(result.rows.length);
    expect(getEnrichment(ctx).notice).toBeUndefined();
  });

  it('treats a result of exactly the cap as complete — no truncation, no notice', async () => {
    const { ctx, result } = await runQuery(cappingQuery(200));

    expect(result.rows).toHaveLength(200);
    expect(result.rowCount).toBe(200);
    expect(result.truncated).toBeUndefined();
    expect(getEnrichment(ctx).notice).toBeUndefined();
  });

  it('flags one row past the cap as truncated', async () => {
    const { ctx, result } = await runQuery(cappingQuery(201));

    expect(result.rows).toHaveLength(200);
    expect(result.truncated).toBe(true);
    expect(getEnrichment(ctx).notice).toBeDefined();
  });

  it('returns an empty result without a truncation flag or a notice', async () => {
    const { ctx, result } = await runQuery(cappingQuery(0));

    expect(result.rows).toEqual([]);
    expect(result.rowCount).toBe(0);
    expect(result.truncated).toBeUndefined();
    expect(getEnrichment(ctx).notice).toBeUndefined();
    expect(formatText(result)).toContain('0 rows');
  });

  it('never carries truncated without a notice, or a notice without truncated', async () => {
    for (const available of [0, 1, 199, 200, 201, 5000]) {
      const { ctx, result } = await runQuery(cappingQuery(available));
      expect(result.truncated === true).toBe(getEnrichment(ctx).notice !== undefined);
    }
  });

  it('returns an offset past the end as an empty page, not an error', async () => {
    const query = vi.fn(async () => ({ columns: ['value'], rows: [], rowCount: 0 }));
    setCanvas({
      acquire: vi.fn(async () => ({ canvasId: 'abc1234567', query })),
    } as unknown as DataCanvas);
    const ctx = createMockContext({ errors: dataframeQuery.errors });
    const result = await dataframeQuery.handler(
      dataframeQuery.input.parse({
        canvas_id: 'abc1234567',
        sql: 'SELECT value FROM measurements_1701 ORDER BY value LIMIT 200 OFFSET 999999',
      }),
      ctx,
    );

    expect(result.rows).toEqual([]);
    expect(result.truncated).toBeUndefined();
    expect(getEnrichment(ctx).notice).toBeUndefined();
  });

  it('renders every returned row in content[] and states the truncation there too (#24)', async () => {
    const { result } = await runQuery(cappingQuery(1966));
    const text = formatText(result);
    const rendered = text.split('\n').filter((l) => l.startsWith('| ') && !l.includes('---'));

    // header + 200 body rows, and no "Showing 50 of N" slice.
    expect(rendered).toHaveLength(201);
    expect(text).not.toContain('Showing 50');
    expect(text).toMatch(/truncated/i);
  });
});

/**
 * Cell text comes from arbitrary SELECT projections, so the delimiters have to be
 * neutralized in `content[]` while `structuredContent.rows` keeps the raw value.
 * These assert on the rendered table shape, not on the escape function.
 */
describe('openaq_dataframe_query format() escapes Markdown table cells (#8)', () => {
  const render = (rows: Record<string, unknown>[], rowCount = rows.length): string => {
    const blocks = dataframeQuery.format?.({ rows, rowCount }) ?? [];
    return blocks.map((b) => (b.type === 'text' ? b.text : '')).join('\n');
  };

  it('escapes a pipe so the row keeps its declared column count', () => {
    const text = render([{ pipe_value: 'a|b', other: 'plain' }]);
    const dataRow = text.split('\n')[2] as string;
    expect(dataRow).toBe('| a\\|b | plain |');
    expect(dataRow.split(/(?<!\\)\|/)).toHaveLength(4); // leading + 2 cells + trailing
  });

  it('collapses embedded newlines so a value cannot end the row early', () => {
    const text = render([{ newline_value: 'line1\nline2' }]);
    expect(text).toContain('| line1<br>line2 |');
    expect(text.split('\n')).toHaveLength(5); // header, divider, 1 row, blank, note
  });

  it('normalizes CRLF and lone CR the same way as LF', () => {
    expect(render([{ v: 'a\r\nb' }])).toContain('| a<br>b |');
    expect(render([{ v: 'a\rb' }])).toContain('| a<br>b |');
  });

  it('escapes a backslash before the pipe so an escaped pipe is not re-armed', () => {
    expect(render([{ v: 'a\\|b' }])).toContain('| a\\\\\\|b |');
  });

  it('escapes column names, which are projections too', () => {
    const text = render([{ 'a|b': 1 }]);
    expect(text.split('\n')[0]).toBe('| a\\|b |');
  });

  it('renders null and undefined as an empty cell', () => {
    expect(render([{ a: null, b: undefined }]).split('\n')[2]).toBe('|  |  |');
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

  /** Well-formed against CanvasIdSchema, but no longer resolvable — an expired canvas. */
  const EXPIRED_CANVAS_ID = 'goneCanvs1';

  const canvasNotFound = () =>
    notFound('Canvas not found or expired.', {
      reason: 'canvas_not_found',
      canvasId: EXPIRED_CANVAS_ID,
      recovery: { hint: 'Re-run the tool that produced this canvas_id to stage fresh data.' },
    });

  it('openaq_dataframe_describe declares canvas_not_found at the code it arrives with', async () => {
    const entry = dataframeDescribe.errors?.find((e) => e.reason === 'canvas_not_found');
    expect(entry?.code).toBe(JsonRpcErrorCode.NotFound);

    setCanvas(throwingCanvas(canvasNotFound()));
    await expect(
      dataframeDescribe.handler(
        dataframeDescribe.input.parse({ canvas_id: EXPIRED_CANVAS_ID }),
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
        dataframeQuery.input.parse({ canvas_id: EXPIRED_CANVAS_ID, sql: 'SELECT 1' }),
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

/**
 * `canvas_id` inputs carry the framework's minted-id shape, so a value that could
 * never name a real canvas is rejected at argument validation rather than spending
 * a registry lookup and coming back as an expired canvas. These assert the
 * constraint reaches the advertised `inputSchema`, not just the handler.
 */
describe('canvas_id inputs reject a malformed id at argument validation', () => {
  const MALFORMED = ['gone', '', 'way-too-long-to-be-minted', 'bad id 123', 'abc/123456'];
  const WELL_FORMED = 'abc1234567';

  it.each(MALFORMED)('openaq_dataframe_query rejects %o', (canvas_id) => {
    expect(dataframeQuery.input.safeParse({ canvas_id, sql: 'SELECT 1' }).success).toBe(false);
  });

  it.each(MALFORMED)('openaq_dataframe_describe rejects %o', (canvas_id) => {
    expect(dataframeDescribe.input.safeParse({ canvas_id }).success).toBe(false);
  });

  it.each(MALFORMED)(
    'openaq_get_measurements rejects %o for its optional canvas_id',
    (canvas_id) => {
      expect(
        getMeasurements.input.safeParse({ locationId: 1, parametersId: 2, canvas_id }).success,
      ).toBe(false);
    },
  );

  it('accepts a well-formed minted id on every tool that takes one', () => {
    expect(
      dataframeQuery.input.safeParse({ canvas_id: WELL_FORMED, sql: 'SELECT 1' }).success,
    ).toBe(true);
    expect(dataframeDescribe.input.safeParse({ canvas_id: WELL_FORMED }).success).toBe(true);
    expect(
      getMeasurements.input.safeParse({ locationId: 1, parametersId: 2, canvas_id: WELL_FORMED })
        .success,
    ).toBe(true);
  });

  it('leaves openaq_get_measurements canvas_id optional', () => {
    expect(getMeasurements.input.safeParse({ locationId: 1, parametersId: 2 }).success).toBe(true);
  });

  it('names the offending field so a caller can fix the call', () => {
    const parsed = dataframeQuery.input.safeParse({ canvas_id: 'gone', sql: 'SELECT 1' });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues[0]?.path).toEqual(['canvas_id']);
    }
  });
});
