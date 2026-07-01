/**
 * @fileoverview openaq_dataframe_describe — list the tables and columns staged on
 * a DataCanvas so you can write valid SQL for openaq_dataframe_query without guessing
 * column names. Throws canvas_unavailable when DuckDB is off.
 * @module mcp-server/tools/definitions/dataframe-describe.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getCanvas } from '@/services/canvas-accessor.js';

export const dataframeDescribe = tool('openaq_dataframe_describe', {
  title: 'openaq-mcp-server: dataframe describe',
  description:
    'List the tables and columns staged on a DataCanvas so you can write valid SQL for openaq_dataframe_query without guessing column names. Returns each measurement table (measurements_<sensorId>) with its row count and column names. Requires DataCanvas to be enabled.',
  annotations: { readOnlyHint: true },
  input: z.object({
    canvas_id: z
      .string()
      .describe('DataCanvas id returned by openaq_get_measurements when a series spilled.'),
  }),
  output: z.object({
    tables: z
      .array(
        z
          .object({
            name: z.string().describe('Table name — reference it in openaq_dataframe_query SQL.'),
            rowCount: z.number().describe('Rows staged in this table.'),
            columns: z.array(z.string()).describe('Column names available for SELECT.'),
          })
          .describe('A staged measurement table with its columns'),
      )
      .describe('Tables currently staged on the canvas.'),
  }),
  enrichment: {
    notice: z.string().optional().describe('Guidance when the canvas holds no tables yet.'),
  },
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
    const tables = await instance.describe();
    if (tables.length === 0) {
      ctx.enrich.notice(
        'No tables staged on this canvas yet. Run openaq_get_measurements with a large range to stage a series.',
      );
    }
    ctx.log.info('Canvas described', { canvasId: instance.canvasId, tableCount: tables.length });
    return {
      tables: tables.map((t) => ({
        name: t.name,
        rowCount: t.rowCount,
        columns: t.columns.map((c) => c.name),
      })),
    };
  },

  format: (result) => {
    if (result.tables.length === 0) {
      return [{ type: 'text', text: 'No tables staged on this canvas.' }];
    }
    const lines = result.tables.map(
      (t) => `- **${t.name}** (${t.rowCount} rows): ${t.columns.join(', ')}`,
    );
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
