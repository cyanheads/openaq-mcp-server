/**
 * @fileoverview openaq_dataframe_query — run a read-only SQL SELECT against the
 * measurement tables openaq_get_measurements stages on a DataCanvas. The four-layer
 * SQL gate enforces read-only; a separate row cap bounds the response, since the
 * gate constrains what the SQL may do and not how many rows it yields. Reference
 * tables by the name the measurements call returned (measurements_<sensorId>).
 * Throws canvas_unavailable when DuckDB is off.
 * @module mcp-server/tools/definitions/dataframe-query.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { CanvasIdSchema } from '@cyanheads/mcp-ts-core/canvas';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getCanvas } from '@/services/canvas-accessor.js';

/**
 * Rows a single query may return. The canvas default (10,000) is a DuckDB
 * ceiling, not a response budget — a `CROSS JOIN` over a staged series reaches
 * it and lands ~1.8 MB in one response. 200 keeps the widest staged row shape
 * near 37 KB, and the caller pages past it with LIMIT/OFFSET in their own SQL.
 */
const ROW_CAP = 200;

/**
 * Render one value as a Markdown table cell. Column names and values both come
 * from arbitrary SQL projections, so an unescaped pipe opens a column the header
 * never declared and an embedded newline ends the row mid-cell. Backslash is
 * escaped first: doing it after the pipe would rewrite `a\|b` into a literal
 * backslash followed by a live delimiter. `structuredContent.rows` keeps the raw
 * value — this is the display twin only.
 */
const escapeCell = (value: unknown): string =>
  String(value ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/\|/g, '\\|')
    .replace(/\r\n|[\r\n]/g, '<br>');

export const dataframeQuery = tool('openaq_dataframe_query', {
  title: 'openaq-mcp-server: dataframe query',
  description: `Run a read-only SQL SELECT against the measurement tables openaq_get_measurements staged on a DataCanvas. Reference tables by the name the measurements call returned (measurements_<sensorId>). For aggregation (monthly means, exceedance counts) and cross-sensor comparison over series too large to inline. Only SELECT is allowed — writes, DDL, and file/network table functions are rejected. Responses carry at most ${ROW_CAP} rows; aggregate in SQL, or page with ORDER BY plus LIMIT/OFFSET, rather than selecting a whole table.`,
  annotations: { readOnlyHint: true },
  input: z.object({
    canvas_id: CanvasIdSchema.describe(
      'DataCanvas id returned by openaq_get_measurements — minted when a series overflowed the inline preview, or the canvas_id you passed it.',
    ),
    sql: z
      .string()
      .describe(
        'Read-only SELECT. Reference tables by the names openaq_get_measurements returned (e.g. measurements_1701). Use openaq_dataframe_describe first to see table and column names.',
      ),
  }),
  output: z.object({
    rows: z
      .array(z.record(z.string(), z.unknown()))
      .describe(
        `Result rows, at most ${ROW_CAP}. Every row here is also rendered in the text output — the two surfaces carry the same set.`,
      ),
    rowCount: z
      .number()
      .describe(
        `Rows returned in this response, always equal to rows.length. It is the cap (${ROW_CAP}) when truncated is set, not the size of the full result.`,
      ),
    truncated: z
      .boolean()
      .optional()
      .describe(
        `True when the query matched more than ${ROW_CAP} rows and the response was cut to the cap. Absent when the whole result fit. Page through the rest with ORDER BY plus LIMIT/OFFSET in your own SQL.`,
      ),
  }),
  enrichment: {
    notice: z
      .string()
      .optional()
      .describe('How to reach the rest of the result when the row cap cut it short.'),
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
    {
      reason: 'canvas_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'The canvas_id is unknown or its canvas has expired.',
      recovery:
        'Re-run openaq_get_measurements without a canvas_id (or with a live one) and use the canvasId it returns — any range, since a supplied canvas_id stages the series whatever its size.',
      retryable: false,
      thrownBy: 'service',
    },
    {
      reason: 'missing_table',
      code: JsonRpcErrorCode.NotFound,
      when: 'The SQL references a table that is not staged on this canvas (dropped, expired, or misspelled).',
      recovery:
        'Call openaq_dataframe_describe on this canvas_id to list the staged tables, then reference one of those names.',
      retryable: false,
      thrownBy: 'service',
    },
  ],

  async handler(input, ctx) {
    const canvas = getCanvas();
    if (!canvas) {
      throw ctx.fail('canvas_unavailable', undefined, { ...ctx.recoveryFor('canvas_unavailable') });
    }
    const instance = await canvas.acquire(input.canvas_id, ctx);
    const result = await instance.query(input.sql, { rowLimit: ROW_CAP, signal: ctx.signal });
    ctx.log.info('Canvas query executed', {
      canvasId: instance.canvasId,
      rowCount: result.rowCount,
      truncated: result.truncated ?? false,
    });
    if (result.truncated) {
      // No nextOffset field: the caller writes the SQL, and an offset computed
      // here would promise an ordering the query may not have.
      ctx.enrich.notice(
        `Result cut to the ${ROW_CAP}-row cap — more rows matched. Page through them from your own SQL: ORDER BY <column> LIMIT ${ROW_CAP} OFFSET <n>, raising <n> by ${ROW_CAP} each call. ORDER BY is load-bearing — OFFSET without a deterministic order can repeat or skip rows between pages.`,
      );
    }
    return {
      rows: result.rows,
      rowCount: result.rowCount,
      ...(result.truncated ? { truncated: true } : {}),
    };
  },

  format: (result) => {
    if (result.rows.length === 0) {
      return [{ type: 'text', text: `Query returned 0 rows (rowCount: ${result.rowCount}).` }];
    }
    const columns = Object.keys(result.rows[0] as Record<string, unknown>);
    const header = `| ${columns.map(escapeCell).join(' | ')} |`;
    const divider = `| ${columns.map(() => '---').join(' | ')} |`;
    // Every row the response carries is rendered — the text and structured
    // surfaces must reason over the same set, and the cap already bounds it.
    const body = result.rows
      .map(
        (row) =>
          `| ${columns.map((c) => escapeCell((row as Record<string, unknown>)[c])).join(' | ')} |`,
      )
      .join('\n');
    const note = result.truncated
      ? `\n\n_${result.rowCount} rows — truncated at the ${ROW_CAP}-row cap; more matched._`
      : `\n\n_${result.rowCount} rows._`;
    return [{ type: 'text', text: `${header}\n${divider}\n${body}${note}` }];
  },
});
