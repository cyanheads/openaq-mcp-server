/**
 * @fileoverview openaq_get_measurements — historical measurement series for one
 * pollutant at one station over a date range. Resolves the station's sensor for
 * the parameter internally (v3 series are sensor-scoped). Large ranges spill to a
 * DataCanvas: the response carries a preview plus a canvasId + table name queryable
 * with openaq_dataframe_query. Values carry their unit; units are never converted.
 * @module mcp-server/tools/definitions/get-measurements.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { isNotFound } from '@/mcp-server/tools/shared/schema-helpers.js';
import { getCanvas } from '@/services/canvas-accessor.js';
import { getOpenAqService } from '@/services/openaq/openaq-service.js';
import type { OpenAqLocation, OpenAqMeasurement } from '@/services/openaq/types.js';

/** Hard ceiling on rows pulled across internal paging — steers huge ranges to canvas + daily. */
const MAX_ROWS = 5000;
const PAGE_LIMIT = 1000;
/** Inline preview budget in rows (the JSON char budget for canvas spill is separate). */
const PREVIEW_ROWS = 100;

const dateRegex = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2}Z)?$/;

/**
 * A flattened, JSON-safe measurement row — the shape staged on the canvas. The
 * index signature keeps it assignable to the canvas `RegisterRows` row type
 * (`Record<string, unknown>`) without a cast.
 */
interface SeriesRow {
  avg: number | null;
  datetimeFrom: string;
  datetimeTo: string;
  flagged: boolean;
  max: number | null;
  median: number | null;
  min: number | null;
  percentComplete: number | null;
  sd: number | null;
  value: number;
  [key: string]: string | number | boolean | null;
}

function toSeriesRow(m: OpenAqMeasurement): SeriesRow {
  const s = m.summary;
  return {
    datetimeFrom: m.period.datetimeFrom.utc,
    datetimeTo: m.period.datetimeTo.utc,
    value: m.value,
    min: s?.min ?? null,
    median: s?.median ?? null,
    max: s?.max ?? null,
    avg: s?.avg ?? null,
    sd: s?.sd ?? null,
    percentComplete: m.coverage?.percentComplete ?? null,
    flagged: m.flagInfo?.hasFlags ?? false,
  };
}

/** Project a flat SeriesRow back into the nested output `series` shape. */
function toOutputRow(r: SeriesRow, aggregation: 'raw' | 'hourly' | 'daily') {
  return {
    datetimeFrom: r.datetimeFrom,
    datetimeTo: r.datetimeTo,
    value: r.value,
    summary:
      aggregation === 'raw'
        ? null
        : { min: r.min, median: r.median, max: r.max, avg: r.avg, sd: r.sd },
    percentComplete: r.percentComplete,
    flagged: r.flagged,
  };
}

export const getMeasurements = tool('openaq_get_measurements', {
  title: 'openaq-mcp-server: get measurements',
  description:
    'Historical measurement series for one pollutant at one station over a date range — for trend analysis and "was last week worse than the monthly average?". Pass a locationId and a parametersId; the tool resolves the station\'s sensor for that parameter internally (v3 series are sensor-scoped, but you think in stations). Choose aggregation: raw (every reported value), hourly, or daily — daily and hourly add a per-bucket statistical summary (min, median, max, mean, sd). Large ranges produce thousands of rows and spill to a DataCanvas: the response returns a preview plus a canvasId and table name you query with openaq_dataframe_query. Values carry their unit; the server never converts between µg/m³, ppm, and ppb.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  input: z.object({
    locationId: z.number().int().describe('Station id from openaq_find_locations.'),
    parametersId: z
      .number()
      .int()
      .describe(
        "Parameter id to pull the series for (e.g. 2 = PM2.5 µg/m³). Get ids from openaq_list_parameters. Must be a parameter the station measures — find_locations lists each station's parameters.",
      ),
    datetimeFrom: z
      .string()
      .regex(dateRegex)
      .optional()
      .describe(
        'Start of the range, inclusive. Date "YYYY-MM-DD" or full UTC "YYYY-MM-DDTHH:MM:SSZ". Omit to get the most recent values.',
      ),
    datetimeTo: z
      .string()
      .regex(dateRegex)
      .optional()
      .describe(
        'End of the range, inclusive. Must be on or after datetimeFrom. Omit for "up to now".',
      ),
    aggregation: z
      .enum(['raw', 'hourly', 'daily'])
      .default('raw')
      .describe(
        'Time bucketing. "raw" = every reported value (often hourly at source). "hourly"/"daily" = server-side rollups with a statistical summary per bucket. Use "daily" for multi-month trends to keep the series small; "raw" for fine-grained recent analysis.',
      ),
    limit: z
      .number()
      .int()
      .min(1)
      .max(1000)
      .default(1000)
      .describe(
        'Max rows per page from the API (1–1000). Default 1000. The tool pages internally up to the spill threshold.',
      ),
    canvas_id: z
      .string()
      .optional()
      .describe(
        "DataCanvas id from a prior call to reuse the same canvas (e.g. to compare two stations' series side by side). Omit to start fresh; the response returns a new canvas_id when the series spills.",
      ),
  }),
  output: z.object({
    location: z
      .object({
        id: z.number().describe('Station id'),
        name: z.string().describe('Station name'),
      })
      .describe('Station the series came from'),
    parameter: z
      .object({
        id: z.number().describe('Parameter id'),
        name: z.string().describe('Pollutant code'),
        unit: z
          .string()
          .describe('Unit for every value in this series. The server does not convert units.'),
        displayName: z.string().nullable().describe('Human-readable pollutant name'),
      })
      .describe("What was measured, resolved from the station's sensor"),
    sensorId: z.number().describe('Resolved sensor id the series was pulled from'),
    aggregation: z.enum(['raw', 'hourly', 'daily']).describe('Bucketing applied'),
    series: z
      .array(
        z
          .object({
            datetimeFrom: z.string().describe('Bucket start, UTC (ISO 8601)'),
            datetimeTo: z.string().describe('Bucket end, UTC (ISO 8601)'),
            value: z
              .number()
              .describe(
                'Value for the bucket (the measurement for raw; the bucket aggregate for hourly/daily)',
              ),
            summary: z
              .object({
                min: z.number().nullable().describe('Minimum reading in the bucket'),
                median: z.number().nullable().describe('Median reading in the bucket'),
                max: z.number().nullable().describe('Maximum reading in the bucket'),
                avg: z.number().nullable().describe('Mean reading in the bucket'),
                sd: z
                  .number()
                  .nullable()
                  .describe('Standard deviation — null when only one reading in the bucket'),
              })
              .nullable()
              .describe('Per-bucket statistics — present for hourly/daily, null for raw'),
            percentComplete: z
              .number()
              .nullable()
              .describe('Coverage of the bucket (0–100); low values flag gappy data'),
            flagged: z
              .boolean()
              .describe('True if the source flagged this value (quality concern)'),
          })
          .describe('One bucket in the series, with its value and (for rollups) statistics'),
      )
      .describe(
        'The (possibly previewed) series, newest or oldest first per the API. When truncated, this is a preview — query canvasId for the full set.',
      ),
    rowCount: z.number().describe('Rows in this response (preview length when spilled)'),
    canvasId: z
      .string()
      .optional()
      .describe('DataCanvas id holding the full series. Query with openaq_dataframe_query.'),
    tableName: z
      .string()
      .optional()
      .describe(
        'Canvas table name for the full series (e.g. "measurements_1701"). Reference it in SQL.',
      ),
    truncated: z
      .boolean()
      .optional()
      .describe(
        'True when the series exceeded the inline limit and the full set was staged on canvasId. Absent/false when everything fit inline.',
      ),
  }),
  enrichment: {
    totalCount: z.number().describe('Total rows in the full series.'),
    notice: z
      .string()
      .optional()
      .describe('Degraded-mode hint when the series was truncated but DataCanvas is unavailable.'),
  },
  errors: [
    {
      reason: 'location_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'The locationId does not exist.',
      recovery: 'Verify the id via openaq_find_locations.',
      retryable: false,
    },
    {
      reason: 'parameter_not_at_location',
      code: JsonRpcErrorCode.NotFound,
      when: 'No sensor at the station measures parametersId (often the wrong unit variant was chosen).',
      recovery:
        "Check the station's parameters in openaq_find_locations output, and confirm the id (and its unit) in openaq_list_parameters — the same pollutant has different ids for µg/m³ vs ppm vs ppb.",
      retryable: false,
    },
    {
      reason: 'no_data_for_range',
      code: JsonRpcErrorCode.NotFound,
      when: 'The sensor has no measurements in the requested date range.',
      recovery:
        "Widen the range or check the station's datetimeFirst/datetimeLast from openaq_find_locations.",
      retryable: false,
    },
    {
      reason: 'invalid_date_range',
      code: JsonRpcErrorCode.ValidationError,
      when: 'datetimeTo is before datetimeFrom.',
      recovery: 'Ensure datetimeTo is on or after datetimeFrom.',
      retryable: false,
    },
    {
      reason: 'upstream_error',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'OpenAQ returned 5xx, a rate-limit (429), or timed out.',
      recovery: 'Retry after a short backoff.',
      retryable: true,
    },
  ],

  async handler(input, ctx) {
    const service = getOpenAqService();

    if (input.datetimeFrom && input.datetimeTo && input.datetimeTo < input.datetimeFrom) {
      throw ctx.fail('invalid_date_range', undefined, { ...ctx.recoveryFor('invalid_date_range') });
    }

    // Resolve the sensor for this parameter from the station's sensor map.
    let location: OpenAqLocation;
    try {
      location = await service.getLocation(input.locationId, ctx);
    } catch (err) {
      if (isNotFound(err)) {
        throw ctx.fail(
          'location_not_found',
          `OpenAQ has no location ${input.locationId}.`,
          { locationId: input.locationId, ...ctx.recoveryFor('location_not_found') },
          { cause: err },
        );
      }
      throw err;
    }

    const sensor = location.sensors.find((s) => s.parameter.id === input.parametersId);
    if (!sensor) {
      throw ctx.fail(
        'parameter_not_at_location',
        `Station ${input.locationId} has no sensor for parameter ${input.parametersId}.`,
        {
          locationId: input.locationId,
          parametersId: input.parametersId,
          available: location.sensors.map((s) => s.parameter.id),
          ...ctx.recoveryFor('parameter_not_at_location'),
        },
      );
    }

    // Page the series up to the row ceiling.
    const pageSize = Math.min(input.limit, PAGE_LIMIT);
    const allRows: SeriesRow[] = [];
    let found = 0;
    let exhausted = false;
    for (let page = 1; allRows.length < MAX_ROWS; page++) {
      const result = await service.getMeasurements(
        sensor.id,
        {
          ...(input.datetimeFrom ? { datetimeFrom: input.datetimeFrom } : {}),
          ...(input.datetimeTo ? { datetimeTo: input.datetimeTo } : {}),
          aggregation: input.aggregation,
          limit: pageSize,
          page,
        },
        ctx,
      );
      found = result.found;
      allRows.push(...result.results.map(toSeriesRow));
      if (result.results.length < pageSize) {
        exhausted = true;
        break;
      }
    }

    if (allRows.length === 0) {
      throw ctx.fail(
        'no_data_for_range',
        `Sensor ${sensor.id} has no data for the requested range.`,
        {
          sensorId: sensor.id,
          ...ctx.recoveryFor('no_data_for_range'),
        },
      );
    }

    const totalRows = exhausted ? allRows.length : Math.max(found, allRows.length);
    ctx.enrich.total(Number.isFinite(totalRows) ? totalRows : allRows.length);

    const parameterOut = {
      id: sensor.parameter.id,
      name: sensor.parameter.name,
      unit: sensor.parameter.units,
      displayName: sensor.parameter.displayName,
    };
    const locationOut = { id: location.id, name: location.name ?? `location ${location.id}` };

    const overflow = allRows.length > PREVIEW_ROWS;
    const previewRows = overflow ? allRows.slice(0, PREVIEW_ROWS) : allRows;
    const base = {
      location: locationOut,
      parameter: parameterOut,
      sensorId: sensor.id,
      aggregation: input.aggregation,
      series: previewRows.map((r) => toOutputRow(r, input.aggregation)),
      rowCount: previewRows.length,
    };

    if (!overflow) {
      ctx.log.info('Measurement series fit inline', { sensorId: sensor.id, rows: allRows.length });
      return base;
    }

    // Series overflows the inline preview — stage the full set on the canvas if available.
    const canvas = getCanvas();
    if (!canvas) {
      ctx.enrich.notice(
        `Series truncated to ${PREVIEW_ROWS} of ${allRows.length} rows — enable DataCanvas (CANVAS_PROVIDER_TYPE=duckdb) for the full set, or narrow the range / use daily aggregation.`,
      );
      ctx.log.info('Measurement series truncated (no canvas)', {
        sensorId: sensor.id,
        rows: allRows.length,
      });
      return { ...base, truncated: true };
    }

    const instance = await canvas.acquire(input.canvas_id, ctx);
    const tableName = `measurements_${sensor.id}`;
    await instance.drop(tableName); // idempotent re-stage when reusing a canvas
    const handle = await instance.registerTable(tableName, allRows, { signal: ctx.signal });

    ctx.log.info('Measurement series staged on canvas', {
      sensorId: sensor.id,
      canvasId: instance.canvasId,
      tableName: handle.tableName,
      rows: handle.rowCount,
    });

    return {
      ...base,
      canvasId: instance.canvasId,
      tableName: handle.tableName,
      truncated: true,
    };
  },

  format: (result) => {
    const head = `## ${result.location.name} (id ${result.location.id}) — ${result.parameter.displayName ?? result.parameter.name} (\`${result.parameter.name}\` #${result.parameter.id}, ${result.parameter.unit})`;
    const meta = `aggregation: ${result.aggregation} · sensor ${result.sensorId} · ${result.rowCount} rows shown`;
    const spill = result.truncated
      ? result.canvasId
        ? `\n**Truncated** — full series on canvas \`${result.canvasId}\`, table \`${result.tableName}\`. Query with openaq_dataframe_query.`
        : '\n**Truncated** — preview only; DataCanvas is not enabled for the full set.'
      : '';
    const rows = result.series
      .slice(0, 20)
      .map((r) => {
        const stats = r.summary
          ? ` (min ${r.summary.min ?? 'n/a'}, median ${r.summary.median ?? 'n/a'}, max ${r.summary.max ?? 'n/a'}, avg ${r.summary.avg ?? 'n/a'}, sd ${r.summary.sd ?? 'n/a'})`
          : '';
        const cov = r.percentComplete != null ? ` · ${r.percentComplete}% complete` : '';
        const flag = r.flagged ? ' · flagged' : '';
        return `- ${r.datetimeFrom} → ${r.datetimeTo}: ${r.value} ${result.parameter.unit}${stats}${cov}${flag}`;
      })
      .join('\n');
    return [{ type: 'text', text: [head, meta + spill, '', rows].join('\n') }];
  },
});
