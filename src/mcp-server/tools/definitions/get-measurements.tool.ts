/**
 * @fileoverview openaq_get_measurements — historical measurement series for one
 * pollutant at one station over a date range. Resolves the station's sensor for
 * the parameter internally (v3 series are sensor-scoped). The pulled rows stage on
 * a DataCanvas whenever the series overflows the inline preview or the caller
 * supplied a canvas_id: the response then carries a canvasId + table name to read
 * with openaq_dataframe_describe, then openaq_dataframe_query. One table per
 * sensor, so re-staging the same sensor on a canvas overwrites its earlier series.
 * The pull is bounded at exactly MAX_ROWS and can also stop on a failed page, so
 * pulledCount / pullComplete report what was actually collected and totalCount is
 * a floor whenever OpenAQ answered with a ">N" lower bound. A date-only bound is
 * the station's local calendar day, resolved from the timezone on the location
 * lookup the handler already makes; the bounds sent upstream come back as
 * effectiveRange, and hourly/daily series report their missing intervals. Values
 * carry their unit; units are never converted.
 * @module mcp-server/tools/definitions/get-measurements.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { CanvasIdSchema } from '@cyanheads/mcp-ts-core/canvas';
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
/** Missing intervals listed in `gaps`; `gapCount` stays exact past it. */
const MAX_LISTED_GAPS = 20;

const dateRegex = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2}Z)?$/;
const dateOnlyRegex = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;

/** True for a supplied `YYYY-MM-DD` bound — a whole station-local day, not an instant. */
const isDateOnly = (bound: string | undefined): boolean =>
  bound !== undefined && dateOnlyRegex.test(bound);

/** An instant as `YYYY-MM-DDTHH:MM:SSZ` — the fixed-width form OpenAQ accepts. */
const toUtcSeconds = (ms: number): string => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');

/**
 * A range bound: `dateRegex` checks the shape, and the refine checks that it
 * names a real calendar date and time. `Date.parse` rolls "2026-02-30" over to March 2 and
 * returns NaN for month 13, so the parsed instant must print back as the input —
 * otherwise the local-day expansion would send a garbage instant or throw.
 */
const rangeBound = z
  .string()
  .regex(dateRegex, { abort: true })
  .refine(
    (bound) => {
      const ms = Date.parse(isDateOnly(bound) ? `${bound}T00:00:00Z` : bound);
      return !Number.isNaN(ms) && toUtcSeconds(ms).startsWith(bound);
    },
    { message: 'Not a real calendar date or time — check the month, day, and hour.' },
  );

const dayFormatters = new Map<string, Intl.DateTimeFormat>();

/**
 * A formatter that reads the calendar date at an instant in `timeZone`, cached per
 * zone. Undefined when the runtime does not recognize the zone name.
 */
function dayFormatter(timeZone: string): Intl.DateTimeFormat | undefined {
  let formatter = dayFormatters.get(timeZone);
  if (!formatter) {
    try {
      formatter = new Intl.DateTimeFormat('en-US', {
        timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      });
    } catch (err) {
      if (err instanceof RangeError) return;
      throw err;
    }
    dayFormatters.set(timeZone, formatter);
  }
  return formatter;
}

/** The calendar date at `ms` as `YYYY-MM-DD`, read by `formatter`. */
function localDate(formatter: Intl.DateTimeFormat, ms: number): string {
  const parts = formatter.formatToParts(ms);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}

/**
 * The first instant of calendar day `day` in the formatter's zone, found by
 * bisecting on "the local date here is `day` or later". Every zone's offset lies
 * within UTC−12…UTC+14, so that instant falls inside a window around `day`
 * 00:00Z. Bisection needs no offset arithmetic, so it also lands correctly on a
 * day whose midnight is skipped (the day opens at the transition, e.g. 01:00) or
 * repeated (the first 00:00).
 */
function localDayStart(day: string, formatter: Intl.DateTimeFormat): number {
  const utcMidnight = Date.parse(`${day}T00:00:00Z`) / 1000;
  let before = utcMidnight - 15 * 3600; // local date is still the previous day
  let onOrAfter = utcMidnight + 13 * 3600; // local date has reached `day`
  while (onOrAfter - before > 1) {
    const mid = Math.floor((before + onOrAfter) / 2);
    if (localDate(formatter, mid * 1000) >= day) onOrAfter = mid;
    else before = mid;
  }
  return onOrAfter * 1000;
}

/**
 * Expand the accepted bounds to the UTC instants sent upstream. A date-only bound
 * names the station's local calendar day: `datetimeFrom` opens at its local
 * midnight and `datetimeTo` closes at the next one. OpenAQ labels an hour by its
 * end and treats `datetime_to` as inclusive, so closing at the next midnight keeps
 * the day's last hour, and a DST day spans 23 or 25 hours. Without a usable
 * `formatter` (no station timezone, or one the runtime does not know) the day is
 * a UTC day. Explicit timestamps pass through untouched. Both bounds come out
 * fixed-width, so string order is chronological order.
 */
function resolveBounds(
  bounds: { datetimeFrom?: string | undefined; datetimeTo?: string | undefined },
  formatter: Intl.DateTimeFormat | undefined,
): { datetimeFrom?: string; datetimeTo?: string } {
  const dayStart = (day: string) =>
    toUtcSeconds(formatter ? localDayStart(day, formatter) : Date.parse(`${day}T00:00:00Z`));
  const nextDay = (day: string) =>
    toUtcSeconds(Date.parse(`${day}T00:00:00Z`) + DAY_MS).slice(0, 10);
  const { datetimeFrom, datetimeTo } = bounds;
  return {
    ...(datetimeFrom && {
      datetimeFrom: isDateOnly(datetimeFrom) ? dayStart(datetimeFrom) : datetimeFrom,
    }),
    ...(datetimeTo && {
      datetimeTo: isDateOnly(datetimeTo) ? dayStart(nextDay(datetimeTo)) : datetimeTo,
    }),
  };
}

/** A UTC span, as `gaps` lists it. */
interface Span {
  datetimeFrom: string;
  datetimeTo: string;
}

/**
 * Missing intervals inside an hourly/daily series, oldest first: the span between
 * two buckets that do not touch, plus the period of any bucket with no value,
 * merged where they are contiguous. Buckets are compared by their own UTC
 * boundaries, which OpenAQ already stretches or shrinks across a DST change, so
 * the walk does no fixed-length arithmetic — and an overlap (OpenAQ returns one
 * around spring-forward) counts as covered. Only interior spans count: the stretch
 * between a requested bound and the first or last bucket is not a gap.
 */
function findGaps(rows: readonly SeriesRow[]): Span[] {
  const buckets = rows
    .map((r) => ({
      from: Date.parse(r.datetimeFrom),
      to: Date.parse(r.datetimeTo),
      empty: r.value === null,
    }))
    .sort((a, b) => a.from - b.from);
  const gaps: { from: number; to: number }[] = [];
  const add = (from: number, to: number) => {
    const last = gaps.at(-1);
    if (last && from <= last.to) last.to = Math.max(last.to, to);
    else gaps.push({ from, to });
  };
  let covered: number | undefined;
  for (const b of buckets) {
    if (covered !== undefined && b.from > covered) add(covered, b.from);
    if (b.empty) add(b.from, b.to);
    covered = Math.max(covered ?? b.to, b.to);
  }
  return gaps.map((g) => ({ datetimeFrom: toUtcSeconds(g.from), datetimeTo: toUtcSeconds(g.to) }));
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
    'Historical measurement series for one pollutant at one station over a date range — for trend analysis and "was last week worse than the monthly average?". Pass a locationId and a parametersId and work in stations — you get the series for that pollutant at that station. Choose aggregation: raw (every reported value), hourly, or daily — daily and hourly add a per-bucket statistical summary (min, median, max, mean, sd). A date-only bound means the station\'s local calendar day. Large ranges produce thousands of rows and stage on a DataCanvas: the response returns a preview plus a canvasId and table name — call openaq_dataframe_describe on the canvasId for the table\'s columns, then openaq_dataframe_query to run SQL over it. Passing a canvas_id stages the series there whatever its size, so two stations land on one canvas for a side-by-side comparison. Values carry their unit; the server never converts between µg/m³, ppm, and ppb.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  input: z.object({
    locationId: z.number().int().positive().describe('Station id from openaq_find_locations.'),
    parametersId: z
      .number()
      .int()
      .positive()
      .describe(
        "Parameter id to pull the series for (e.g. 2 = PM2.5 µg/m³). Get ids from openaq_list_parameters. Must be a parameter the station measures — find_locations lists each station's parameters.",
      ),
    datetimeFrom: rangeBound
      .optional()
      .describe(
        'Start of the range, inclusive. A date "YYYY-MM-DD" opens at local midnight of that day in the station\'s timezone (UTC midnight when OpenAQ lists none); a full UTC "YYYY-MM-DDTHH:MM:SSZ" is sent as is. Omit to start from the sensor\'s earliest data — the series runs oldest first, so on a long-running station an open start fills the row cap with its oldest values; set datetimeFrom to reach recent ones. effectiveRange echoes the instant sent.',
      ),
    datetimeTo: rangeBound
      .optional()
      .describe(
        'End of the range, inclusive. A date "YYYY-MM-DD" covers that whole station-local day, closing at the next local midnight, so a DST day spans 23 or 25 hours; a full UTC "YYYY-MM-DDTHH:MM:SSZ" is sent as is. Must land after datetimeFrom — the two forms mix freely, so "2026-06-25" to "2026-06-25" is a valid one-day range. Omit for "up to now". effectiveRange echoes the instant sent.',
      ),
    aggregation: z
      .enum(['raw', 'hourly', 'daily'])
      .default('raw')
      .describe(
        'Time bucketing. "raw" = every reported value (often hourly at source). "hourly"/"daily" = server-side rollups with a statistical summary per bucket; an hour is labeled by the time it ends, and a day is the station\'s local calendar day. Use "daily" for multi-month trends to keep the series small; "raw" for fine-grained recent analysis.',
      ),
    limit: z
      .number()
      .int()
      .min(1)
      .max(1000)
      .default(1000)
      .describe(
        `Max rows per page from the API (1–1000). Default 1000. The tool pages internally up to the ${MAX_ROWS}-row pull ceiling.`,
      ),
    canvas_id: CanvasIdSchema.optional().describe(
      "DataCanvas id from a prior openaq_get_measurements call, to put this series on the same canvas (e.g. to compare two stations' series side by side). Supplying it stages the series whatever its size. Reuse stages one table per sensor, so a second sensor adds a table while the same sensor overwrites its earlier series — the response says so when that happens. Omit to start fresh; the response returns a new canvas_id when the series overflows the inline preview.",
    ),
  }),
  output: z.object({
    location: z
      .object({
        id: z.number().describe('Station id'),
        name: z.string().describe('Station name'),
        provider: z
          .string()
          .nullable()
          .describe(
            'Network that operates the station — cite it alongside OpenAQ. Null when OpenAQ lists none.',
          ),
        providerId: z
          .number()
          .nullable()
          .describe(
            'Provider id, usable as providersId in openaq_find_locations. Null when OpenAQ lists none.',
          ),
        timezone: z
          .string()
          .nullable()
          .describe(
            'IANA timezone of the station (e.g. "America/Los_Angeles"). Daily buckets and date-only bounds follow its calendar days. Null when OpenAQ lists none.',
          ),
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
              .describe(
                'Coverage of the bucket as OpenAQ reports it — observed readings as a percentage of expected ones. Low values flag gappy data. Usually 0–100, but it exceeds 100 when a bucket holds more readings than expected, e.g. 200 on the hour a DST fall-back repeats',
              ),
            flagged: z
              .boolean()
              .describe('True if the source flagged this value (quality concern)'),
          })
          .describe('One bucket in the series, with its value and (for rollups) statistics'),
      )
      .describe(
        'The (possibly previewed) series in the order OpenAQ returns it (oldest first). An hourly/daily series either skips a missing bucket or returns it with a null value — gapCount and gaps report both. Every row here is also rendered in the text output. When truncated, this is a preview of pulledCount rows — query canvasId for the rest.',
      ),
    rowCount: z.number().describe('Rows in this response (preview length when spilled)'),
    pulledCount: z
      .number()
      .describe(
        `Rows pulled from OpenAQ, at most ${MAX_ROWS} — the canvas table's row count when canvasId is present. Equals rowCount when the whole series fit inline; larger when series is a preview.`,
      ),
    pullComplete: z
      .boolean()
      .describe(
        `True when pulledCount is the whole series for the requested range. False when the ${MAX_ROWS}-row cap or a failed page stopped the pull early — the rows past that point are in neither this response nor the canvas table, and the notice says how to reach them.`,
      ),
    canvasId: z
      .string()
      .optional()
      .describe(
        "DataCanvas id holding the staged series — pulledCount rows of it. Call openaq_dataframe_describe on this id for the table's columns, then openaq_dataframe_query to run SQL. Present whenever staging succeeded, which includes a series that fit inline on a canvas_id you supplied.",
      ),
    tableName: z
      .string()
      .optional()
      .describe(
        'Canvas table holding the staged series (e.g. "measurements_1701"). openaq_dataframe_describe lists its columns; reference this name in openaq_dataframe_query SQL. One table per sensor, so re-staging the same sensor on this canvas overwrites it.',
      ),
    truncated: z
      .boolean()
      .optional()
      .describe(
        'True when the series exceeded the inline limit, so series is a preview of the pulled rows. Absent/false when every pulled row is inline. It describes the preview only — canvasId reports whether the rows were staged, and pullComplete whether the pull itself finished.',
      ),
  }),
  enrichment: {
    totalCount: z
      .number()
      .describe(
        'Rows in the full series for this range. A floor rather than an exact count when totalCountIsLowerBound is set; never below pulledCount.',
      ),
    totalCountIsLowerBound: z
      .boolean()
      .optional()
      .describe(
        'Set when totalCount is only a floor: the pull stopped early and OpenAQ reported the range total as ">N" instead of an exact number, so more rows exist than totalCount states. Absent when the count is exact.',
      ),
    effectiveRange: z
      .object({
        datetimeFrom: z
          .string()
          .nullable()
          .describe('Lower bound sent to OpenAQ, UTC. Null when datetimeFrom was omitted.'),
        datetimeTo: z
          .string()
          .nullable()
          .describe('Upper bound sent to OpenAQ, UTC. Null when datetimeTo was omitted.'),
      })
      .describe(
        "The range sent to OpenAQ as UTC instants — date-only bounds expanded to the station's local day.",
      ),
    gapCount: z
      .number()
      .optional()
      .describe(
        'Missing intervals inside an hourly or daily series — a span between buckets that do not touch, or a bucket with a null value, merged where contiguous — counted over every pulled row, not only the preview. 0 when nothing is missing; absent for raw, whose rows follow no fixed cadence.',
      ),
    gaps: z
      .array(
        z
          .object({
            datetimeFrom: z.string().describe('Start of the missing interval, UTC'),
            datetimeTo: z.string().describe('End of the missing interval, UTC'),
          })
          .describe('One missing interval'),
      )
      .optional()
      .describe(
        `The first ${MAX_LISTED_GAPS} missing intervals, oldest first. Omitted when gapCount is 0.`,
      ),
    notice: z
      .string()
      .optional()
      .describe(
        'What limited this response or where the rest of it lives — the row cap, a failed page, a station with no timezone, an edge bucket clipped by the range, missing intervals, DataCanvas being unavailable, or the canvas table the series was staged on and the tools that read it.',
      ),
  },
  enrichmentTrailer: {
    effectiveRange: {
      render: (range) =>
        `**Range sent to OpenAQ:** ${range.datetimeFrom ?? '(no lower bound)'} → ${range.datetimeTo ?? '(no upper bound)'}`,
    },
    gapCount: { label: 'Missing intervals' },
    gaps: {
      // Typed optional because the field is; the trailer only renders a present value.
      render: (gaps = []) =>
        [
          `**Missing interval spans${gaps.length === MAX_LISTED_GAPS ? ` (first ${MAX_LISTED_GAPS})` : ''}:**`,
          ...gaps.map((g) => `- ${g.datetimeFrom} → ${g.datetimeTo}`),
        ].join('\n'),
    },
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
      when: "The range is empty — once date-only bounds are expanded to the station's local day, datetimeTo does not land after datetimeFrom.",
      recovery:
        'Move datetimeTo to a later instant than datetimeFrom; OpenAQ rejects a zero-width range. A date-only bound spans the whole station-local day, so "2026-06-25" to "2026-06-25" already covers a full day.',
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
      thrownBy: 'service',
    },
    {
      reason: 'rate_limited',
      code: JsonRpcErrorCode.RateLimited,
      when: 'OpenAQ returned 429 — the request budget for this key is exhausted.',
      recovery:
        'Wait the retryAfter seconds given in data (about 60 if absent) before retrying; long raw ranges page internally and spend several requests, so prefer daily aggregation.',
      retryable: true,
      thrownBy: 'service',
    },
    {
      reason: 'upstream_timeout',
      code: JsonRpcErrorCode.Timeout,
      when: 'OpenAQ did not respond within the request timeout on every retry.',
      recovery:
        'Retry once after a short pause, then narrow the date range or switch aggregation to daily so each page is smaller.',
      retryable: true,
      thrownBy: 'service',
    },
    {
      reason: 'invalid_api_key',
      code: JsonRpcErrorCode.Unauthorized,
      when: 'OpenAQ returned 401 — the configured OPENAQ_API_KEY is missing, invalid, or revoked.',
      recovery:
        "Stop retrying — every OpenAQ call fails until the server's OPENAQ_API_KEY is replaced with a valid key from an OpenAQ Explorer account.",
      retryable: false,
      thrownBy: 'service',
    },
  ],

  async handler(input, ctx) {
    const service = getOpenAqService();

    // Two bounds of the same form order the same way in every timezone — a date
    // pair spans the first date's start to the second date's end — so an inverted
    // pair fails here, before any request. A mixed pair needs the station's
    // timezone and is checked once the location is in hand.
    const { datetimeFrom: fromInput, datetimeTo: toInput } = input;
    if (fromInput && toInput && isDateOnly(fromInput) === isDateOnly(toInput)) {
      const empty = isDateOnly(fromInput) ? toInput < fromInput : toInput <= fromInput;
      if (empty) {
        throw ctx.fail('invalid_date_range', `Range ${fromInput} to ${toInput} is empty.`, {
          datetimeFrom: fromInput,
          datetimeTo: toInput,
          ...ctx.recoveryFor('invalid_date_range'),
        });
      }
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

    // Expand both bounds before comparing or forwarding: a date names the
    // station's local day, and OpenAQ 500s on a mixed date/timestamp pair.
    const formatter = location.timezone === null ? undefined : dayFormatter(location.timezone);
    const { datetimeFrom, datetimeTo } = resolveBounds(input, formatter);
    if (datetimeFrom && datetimeTo && datetimeTo <= datetimeFrom) {
      // Only a mixed pair reaches here, so one bound was a date the caller never
      // saw expanded — name the zone that moved it.
      const readAs = formatter
        ? `date-only bounds open and close at local midnight in ${location.timezone}`
        : 'date-only bounds were read as UTC days';
      throw ctx.fail(
        'invalid_date_range',
        `Range ${datetimeFrom} to ${datetimeTo} is empty — ${readAs}.`,
        { datetimeFrom, datetimeTo, ...ctx.recoveryFor('invalid_date_range') },
      );
    }
    ctx.enrich({
      effectiveRange: { datetimeFrom: datetimeFrom ?? null, datetimeTo: datetimeTo ?? null },
    });

    /**
     * Notice segments, in reading order. `ctx.enrich.notice` is last-wins, so each
     * branch writes its own slot and the handler flushes them once at the end.
     */
    const notices = {
      timezone: '',
      pull: '',
      clipped: '',
      gaps: '',
      canvas: '',
    };

    /** The next coarser aggregation a notice can suggest — none past daily. */
    const coarser = { raw: 'hourly/daily', hourly: 'daily', daily: undefined }[input.aggregation];

    if ((isDateOnly(fromInput) || isDateOnly(toInput)) && !formatter) {
      const why =
        location.timezone === null
          ? `OpenAQ lists no timezone for station ${location.id}`
          : `Station ${location.id}'s timezone "${location.timezone}" is not one this server recognizes`;
      notices.timezone = `${why}, so the date-only bounds were read as UTC days (00:00Z to the next 00:00Z) and may not line up with its daily buckets.`;
    }

    // Page the series up to the row ceiling. The last page can carry it past the
    // ceiling when `limit` does not divide it; the excess is sliced off below.
    const pageSize = Math.min(input.limit, PAGE_LIMIT);
    const fetched: SeriesRow[] = [];
    let found = 0;
    let foundIsLowerBound = false;
    let exhausted = false;
    let failure: { message: string; page: number } | undefined;
    for (let page = 1; fetched.length < MAX_ROWS; page++) {
      // Covers an abort that lands between pages, when no fetch is in flight.
      ctx.signal.throwIfAborted();
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
        // An abort almost always lands inside the fetch above rather than
        // between pages, so it surfaces here as a rejection. Rethrow it before
        // the degradation path recasts a cancellation as an OpenAQ outage.
        ctx.signal.throwIfAborted();
        // Rows already pulled are good data. Losing them because a later page
        // failed serves nobody — keep them, and say what was lost and why.
        if (fetched.length === 0) throw err;
        failure = { page, message: err instanceof Error ? err.message : String(err) };
        ctx.log.warning('Measurement paging stopped early on a page failure', {
          sensorId: sensor.id,
          page,
          rowsCollected: fetched.length,
          error: failure.message,
        });
        break;
      }
      found = result.found;
      foundIsLowerBound = result.foundIsLowerBound;
      fetched.push(...result.results.map(toSeriesRow));
      if (result.results.length < pageSize) {
        exhausted = true;
        break;
      }
    }

    if (fetched.length === 0) {
      throw ctx.fail(
        'no_data_for_range',
        `Sensor ${sensor.id} has no data for the requested range.`,
        {
          sensorId: sensor.id,
          ...ctx.recoveryFor('no_data_for_range'),
        },
      );
    }

    // The series length is known when the pager saw a short page, or when OpenAQ
    // gave an exact total that the rows in hand match — the hourly/daily rollups
    // report one, while raw answers a full page with ">limit" — so a series that
    // ends exactly on a page boundary is not misread as cut off. A known length is
    // the exact total whatever else `meta.found` claimed. Otherwise the total is
    // the upstream figure floored at the rows fetched, flagged as a floor when
    // OpenAQ only gave a ">N" bound, so 5,001 matching rows are distinguishable
    // from 500,000. Rows sliced off at the ceiling still count toward the total —
    // they prove the series is longer — but leave the pull incomplete.
    const fetchedCount = fetched.length;
    const rows = fetched.slice(0, MAX_ROWS);
    const pulledCount = rows.length;
    const lengthKnown = exhausted || (!foundIsLowerBound && found === fetchedCount);
    const pullComplete = lengthKnown && fetchedCount <= MAX_ROWS;
    const totalCount = lengthKnown ? fetchedCount : Math.max(found, fetchedCount);
    const totalCountIsLowerBound = !lengthKnown && foundIsLowerBound;
    ctx.enrich.total(totalCount);
    if (totalCountIsLowerBound) ctx.enrich({ totalCountIsLowerBound: true });

    if (failure && !pullComplete) {
      notices.pull = `Series is partial — page ${failure.page} failed (${failure.message}), so it stops at ${pulledCount} rows. OpenAQ times out once the page offset gets deep; pull the rest in shorter date windows${coarser ? ', or use a coarser aggregation so the whole span fits in fewer pages' : ''}.`;
    } else if (!pullComplete) {
      // There is no page/offset input, so the rows past the cap are reachable
      // only by re-slicing the range — which nothing else in the response says.
      // A total no higher than the rows in hand adds nothing to "not complete".
      const ofTotal =
        totalCount > pulledCount
          ? ` of ${totalCountIsLowerBound ? 'at least ' : ''}${totalCount}`
          : '';
      notices.pull = `Pull capped at ${MAX_ROWS} rows${ofTotal} — this series is not complete. Split the date range into shorter windows${coarser ? `, or use ${coarser} aggregation to fit the whole span under the cap` : ' to reach the rest'}.`;
    }

    if (input.aggregation !== 'raw') {
      const unit = input.aggregation === 'daily' ? 'day' : 'hour';
      const first = rows.reduce((a, b) =>
        Date.parse(b.datetimeFrom) < Date.parse(a.datetimeFrom) ? b : a,
      );
      const last = rows.reduce((a, b) =>
        Date.parse(b.datetimeTo) > Date.parse(a.datetimeTo) ? b : a,
      );
      const startsEarly =
        datetimeFrom !== undefined && Date.parse(first.datetimeFrom) < Date.parse(datetimeFrom);
      const endsLate =
        datetimeTo !== undefined && Date.parse(last.datetimeTo) > Date.parse(datetimeTo);
      const edges = [
        startsEarly
          ? `the first bucket (${first.datetimeFrom} → ${first.datetimeTo}) starts before datetimeFrom`
          : '',
        endsLate
          ? `the last bucket (${last.datetimeFrom} → ${last.datetimeTo}) ends after datetimeTo`
          : '',
      ].filter(Boolean);
      if (edges.length > 0) {
        // Date-only bounds are the fix only for an edge an explicit timestamp cut,
        // and only when the station's zone is known. A date-only edge that still
        // clips is OpenAQ's own bucket overrunning the day (the 47-hour bucket
        // before spring-forward); a zone-less station is covered by the timezone
        // segment. Hourly buckets follow local hours too — :15 UTC at UTC+05:45.
        const cutByTimestamp =
          (startsEarly && !isDateOnly(fromInput)) || (endsLate && !isDateOnly(toInput));
        const hint =
          cutByTimestamp && formatter
            ? " Date-only bounds align with the station's local days and hours."
            : '';
        notices.clipped = `The range clips its edge ${edges.length > 1 ? 'buckets' : 'bucket'}: ${edges.join(' and ')}, so ${edges.length > 1 ? 'each' : 'that bucket'} aggregates only the ${input.aggregation === 'daily' ? 'hours' : 'readings'} inside the range, not a whole ${unit}.${hint}`;
      }

      const gaps = findGaps(rows);
      ctx.enrich({
        gapCount: gaps.length,
        ...(gaps.length > 0 && { gaps: gaps.slice(0, MAX_LISTED_GAPS) }),
      });
      const [firstGap] = gaps;
      if (firstGap) {
        const span = `${firstGap.datetimeFrom} → ${firstGap.datetimeTo}`;
        notices.gaps =
          gaps.length === 1
            ? `1 missing interval among the ${pulledCount} ${input.aggregation} buckets pulled: ${span}.`
            : `${gaps.length} missing intervals among the ${pulledCount} ${input.aggregation} buckets pulled, the first ${span}.${gaps.length > MAX_LISTED_GAPS ? ` The gaps field lists the first ${MAX_LISTED_GAPS} of ${gaps.length}.` : ''}`;
      }
    }

    const parameterOut = {
      id: sensor.parameter.id,
      name: sensor.parameter.name,
      unit: sensor.parameter.units,
      displayName: sensor.parameter.displayName,
    };
    const locationOut = {
      id: location.id,
      name: location.name ?? `location ${location.id}`,
      provider: location.provider?.name ?? null,
      providerId: location.provider?.id ?? null,
      timezone: location.timezone,
    };

    const overflow = pulledCount > PREVIEW_ROWS;
    const previewRows = overflow ? rows.slice(0, PREVIEW_ROWS) : rows;
    const base = {
      location: locationOut,
      parameter: parameterOut,
      sensorId: sensor.id,
      aggregation: input.aggregation,
      series: previewRows.map((r) => toOutputRow(r, input.aggregation)),
      rowCount: previewRows.length,
      pulledCount,
      pullComplete,
    };

    /** Canvas pointers, set only when staging succeeded. */
    let spill: { canvasId: string; tableName: string } | undefined;

    // A supplied canvas_id is a request to put this series on that canvas at any
    // size — a side-by-side comparison needs both series there, and a caller
    // cannot join against a canvas the call silently skipped. With no id, only an
    // overflowing series needs one, so a small pull burns no tenant canvas slot.
    if (!overflow && input.canvas_id === undefined) {
      ctx.log.info('Measurement series fit inline', { sensorId: sensor.id, rows: pulledCount });
    } else {
      /** What a response that failed to stage still holds, for the notice wording. */
      const inlineState = overflow
        ? `this response is capped at ${PREVIEW_ROWS} of ${pulledCount} rows`
        : `the ${pulledCount}-row series is inline here but staged nowhere`;
      /** A caller who named a canvas is told what became of it, on every degraded path. */
      const notReused =
        input.canvas_id === undefined ? '' : `Canvas ${input.canvas_id} could not be reused: `;
      // A canvas that cannot be reached degrades the response rather than failing
      // it: the rows are already fetched either way.
      const canvas = getCanvas();
      if (!canvas) {
        notices.canvas = overflow
          ? `${notReused}DataCanvas is not enabled (CANVAS_PROVIDER_TYPE=duckdb), so ${inlineState}. Enable it to query them all, or narrow the range${coarser ? ' / use daily aggregation' : ''}. Rows ${PREVIEW_ROWS + 1}–${pulledCount} are not in this response.`
          : `${notReused}DataCanvas is not enabled (CANVAS_PROVIDER_TYPE=duckdb), so ${inlineState}. Enable it to stage series side by side and query them together.`;
        ctx.log.info('Measurement series not staged (no canvas)', {
          sensorId: sensor.id,
          rows: pulledCount,
        });
      } else {
        try {
          const instance = await canvas.acquire(input.canvas_id, ctx);
          const tableName = `measurements_${sensor.id}`;
          // Idempotent re-stage when reusing a canvas. `drop` reports whether a
          // table was actually removed — that is the replacement to disclose.
          const replaced = await instance.drop(tableName);
          const handle = await instance.registerTable(tableName, rows, { signal: ctx.signal });
          spill = { canvasId: instance.canvasId, tableName: handle.tableName };
          // The response that mints the handle is where an agent learns the
          // handle exists. describe() comes first because the staged table is
          // flat (min, sd) while `series` is nested (summary.min), so SQL written
          // from the response shape alone names columns that do not exist.
          notices.canvas = `Series staged on this canvas as table ${handle.tableName} (${handle.rowCount} rows). Call openaq_dataframe_describe with this canvas_id to see the table's columns, then openaq_dataframe_query to run SQL over it.${
            replaced
              ? ` This replaced the earlier ${handle.tableName} series staged on the canvas — one table per sensor, so re-staging the same sensor overwrites it.`
              : ''
          }`;
          ctx.log.info('Measurement series staged on canvas', {
            sensorId: sensor.id,
            canvasId: instance.canvasId,
            tableName: handle.tableName,
            rows: handle.rowCount,
            replaced,
          });
        } catch (err) {
          // Staging aborts on the same signal; a cancelled request must not be
          // reported to the operator as a DataCanvas failure.
          ctx.signal.throwIfAborted();
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
          ctx.log.warning('DataCanvas staging failed — returning the rows already pulled', {
            sensorId: sensor.id,
            rows: pulledCount,
            error: err instanceof Error ? err.message : String(err),
          });
          notices.canvas = `${notReused}DataCanvas is configured but could not stage the series (${err instanceof Error ? err.message : String(err)}), so ${inlineState}. ${overflow ? `Narrow the range${coarser ? ' or use daily aggregation' : ''} to fit the series inline, or fix` : 'Fix'} the canvas provider to stage it.`;
        }
      }
    }

    const notice = Object.values(notices).filter(Boolean).join(' ');
    if (notice) ctx.enrich.notice(notice);

    return {
      ...base,
      ...spill,
      ...(overflow ? { truncated: true } : {}),
    };
  },

  format: (result) => {
    const { location } = result;
    const head = `## ${location.name} (id ${location.id}) — ${result.parameter.displayName ?? result.parameter.name} (\`${result.parameter.name}\` #${result.parameter.id}, ${result.parameter.unit})`;
    const station = `provider: ${location.provider === null ? 'not listed by OpenAQ' : `${location.provider} (providerId ${location.providerId})`} · timezone: ${location.timezone ?? 'not listed by OpenAQ'}`;

    const pull = `${result.pulledCount} pulled · pull ${result.pullComplete ? 'complete' : 'incomplete'}`;
    const days =
      result.aggregation !== 'daily'
        ? ''
        : location.timezone === null
          ? " · days follow OpenAQ's station-local calendar; the station timezone is not listed"
          : ` · daily buckets are local calendar days in ${location.timezone}`;
    const meta = `aggregation: ${result.aggregation}${days} · sensor ${result.sensorId} · ${result.rowCount} rows shown · ${pull}`;

    // The canvas pointer stands on canvasId; the Truncated label stands on
    // truncated. A supplied canvas_id stages a series that fits inline, so the
    // two are independent.
    const spill = result.canvasId
      ? `\n${result.truncated ? '**Truncated** — series' : 'Series'} staged on canvas \`${result.canvasId}\`, table \`${result.tableName}\`. Describe it with openaq_dataframe_describe, then query it with openaq_dataframe_query.`
      : result.truncated
        ? '\n**Truncated** — preview only; DataCanvas is unavailable, so nothing past this preview is retrievable from this response.'
        : '';

    // Every row the response carries is rendered: a text-only client and a
    // structured-content client must reason over the same sample.
    const rows = result.series
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

    return [{ type: 'text', text: [head, station, meta + spill, '', rows].join('\n') }];
  },
});
