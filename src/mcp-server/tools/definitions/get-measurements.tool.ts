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
import { displayNumber } from '@/mcp-server/tools/shared/format-helpers.js';
import { isNotFound } from '@/mcp-server/tools/shared/schema-helpers.js';
import { upstreamFailure, withUpstream } from '@/mcp-server/tools/shared/upstream-errors.js';
import { getCanvas } from '@/services/canvas-accessor.js';
import { getOpenAqService, type MeasurementsPage } from '@/services/openaq/openaq-service.js';
import type { OpenAqLocation, OpenAqMeasurement } from '@/services/openaq/types.js';

/** Hard ceiling on rows pulled across internal paging — steers huge ranges to canvas + daily. */
const MAX_ROWS = 5000;
const PAGE_LIMIT = 1000;
/** Inline preview budget in rows (the JSON char budget for canvas spill is separate). */
const PREVIEW_ROWS = 100;
/** Rows rendered as text in `content[]`. The rest of the preview stays in `structuredContent`. */
const DISPLAY_ROWS = 20;

const dateRegex = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2}Z)?$/;
const dateOnlyRegex = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Expand an accepted range bound to a full UTC timestamp. A date-only bound names
 * a whole day, so a lower bound opens at midnight and an upper bound closes at the
 * last second — which is what the "inclusive" in both field descriptions promises,
 * and what keeps a same-day date-only range from collapsing to zero width (OpenAQ
 * rejects `from == to` with a 422). Explicit timestamps pass through untouched.
 *
 * Normalizing both bounds to one fixed-width format also makes the ordering check
 * a plain lexicographic compare — for `YYYY-MM-DDTHH:MM:SSZ`, string order is
 * chronological order.
 */
function normalizeBound(value: string, edge: 'start' | 'end'): string {
  if (!dateOnlyRegex.test(value)) return value;
  return edge === 'start' ? `${value}T00:00:00Z` : `${value}T23:59:59Z`;
}

/**
 * A flattened, JSON-safe measurement row — the shape staged on the canvas. The
 * index signature keeps it assignable to the canvas `RegisterRows` row type
 * (`Record<string, unknown>`) without a cast. `value` is null for a gap bucket.
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
  value: number | null;
  [key: string]: string | number | boolean | null;
}

function toSeriesRow(m: OpenAqMeasurement): SeriesRow {
  const s = m.summary;
  return {
    datetimeFrom: m.period.datetimeFrom.utc,
    datetimeTo: m.period.datetimeTo.utc,
    value: m.value ?? null,
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
    'Historical measurement series for one pollutant at one station over a date range — for trend analysis and "was last week worse than the monthly average?". Pass a locationId and a parametersId and work in stations — you get the series for that pollutant at that station. Choose aggregation: raw (every reported value), hourly, or daily — daily and hourly add a per-bucket statistical summary (min, median, max, mean, sd). Large ranges produce thousands of rows and spill to a DataCanvas: the response returns a preview plus a canvasId and table name you query with openaq_dataframe_query. Values carry their unit; the server never converts between µg/m³, ppm, and ppb.',
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
        'Start of the range, inclusive. Date "YYYY-MM-DD" (opens at 00:00:00Z that day) or full UTC "YYYY-MM-DDTHH:MM:SSZ". Omit to get the most recent values.',
      ),
    datetimeTo: z
      .string()
      .regex(dateRegex)
      .optional()
      .describe(
        'End of the range, inclusive. Date "YYYY-MM-DD" covers that whole day (closes at 23:59:59Z) or full UTC "YYYY-MM-DDTHH:MM:SSZ". Must land after datetimeFrom — the two forms mix freely, so "2026-06-25" to "2026-06-25" is a valid one-day range. Omit for "up to now".',
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
              .nullable()
              .describe(
                'Value for the bucket (the measurement for raw; the bucket aggregate for hourly/daily). Null for a gap bucket the sensor reported nothing into — the bucket is kept so the series stays evenly spaced on the time axis',
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
              .describe(
                'Per-bucket statistics — present for hourly/daily, null for raw. Every field is null in a gap bucket',
              ),
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
        'The (possibly previewed) series, newest or oldest first per the API. When truncated, this is a preview — query canvasId for the rows staged there.',
      ),
    rowCount: z.number().describe('Rows in this response (preview length when spilled)'),
    canvasId: z
      .string()
      .optional()
      .describe(
        `DataCanvas id holding the pulled series. Query with openaq_dataframe_query. The pull stops at ${MAX_ROWS} rows, so this is the whole series only when totalCount is at or below that — read the notice, which says so when the cap or a failed page cut the pull short.`,
      ),
    tableName: z
      .string()
      .optional()
      .describe(
        'Canvas table name for the staged series (e.g. "measurements_1701"). Reference it in SQL.',
      ),
    truncated: z
      .boolean()
      .optional()
      .describe(
        'True when the series exceeded the inline limit, so series is a preview and the pulled rows were staged on canvasId. Absent/false when everything fit inline. It says nothing about whether the pull itself was complete — compare rowCount and totalCount, and read the notice.',
      ),
  }),
  enrichment: {
    totalCount: z.number().describe('Total rows in the full series.'),
    notice: z
      .string()
      .optional()
      .describe(
        'What limited this response, when something did — the row cap, a failed page, or DataCanvas being unavailable — plus how to reach the rest.',
      ),
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
      when: 'The range is empty — once both bounds are expanded to full UTC timestamps, datetimeTo does not land after datetimeFrom.',
      recovery:
        'Move datetimeTo to a later instant than datetimeFrom; OpenAQ rejects a zero-width range. A date-only bound spans the whole day, so "2026-06-25" to "2026-06-25" already covers a full day.',
      retryable: false,
    },
    {
      reason: 'canvas_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'The supplied canvas_id is unknown or has expired, so the series cannot be staged onto it.',
      recovery:
        'Omit canvas_id to stage the series on a fresh canvas, or re-run the call that produced the id you meant to reuse.',
      retryable: false,
    },
    {
      reason: 'upstream_error',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'OpenAQ returned 5xx or an unreadable body on every retry.',
      recovery:
        'Retry after a short backoff; if it keeps failing, OpenAQ is degraded and the series is briefly unavailable.',
      retryable: true,
    },
    {
      reason: 'rate_limited',
      code: JsonRpcErrorCode.RateLimited,
      when: 'OpenAQ returned 429 — the request budget for this key is exhausted.',
      recovery:
        'Wait the retryAfter seconds given in data (about 60 if absent) before retrying; long raw ranges page internally and spend several requests, so prefer daily aggregation.',
      retryable: true,
    },
    {
      reason: 'upstream_timeout',
      code: JsonRpcErrorCode.Timeout,
      when: 'OpenAQ did not respond within the request timeout on every retry.',
      recovery:
        'Retry once after a short pause, then narrow the date range or switch aggregation to daily so each page is smaller.',
      retryable: true,
    },
    {
      reason: 'invalid_api_key',
      code: JsonRpcErrorCode.Unauthorized,
      when: 'OpenAQ returned 401 — the configured OPENAQ_API_KEY is missing, invalid, or revoked.',
      recovery:
        "Stop retrying — every OpenAQ call fails until the server's OPENAQ_API_KEY is replaced with a valid key from an OpenAQ Explorer account.",
      retryable: false,
    },
  ],

  async handler(input, ctx) {
    const service = getOpenAqService();

    // Expand both bounds before comparing or forwarding: the schema accepts a
    // date and a timestamp interchangeably, and OpenAQ 500s on a mixed pair.
    const datetimeFrom = input.datetimeFrom
      ? normalizeBound(input.datetimeFrom, 'start')
      : undefined;
    const datetimeTo = input.datetimeTo ? normalizeBound(input.datetimeTo, 'end') : undefined;

    if (datetimeFrom && datetimeTo && datetimeTo <= datetimeFrom) {
      throw ctx.fail('invalid_date_range', `Range ${datetimeFrom} to ${datetimeTo} is empty.`, {
        datetimeFrom,
        datetimeTo,
        ...ctx.recoveryFor('invalid_date_range'),
      });
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
      throw upstreamFailure(ctx, err);
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

    /** Everything that limited this response, composed into one `notice` at the end. */
    const notices: string[] = [];

    // Page the series up to the row ceiling.
    const pageSize = Math.min(input.limit, PAGE_LIMIT);
    const allRows: SeriesRow[] = [];
    let found = 0;
    let exhausted = false;
    for (let page = 1; allRows.length < MAX_ROWS; page++) {
      let result: MeasurementsPage;
      try {
        result = await withUpstream(ctx, () =>
          service.getMeasurements(
            sensor.id,
            {
              ...(datetimeFrom ? { datetimeFrom } : {}),
              ...(datetimeTo ? { datetimeTo } : {}),
              aggregation: input.aggregation,
              limit: pageSize,
              page,
            },
            ctx,
          ),
        );
      } catch (err) {
        // Rows already pulled are good data. Losing them because a later page
        // failed serves nobody — keep them, and say what was lost and why.
        if (allRows.length === 0) throw err;
        ctx.log.warning('Measurement paging stopped early on a page failure', {
          sensorId: sensor.id,
          page,
          rowsCollected: allRows.length,
          error: err instanceof Error ? err.message : String(err),
        });
        notices.push(
          `Series is partial — page ${page} failed (${err instanceof Error ? err.message : String(err)}), so it stops at ${allRows.length} rows. OpenAQ times out once the page offset gets deep; pull the rest in shorter date windows, or use a coarser aggregation so the whole span fits in fewer pages.`,
        );
        break;
      }
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

    if (allRows.length >= MAX_ROWS) {
      // There is no page/offset input, so the rows past the cap are reachable
      // only by re-slicing the range — which nothing else in the response says.
      const ofTotal = Number.isFinite(totalRows) ? ` of ${totalRows}` : '';
      notices.push(
        `Pull capped at ${MAX_ROWS} rows${ofTotal} — this series is not complete. Split the date range into shorter windows, or use hourly/daily aggregation to fit the whole span under the cap.`,
      );
    }

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

    /** Canvas pointers, set only when staging succeeded. */
    let spill: { canvasId: string; tableName: string } | undefined;

    if (!overflow) {
      ctx.log.info('Measurement series fit inline', { sensorId: sensor.id, rows: allRows.length });
    } else {
      // Series overflows the inline preview — stage the pulled rows on the canvas
      // if one is available. A canvas that cannot be reached degrades the response
      // rather than failing it: the rows are already fetched either way.
      const canvas = getCanvas();
      if (!canvas) {
        notices.push(
          `Series truncated to ${PREVIEW_ROWS} of ${allRows.length} rows — enable DataCanvas (CANVAS_PROVIDER_TYPE=duckdb) to query them all, or narrow the range / use daily aggregation. Rows ${PREVIEW_ROWS + 1}–${allRows.length} are not in this response.`,
        );
        ctx.log.info('Measurement series truncated (no canvas)', {
          sensorId: sensor.id,
          rows: allRows.length,
        });
      } else {
        try {
          const instance = await canvas.acquire(input.canvas_id, ctx);
          const tableName = `measurements_${sensor.id}`;
          await instance.drop(tableName); // idempotent re-stage when reusing a canvas
          const handle = await instance.registerTable(tableName, allRows, { signal: ctx.signal });
          spill = { canvasId: instance.canvasId, tableName: handle.tableName };
          ctx.log.info('Measurement series staged on canvas', {
            sensorId: sensor.id,
            canvasId: instance.canvasId,
            tableName: handle.tableName,
            rows: handle.rowCount,
          });
        } catch (err) {
          // A canvas_id the caller supplied and we cannot resolve is their input
          // to fix, so it stays an error with the contract's recovery hint.
          if (input.canvas_id !== undefined && isNotFound(err)) {
            throw ctx.fail(
              'canvas_not_found',
              `DataCanvas ${input.canvas_id} is unknown or has expired.`,
              { canvasId: input.canvas_id, ...ctx.recoveryFor('canvas_not_found') },
              { cause: err },
            );
          }
          ctx.log.warning('DataCanvas staging failed — returning the truncated preview', {
            sensorId: sensor.id,
            rows: allRows.length,
            error: err instanceof Error ? err.message : String(err),
          });
          notices.push(
            `DataCanvas is configured but could not stage the series (${err instanceof Error ? err.message : String(err)}), so this response is capped at ${PREVIEW_ROWS} of ${allRows.length} rows. Narrow the range or use daily aggregation to fit the series inline, or fix the canvas provider to query it all.`,
          );
        }
      }
    }

    if (notices.length > 0) ctx.enrich.notice(notices.join(' '));

    return {
      ...base,
      ...spill,
      ...(overflow ? { truncated: true } : {}),
    };
  },

  format: (result) => {
    const head = `## ${result.location.name} (id ${result.location.id}) — ${result.parameter.displayName ?? result.parameter.name} (\`${result.parameter.name}\` #${result.parameter.id}, ${result.parameter.unit})`;

    const displayed = result.series.slice(0, DISPLAY_ROWS);
    const hidden = result.series.length - displayed.length;
    const count =
      hidden > 0
        ? `${displayed.length} of ${result.rowCount} ${result.truncated ? 'preview ' : ''}rows shown`
        : `${result.rowCount} rows shown`;
    const meta = `aggregation: ${result.aggregation} · sensor ${result.sensorId} · ${count}`;

    const spill = result.truncated
      ? result.canvasId
        ? `\n**Truncated** — series staged on canvas \`${result.canvasId}\`, table \`${result.tableName}\`. Query with openaq_dataframe_query.`
        : '\n**Truncated** — preview only; DataCanvas is unavailable, so nothing past this preview is retrievable from this response.'
      : '';

    const rows = displayed
      .map((r) => {
        // A gap bucket carries no value, so it carries no unit either.
        const reading =
          r.value == null ? 'no data' : `${displayNumber(r.value)} ${result.parameter.unit}`;
        const stats = r.summary
          ? ` (min ${displayNumber(r.summary.min)}, median ${displayNumber(r.summary.median)}, max ${displayNumber(r.summary.max)}, avg ${displayNumber(r.summary.avg)}, sd ${displayNumber(r.summary.sd)})`
          : '';
        const cov =
          r.percentComplete != null ? ` · ${displayNumber(r.percentComplete)}% complete` : '';
        const flag = r.flagged ? ' · flagged' : '';
        return `- ${r.datetimeFrom} → ${r.datetimeTo}: ${reading}${stats}${cov}${flag}`;
      })
      .join('\n');

    const rest =
      hidden > 0
        ? `\n\n_${hidden} further row${hidden === 1 ? '' : 's'} of this ${result.truncated ? 'preview' : 'series'} are in structuredContent.series but not rendered here._`
        : '';

    return [{ type: 'text', text: [head, meta + spill, '', rows].join('\n') + rest }];
  },
});
