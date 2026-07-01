/**
 * @fileoverview openaq_dataframe_query — run a read-only SQL SELECT against the
 * measurement tables openaq_get_measurements stages on a DataCanvas. The four-layer
 * SQL gate enforces read-only. Reference tables by the name the measurements call
 * returned (measurements_<sensorId>). Throws canvas_unavailable when DuckDB is off.
 * @module mcp-server/tools/definitions/dataframe-query.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getCanvas } from '@/services/canvas-accessor.js';

export const dataframeQuery = tool('openaq_dataframe_query', {
  title: 'openaq-mcp-server: dataframe query',
  description:
    'Run a read-only SQL SELECT against the measurement tables openaq_get_measurements staged on a DataCanvas. Reference tables by the name the measurements call returned (measurements_<sensorId>). For aggregation (monthly means, exceedance counts) and cross-sensor comparison over series too large to inline. Only SELECT is allowed — writes, DDL, and file/network table functions are rejected.',
  annotations: { readOnlyHint: true },
  input: z.object({
    canvas_id: z
      .string()
      .describe('DataCanvas id returned by openaq_get_measurements when a series spilled.'),
    sql: z
      .string()
      .describe(
        'Read-only SELECT. Reference tables by the names openaq_get_measurements returned (e.g. measurements_1701). Use openaq_dataframe_describe first to see table and column names.',
      ),
  }),
  output: z.object({
    rows: z
      .array(z.record(z.string(), z.unknown()))
      .describe('Result rows (capped at the canvas row limit).'),
    rowCount: z.number().describe('Full result count before the row cap.'),
  }),
  errors: [
    {
      reason: 'canvas_unavailable',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'DataCanvas is not enabled (CANVAS_PROVIDER_TYPE is not duckdb).',
      recovery:
        'Set CANVAS_PROVIDER_TYPE=duckdb and restart the server to enable SQL over staged measurement series.',
      retryable: false,
    },
  ],

  async handler(input, ctx) {
    const canvas = getCanvas();
    if (!canvas) {
      throw ctx.fail('canvas_unavailable', undefined, { ...ctx.recoveryFor('canvas_unavailable') });
    }
    const instance = await canvas.acquire(input.canvas_id, ctx);
    const result = await instance.query(input.sql, { signal: ctx.signal });
    ctx.log.info('Canvas query executed', {
      canvasId: instance.canvasId,
      rowCount: result.rowCount,
    });
    return { rows: result.rows, rowCount: result.rowCount };
  },

  format: (result) => {
    if (result.rows.length === 0) {
      return [{ type: 'text', text: `Query returned 0 rows (rowCount: ${result.rowCount}).` }];
    }
    const columns = Object.keys(result.rows[0] as Record<string, unknown>);
    const header = `| ${columns.join(' | ')} |`;
    const divider = `| ${columns.map(() => '---').join(' | ')} |`;
    const body = result.rows
      .slice(0, 50)
      .map(
        (row) =>
          `| ${columns.map((c) => String((row as Record<string, unknown>)[c] ?? '')).join(' | ')} |`,
      )
      .join('\n');
    const note =
      result.rows.length > 50
        ? `\n\n_Showing 50 of ${result.rowCount} rows._`
        : `\n\n_${result.rowCount} rows._`;
    return [{ type: 'text', text: `${header}\n${divider}\n${body}${note}` }];
  },
});
