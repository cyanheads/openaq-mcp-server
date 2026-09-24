# openaq-mcp-server — Design

Global **measured** air quality via the OpenAQ v3 API — real pollutant observations from
government reference monitors and research-grade sensors worldwide. The ground-truth counterpart
to the fleet's modeled air-quality tool (`open-meteo-mcp-server`'s `openmeteo_get_air_quality`,
CAMS grid). Where the modeled tool gives a concentration anywhere on a grid, OpenAQ gives an
actual reading from a physical monitor — sparser, unevenly distributed, but real.

## MCP Surface

### Tools

| Name | Description | Key Inputs | Annotations |
|:-----|:------------|:-----------|:------------|
| `openaq_find_locations` | Find air-quality monitoring stations (measured, not modeled) near a point, in a bounding box, or by country. Returns location id, name, coordinates, distance, country, provider, the parameters each measures, and `datetimeLast`. Required first step — readings and measurements key on the location/sensor ids this returns. A missing station means no coverage, not clean air. | `coordinates`, `radius`, `bbox`, `iso`, `parametersId`, `monitor`, `mobile`, `providersId`, `limit`, `page` | `readOnlyHint`, `idempotentHint`, `openWorldHint` |
| `openaq_get_readings` | Latest measured value for every sensor at a location (or the nearest location to coordinates). Returns per parameter: value, unit, UTC + local timestamp, and the sensor id — joined so each value carries its pollutant and unit — plus the station's provider and timezone. The current-conditions tool. Recency varies by station; each value's timestamp shows whether "latest" is minutes or hours old. | `locationId` \| (`coordinates` + `parametersId`), `parametersId` | `readOnlyHint`, `idempotentHint`, `openWorldHint` |
| `openaq_get_measurements` | Historical measurement series for one parameter at a location over a date range. Resolves the location's sensor for that parameter internally (measurements are sensor-scoped in v3) so you pass a location, not a sensor. Optional `aggregation` (`raw`/`hourly`/`daily`) — `daily` adds a per-day statistical summary. The pulled rows stage on a DataCanvas when the series overflows the inline preview or a `canvas_id` was supplied; the response carries `canvasId` + `tableName` and names the path to read them — `openaq_dataframe_describe`, then `openaq_dataframe_query`. | `locationId`, `parametersId`, `datetimeFrom`, `datetimeTo`, `aggregation`, `canvasId` | `readOnlyHint`, `idempotentHint`, `openWorldHint` |
| `openaq_list_parameters` | Catalog of measurable pollutants and their canonical units: id, code, display name, unit, description (pm25, pm10, o3, no2, so2, co, bc, …). The unit-disambiguation tool — the same pollutant exists under several ids with different units (`co` is id 4 µg/m³, id 8 ppm, id 102 ppb). Call this to pick the right `parametersId` and to interpret a reading's unit. | `query` (local filter), `pollutantsOnly` | `readOnlyHint`, `idempotentHint` |
| `openaq_list_countries` | Catalog of country coverage: id, OpenAQ country code, name, station-data date span (`datetimeFirst`/`datetimeLast`), and the parameters measured anywhere in that country. Availability check before a regional `openaq_find_locations` sweep — answers "which countries have NO2 monitoring?". Pages the filtered catalog. | `query`, `parametersId` (local filters), `limit`, `page` | `readOnlyHint`, `idempotentHint` |
| `openaq_dataframe_query` | Run a read-only SQL `SELECT` against the measurement tables `openaq_get_measurements` staged on a DataCanvas. Reference tables by the name the measurements call returned (`measurements_<sensorId>`). For aggregation and cross-sensor comparison over series too large to inline. Responses are capped at 200 rows, with `truncated` and a notice naming the `ORDER BY … LIMIT … OFFSET` continuation. | `canvasId`, `sql` | `readOnlyHint` |
| `openaq_dataframe_describe` | List the tables and columns staged on a DataCanvas so you can write valid SQL for `openaq_dataframe_query` without guessing column names. | `canvasId` | `readOnlyHint` |

Five domain tools + two DataCanvas consumer tools. The canvas pair is mandatory once
`openaq_get_measurements` can emit a `canvasId` (a token with no query tool is dead output);
they only activate when `CANVAS_PROVIDER_TYPE=duckdb`.

### Resources

| URI Template | Description | Pagination |
|:-------------|:------------|:-----------|
| `openaq://location/{locationId}` | Location metadata: name, coordinates, country, provider, sensors (each with parameter + unit), and `datetimeFirst`/`datetimeLast`. Stable URI for a known location id. | No |
| `openaq://parameters` | Full pollutant + unit catalog (same data as `openaq_list_parameters`). Injectable context for clients that support resources. | No |

Both are convenience mirrors of tool output — every workflow is complete tool-only.

### Prompts

None. Data-lookup domain; no recurring analysis template earns a prompt at launch. (The "health
snapshot vs. WHO guidelines" idea is a cross-server workflow, not an OpenAQ-local prompt — see
Known Limitations.)

---

## Overview

`openaq-mcp-server` wraps the OpenAQ v3 REST API (`https://api.openaq.org/v3`) to expose measured
air quality to agents. OpenAQ aggregates physical-sensor observations — PM2.5, PM10, O3, NO2, SO2,
CO, BC, and dozens more parameters — from government reference monitors and research-grade sensors
worldwide into one API.

The data model is hierarchical and the v3 redesign made measurements **sensor-scoped**:

```
location (station)  ──has──▶  sensor  ──measures one──▶  parameter (pm25, o3, …) + unit
     │                          │
     │                          └──▶  measurements (time series, sensor-scoped)
     └──▶  latest (current value per sensor)
```

The server's core UX job is hiding that hierarchy behind near-me / latest / history tools so an
agent thinks in **locations and parameters**, never in sensor ids. `openaq_get_measurements`
resolves a location + parameter to the underlying sensor internally.

**Audience:** environmental and public-health analysis, pollution monitoring, researchers and
journalists, location-aware health tooling, agents answering "is the air safe here right now" with
measured data.

**Composes with:** `open-meteo-mcp-server` (modeled forecast — the headline pairing: forecast for
coverage, OpenAQ for current truth and validation), `who-gho-mcp-server` (WHO air-quality guideline
thresholds to interpret a reading), `nws-weather-mcp-server` (weather driving a pollution event),
`openstreetmap-mcp-server` (resolve a place name to coordinates for `find_locations`).

---

## The defining design choice: measured vs. modeled

This is the reason both this server and the modeled `openmeteo_get_air_quality` earn fleet slots,
and it drives the tool descriptions:

- OpenAQ returns **physical-sensor observations with real, uneven coverage gaps**. Coverage is
  dense in North America and Europe, sparse elsewhere. A location only reports the parameters its
  sensors actually measure.
- **The absence of a nearby station is NOT "clean air."** Every discovery tool description states
  this plainly. When `openaq_find_locations` returns nothing, the correct agent move is to widen
  the radius, check `openaq_list_countries` for coverage, or fall back to the modeled tool — never
  to conclude the air is clean.
- For dense anywhere-coverage the descriptions point at `open-meteo-mcp-server`'s modeled
  air-quality tool. Stating the complementarity in-surface keeps an agent from treating sparse
  measured data as a failure.

## Units vary — never normalize

Confirmed by probing the live `/v3/parameters` catalog (44 entries): the **same pollutant appears
under multiple ids with different units**, because different networks report differently.

| Pollutant | ids × units (from live catalog) |
|:----------|:--------------------------------|
| CO | id 4 (µg/m³), id 8 (ppm), id 102 (ppb) |
| NO2 | id 5 (µg/m³), id 7 (ppm), id 15 (ppb) |
| O3 | id 3 (µg/m³), id 10 (ppm), id 32 (ppb) |
| SO2 | id 6 (µg/m³), id 9 (ppm), id 101 (ppb) |
| NOx | id 27 (µg/m³), id 23 (ppb), id 19840 (ppm) |
| Temperature | id 100 (°C), id 128 (°F) |

Design consequences, enforced throughout:

1. **Every value carries its unit.** `value` and `unit` always travel together in output — never a
   bare number. The server never converts µg/m³ ↔ ppm/ppb (the conversion is gas- and
   temperature-dependent; a silent conversion would fabricate precision).
2. **`parametersId` (the numeric id), not a bare name, is the precise selector.** Tool inputs
   accept the numeric parameter id so the agent picks the exact unit variant. `openaq_list_parameters`
   is the lookup that maps a pollutant + desired unit to its id.
3. **`openaq_list_parameters` is documented as the canonical units reference.** Its description
   names the duplication explicitly so an agent knows to disambiguate.

---

## Requirements

- Read access to OpenAQ v3 (`https://api.openaq.org/v3`); **API key required**, sent as the
  **`X-API-Key` request header** (not a query param). Free tier ~60 req/min.
- Config env var is exactly **`OPENAQ_API_KEY`** (already provisioned in the gitignored `.env`).
  Missing key → `ConfigurationError` at startup (framework prints a clean banner).
- Location discovery by `coordinates` (`lat,lon`) + `radius` (metres, **1–25000, hard-capped by the
  API**), by `bbox` (`minx,miny,maxx,maxy`), and by country `iso` code; optional `parametersId`,
  `monitor`, `mobile`, and `providersId` narrow to locations that measure a given parameter, of a
  given station class, or from one provider network.
- Latest values per location, joined against the location's sensor→parameter map so each value
  carries its pollutant + unit (the raw `/latest` payload is keyed only by `sensorsId`).
- Historical series per location + parameter, resolving the sensor internally; `raw`, `hourly`, and
  `daily` aggregation; date-range filter (`datetimeFrom`/`datetimeTo`).
- Surface both UTC and local timestamps, and `datetimeLast`, so an agent knows how stale "latest" is.
- Validate lat/lon and radius bounds **in Zod at the edge** — the API returns a plain-text HTTP 500
  for out-of-range coordinates (e.g. `999,999`) instead of a clean 4xx; bounding the input prevents
  a confusing upstream crash.
- Large measurement ranges (> ~500 rows) spill to DataCanvas for SQL analysis when
  `CANVAS_PROVIDER_TYPE=duckdb`; without it, return a truncated preview + `totalCount`.
- Disclose truncation on capped-list tools via the framework enrichers (fields optional in schema).
- Identity: display/title is the hyphenated machine name **`openaq-mcp-server`** on every surface
  (`createApp()` `title`, manifest `display_name`) — never Title Case.

---

## Services

| Service | Wraps | Used By |
|:--------|:------|:--------|
| `OpenAqService` | OpenAQ v3 (`api.openaq.org/v3`) — `/locations`, `/locations/{id}`, `/locations/{id}/latest`, `/sensors/{id}/measurements[/hourly\|/daily]`, `/parameters`, `/countries` | All domain tools |

Single service — one base URL, one auth model (`X-API-Key` header), one error envelope, one retry
strategy. Splitting per-noun would add files with no API seam.

**Service methods** (return shapes mirror the API; tool handlers reshape/join):

- `findLocations(params)` → `LocationsResponse` (`/locations` with coordinates+radius / bbox / iso, narrowed by parametersId / monitor / mobile / providersId)
- `getLocation(locationId)` → `LocationDetail` (`/locations/{id}` — the canonical sensor→parameter map)
- `getLatest(locationId)` → `LatestResponse` (`/locations/{id}/latest` — values keyed by `sensorsId`, NO parameter/unit inline)
- `getMeasurements(sensorId, { datetimeFrom, datetimeTo, aggregation, page, limit })` → `MeasurementsResponse` (routes to `/sensors/{id}/measurements`, `/hourly`, or `/daily` by `aggregation`)
- `listParameters()` → `ParametersResponse` (`/parameters`)
- `listCountries()` → `CountriesResponse` (`/countries`)

**Resilience** (`withRetry` from `@cyanheads/mcp-ts-core/utils`):

| Concern | Decision |
|:--------|:---------|
| Retry boundary | Service method wraps fetch + parse, not just the network call |
| Backoff | 2 retries, base ~1s (rate-limited tier — the relevant transient is 429, not a flapping 5xx) |
| HTTP status | `fetchWithTimeout` maps non-OK → `ServiceUnavailable`; handler refines 404 into typed contract reasons; 422 body is a JSON string wrapping Python repr — regex-extract `msg` value, surface as `ValidationError` |
| 429 handling | Retryable; honor `Retry-After` if present. Free tier ~60 req/min — keep request counts low (readings = 2 calls; never fan out per sensor) |
| Parse failure | Plain-text body (the bad-coordinate 500, or a CDN page) → transient `ServiceUnavailable`, not `SerializationError` |
| Timeout | 15s (long date-range `daily` pulls can be slow) |

The 500-on-bad-coordinates case is defended primarily at the **Zod edge** (bounded lat/lon/radius,
ordered bbox corners) and by the handler's scope checks (`invalid_search_scope`);
the parse-failure rule is the backstop if a 500 slips through anyway.

---

## Config

| Env Var | Required | Default | Description |
|:--------|:---------|:--------|:------------|
| `OPENAQ_API_KEY` | **Yes** | — | OpenAQ v3 API key, sent as the `X-API-Key` header. Free from openaq.org. Missing → `ConfigurationError` at startup. |
| `OPENAQ_API_BASE_URL` | No | `https://api.openaq.org/v3` | Base URL override (testing / proxy). |
| `CANVAS_PROVIDER_TYPE` | No | `none` | Set to `duckdb` to enable DataCanvas spillover for large measurement series. Without it, `openaq_get_measurements` returns a truncated preview and the dataframe tools are inert. |
| `MCP_TRANSPORT_TYPE` | No | `stdio` | `stdio` or `http`. Framework-managed. |
| `PORT` | No | `3000` | HTTP port when transport is `http`. Framework-managed. |

`server-config.ts` (lazy-parsed `parseEnvConfig`): `apiKey` ← `OPENAQ_API_KEY` (required),
`baseUrl` ← `OPENAQ_API_BASE_URL`. Both `server.json` (`environmentVariables[]`) and `manifest.json`
(`mcp_config.env` + `user_config`) must list `OPENAQ_API_KEY` (lint:packaging checks the names match).

---

## Data Model — locations → sensors → measurements

The single most important thing the server hides. Confirmed against live responses.

### Discovery: `/v3/locations`

Each result (probed near Seattle):

```jsonc
{
  "id": 931,
  "name": "Seattle-10th & Weller",
  "locality": "Seattle-Tacoma-Bellevue",
  "timezone": "America/Los_Angeles",
  "country": { "id": 155, "code": "US", "name": "United States" },
  "owner":    { "id": 4, "name": "Unknown Governmental Organization" },
  "provider": { "id": 119, "name": "AirNow" },
  "isMobile": false,
  "isMonitor": true,
  "instruments": [{ "id": 2, "name": "Government Monitor" }],
  "sensors": [
    { "id": 1701, "name": "pm25 µg/m³",
      "parameter": { "id": 2, "name": "pm25", "units": "µg/m³", "displayName": "PM2.5" } },
    { "id": 1708, "name": "co ppm",
      "parameter": { "id": 8, "name": "co", "units": "ppm", "displayName": "CO" } }
    // … one sensor per measured parameter
  ],
  "coordinates": { "latitude": 47.5972, "longitude": -122.3197 },
  "distance": 1364.84,                 // metres — present always, null when no center point (bbox / iso queries)
  "datetimeFirst": { "utc": "2016-03-15T20:00:00Z", "local": "2016-03-15T13:00:00-07:00" },
  "datetimeLast":  { "utc": "2026-06-13T19:00:00Z", "local": "2026-06-13T12:00:00-07:00" }
}
```

The **`sensors[]` block is the sensor→parameter→unit map** every other tool needs. `parametersId`
on the query narrows the location set to stations that have a matching sensor (it does **not** trim
the returned `sensors[]` — each location still lists all its sensors).

### Current value: `/v3/locations/{id}/latest`

```jsonc
{ "datetime": { "utc": "2026-06-13T19:00:00Z", "local": "2026-06-13T12:00:00-07:00" },
  "value": 0.2, "coordinates": {…}, "sensorsId": 1708, "locationsId": 931 }
```

**Key constraint:** `/latest` carries NO `parameter` and NO `unit` — only `sensorsId`. So
`openaq_get_readings` must **join** `/locations/{id}/latest` against the `sensors[]` map (from
`/locations/{id}`) to attach pollutant + unit to each value. Two upstream calls, joined on
`sensorsId`.

### Time series: `/v3/sensors/{id}/measurements` (+ `/hourly`, `/daily`)

Sensor-scoped — the whole reason `get_measurements` resolves a sensor internally. Each `raw` row:

```jsonc
{ "value": 6.3,
  "flagInfo": { "hasFlags": false },
  "parameter": { "id": 2, "name": "pm25", "units": "µg/m³", "displayName": null },  // unit IS inline here
  "period": { "label": "raw", "interval": "01:00:00",
              "datetimeFrom": { "utc": "…", "local": "…" },
              "datetimeTo":   { "utc": "…", "local": "…" } },
  "coverage": { "expectedCount": 1, "observedCount": 1, "percentComplete": 100.0, … } }
```

`/daily` (and `/hourly`) additionally return a `summary` block — `{ min, q02, q25, median, q75,
q98, max, avg, sd }` — and `period.label: "1 day"`. Aggregation endpoints accept
`datetime_from`/`datetime_to` as date strings.

Bucket boundaries (live-probed 2026-09-23 at station 931, `America/Los_Angeles`):

- **Hours are labeled by their end, and `datetime_to` is inclusive.** An hour is selected when
  its end falls after `datetime_from` and at or before `datetime_to`, so a `…T23:59:59Z` upper
  bound drops the day's last hour; the next midnight keeps it. A raw `18:00→19:00Z` row comes back
  for `datetime_from=…T18:15:00Z` (station 2848864, `Asia/Kathmandu`), so the start is not the
  test.
- **Hourly buckets follow local hours.** At UTC+05:45 (2848864) they open at :15 UTC, so a
  date-only bound's local midnight lines up with them there as at 931; raw rows keep their own
  UTC periods.
- **A daily bucket is the station's local calendar day** (`2026-08-01T07:00Z → 08-02T07:00Z` at
  931), aggregated over the in-window hours only. A window that cuts a local day returns that day
  as a clipped bucket whose value covers just the hours inside it.
- **DST lives in the boundaries.** The fall-back day is one 25-hour bucket, the repeated hour a
  2-hour bucket (`percentComplete` 50, then 200 on the next hour), and spring-forward leaves the
  UTC hours contiguous. Around spring-forward OpenAQ also returns the day before as a 47-hour
  bucket overlapping the next one.
- **Missing time is skipped** in hourly and raw series at 931; other sensors return a bucket
  with a null `value` instead (sensor 3425, #11). Raw rows follow no fixed cadence (a low-cost
  sensor's 5-minute periods start ~5m43s apart), so only hourly/daily series define a gap.
- **`meta.found`** is an exact series total on `/hourly` and `/daily`. On raw it is `">limit"`
  on a full page and the page's own row count on a short one, so it is never a raw total.

### The sensor-resolution flow (the central UX move)

`openaq_get_measurements(locationId, parametersId, …)`:

| # | Call | Purpose |
|:--|:-----|:--------|
| 1 | `GET /v3/locations/{locationId}` | Fetch `sensors[]`; find the sensor whose `parameter.id === parametersId` |
| 2 | `GET /v3/sensors/{sensorId}/measurements[/hourly\|/daily]?datetime_from=…&datetime_to=…` | Pull the series for the resolved sensor |
| 3 | (large range) stage full set on DataCanvas as `measurements_<sensorId>`, return preview + `canvasId` | SQL-queryable spill |

If no sensor at the location measures `parametersId` → typed `parameter_not_at_location` error, with
recovery pointing at `openaq_find_locations` (which lists each location's parameters) and
`openaq_list_parameters` (to confirm the id, e.g. the agent picked the ppm variant when the station
reports µg/m³).

---

## Tool Detail

### `openaq_find_locations`

**Description:** Find air-quality monitoring stations (measured by physical sensors, not modeled)
near a point, within a bounding box, or by country, optionally narrowed to one parameter, one station
class (reference monitors or low-cost sensors, mobile or fixed), or one provider network. Returns each
station's id, name, coordinates, distance from the query point (when searching by coordinates),
country, provider name and id, the parameters its sensors measure, and the timestamp of its most
recent data (`datetimeLast`). Required first step:
`openaq_get_readings` and `openaq_get_measurements` key on the location id this returns. Coverage is
uneven and real — a station only reports the parameters it measures, and the absence of a nearby
station means no monitoring there, not clean air. For dense modeled coverage anywhere on Earth, use
`open-meteo-mcp-server`'s air-quality tool instead.

**Input schema:**
```ts
{
  coordinates: z.string().regex(/^-?\d{1,3}(\.\d+)?,-?\d{1,3}(\.\d+)?$/).optional()
    .describe('Center point as "latitude,longitude" (e.g. "47.6062,-122.3321"). Pair with radius for a near-me search. Resolve a place name to coordinates with openstreetmap-mcp-server or open-meteo geocode first. Provide either coordinates+radius OR bbox, not both.'),
  radius: z.number().int().min(1).max(25000).optional()   // no schema default, so omission is detectable
    .describe('Search radius in metres around coordinates (1–25000; the API hard-caps at 25000). Default 12000 (~12km). Requires coordinates — a radius sent with only bbox or iso is rejected.'),
  bbox: z.string().regex(/^(-?\d+(\.\d+)?,){3}-?\d+(\.\d+)?$/).optional()   // + range and corner-order refines
    .describe('Bounding box as "minLon,minLat,maxLon,maxLat" (west,south,east,north), with minLon ≤ maxLon and minLat ≤ maxLat. Alternative to coordinates+radius for area sweeps. Results have no distance field (no center point).'),
  iso: z.preprocess(normalizeIso, z.string().regex(/^(?:[A-Za-z]{2}|-99)$/)).optional()
    .describe('Restrict to a country by OpenAQ country code: ISO 3166-1 alpha-2 (e.g. "US", "IN", "DE"; either case), or "-99" where OpenAQ lists a country with no ISO code. Take codes from openaq_list_countries. Combine with bbox/coordinates to scope, or use alone for a country-wide list.'),
  parametersId: z.number().int().positive().optional()
    .describe('Only return stations that measure this parameter id (e.g. 2 = PM2.5 µg/m³). Get ids from openaq_list_parameters — the same pollutant has several ids for different units. Narrows the station set; each returned station still lists all its sensors.'),
  monitor: z.boolean().optional()
    .describe('Station class filter: true returns only reference-grade monitors, false only low-cost sensors. Omit for both.'),
  mobile: z.boolean().optional()
    .describe('Mobility filter: true returns only mobile stations, false only fixed ones. Omit for both.'),
  providersId: z.number().int().positive().optional()
    .describe("Only return stations from this OpenAQ provider (data network) id — read it from a previous result's providerId (e.g. 119 = AirNow)."),
  limit: z.number().int().min(1).max(100).default(20)
    .describe('Max stations to return (1–100). Default 20. Results are ordered by distance when searching by coordinates.'),
  page: z.number().int().min(1).default(1)
    .describe('Which page of results to return (1-based). … A page past the last one fails with page_exhausted.'),
}
```
Handler validates that at least one of `coordinates`, `bbox`, or `iso` is provided (else
`no_search_scope` — an unfiltered global location list is not useful and risks a huge response), and
rejects `coordinates` with `bbox`, or `radius` without `coordinates`, as `invalid_search_scope` —
OpenAQ answers both with HTTP 500. `monitor`, `mobile`, and `providersId` are filters, not scopes, and
are forwarded only when supplied (`false` included). The service keeps the 12000 m radius fallback,
since OpenAQ also 500s on `coordinates` without a `radius`.

**Output schema:**
```ts
{
  locations: z.array(z.object({
    id: z.number().describe('Location id — pass to openaq_get_readings / openaq_get_measurements'),
    name: z.string().describe('Station name'),
    locality: z.string().nullable().describe('Locality or metro area, when provided'),
    country: z.object({
      code: z.string().describe('OpenAQ country code: ISO 3166-1 alpha-2, or "-99" where OpenAQ lists none'),
      name: z.string().describe('Country name'),
    }).nullable().describe('Country the station is in. Null when OpenAQ lists none.'),
    coordinates: z.object({
      latitude: z.number().describe('Station latitude (decimal degrees)'),
      longitude: z.number().describe('Station longitude (decimal degrees)'),
    }).nullable().describe('Station location. Null when OpenAQ lists no latitude or no longitude.'),
    distanceMeters: z.number().nullable().describe('Distance from the query coordinates in metres. Null when searching by bbox or iso (no center point).'),
    provider: z.string().nullable().describe('Data provider / network (e.g. "AirNow", "OpenAQ LCS"). Null when OpenAQ lists none.'),
    providerId: z.number().nullable().describe('OpenAQ provider id — pass as providersId to restrict a search to this network. Null when OpenAQ lists no provider.'),
    isMonitor: z.boolean().describe('True for reference-grade government monitors; false for low-cost sensors. Reference monitors are more reliable for regulatory comparison.'),
    isMobile: z.boolean().describe('True if the station is mobile (coordinates may vary over time)'),
    parameters: z.array(z.object({
      id: z.number().describe('Parameter id — use as parametersId in get_readings / get_measurements'),
      name: z.string().describe('Pollutant code (e.g. "pm25", "o3")'),
      unit: z.string().describe('Measurement unit for this sensor (e.g. "µg/m³", "ppm"). Units vary by sensor — never assume.'),
      displayName: z.string().nullable().describe('Human-readable pollutant name'),
    })).describe('Parameters this station measures, each with its sensor unit. The station has one sensor per parameter.'),
    datetimeLast: z.object({
      utc: z.string().describe('Most recent measurement time, UTC (ISO 8601)'),
      local: z.string().describe('Most recent measurement time in the station\'s local timezone'),
    }).nullable().describe('Timestamp of the station\'s most recent measurement. Tells you whether "latest" will be minutes or hours/days old. Null if the station has never reported.'),
    datetimeFirst: z.object({
      utc: z.string().describe('Earliest available measurement time, UTC (ISO 8601)'),
      local: z.string().describe('Earliest available measurement time in the station\'s local timezone'),
    }).nullable().describe('Timestamp of the station\'s first available measurement.'),
  })).describe('Matching stations on this page, never empty: a query with no match fails with no_locations_found (no monitoring coverage, NOT clean air), and a page past the last with page_exhausted.'),
}
// enrichment: totalCount = (page − 1) × limit + stations returned — exact on a page short of the
// limit; on a full page a floor, with totalCountIsLowerBound + truncated/shown/cap and a notice
// naming the next page and only the area move the search's scope accepts (smaller radius for
// coordinates, tighter bbox for bbox, a bbox or coordinates for iso alone). Never read from
// meta.found (a per-page count on /v3/locations).
```

**Errors:**
```ts
errors: [
  { reason: 'no_locations_found', code: JsonRpcErrorCode.NotFound,
    when: 'No monitoring stations match the given area or filters',
    recovery: 'Widen the search area (a radius up to 25000m around coordinates, or a larger bbox), drop the parametersId, monitor, mobile, or providersId filter, check coverage with openaq_list_countries, or fall back to the modeled open-meteo air-quality tool. No station does not mean clean air.',
    retryable: false },
  { reason: 'page_exhausted', code: JsonRpcErrorCode.NotFound,   // empty page > 1; data { page, limit }
    when: 'A page past the first returned no stations — the results end before it',
    recovery: 'The results end before this page. Request an earlier page; page 1 shows whether anything matches the query at all.',
    retryable: false },
  { reason: 'no_search_scope', code: JsonRpcErrorCode.ValidationError,
    when: 'None of coordinates, bbox, or iso was provided',
    recovery: 'Provide coordinates+radius for a near-me search, bbox for an area, or iso for a country.',
    retryable: false },
  { reason: 'invalid_search_scope', code: JsonRpcErrorCode.ValidationError,
    when: 'coordinates and bbox were both provided, or radius was provided without coordinates',
    recovery: 'Use one area scope: coordinates (with an optional radius) for a near-me search, or bbox for an area. radius applies only with coordinates; iso combines with either.',
    retryable: false },
  // plus upstream_error / rate_limited / upstream_timeout / invalid_api_key, thrownBy: 'service'
]
```

---

### `openaq_get_readings`

**Description:** Latest measured value for every sensor at a monitoring station — the
current-conditions tool. Returns one record per parameter, each with the value, its unit, the UTC
and local timestamp, and the sensor id, joined so every value carries its pollutant and unit (the
raw latest feed is keyed only by sensor id). The station block names its provider (for
attribution) and timezone. Pass a `locationId` from `openaq_find_locations`, or
pass `coordinates` to auto-resolve to the nearest station that measures the requested
`parametersId`. Data recency varies by station reporting cadence — read each value's timestamp to
know whether "latest" is minutes or hours old. These are measured observations with coverage gaps,
not a modeled grid.

**Input schema:**
```ts
{
  locationId: z.number().int().positive().optional()
    .describe('Station id from openaq_find_locations. Provide this OR coordinates. When set, returns the latest value for every sensor at this station.'),
  coordinates: z.string().regex(/^-?\d{1,3}(\.\d+)?,-?\d{1,3}(\.\d+)?$/).optional()
    .describe('Fallback "latitude,longitude" when you do not have a locationId — resolves to the nearest station (within 25km) that measures parametersId, then reads its latest values. Requires parametersId.'),
  parametersId: z.number().int().positive().optional()
    .describe('Required with coordinates: which parameter id the nearest station must measure (get ids from openaq_list_parameters). With locationId, optionally filters the returned values to this parameter id; omit to get all sensors.'),
}
```
Handler: exactly one of `locationId` / `coordinates` required; `coordinates` requires
`parametersId`. The `coordinates` path is `findLocations(coordinates, radius:25000, parametersId,
limit:1000)` → the service's distance sort puts the nearest of that page at `results[0]` → readings
on it. `/v3/locations` pages in ascending id order, so the pool is OpenAQ's page maximum; a page
that comes back full (1,000 rows) sets a `notice` that the station is the nearest of the first
1,000 OpenAQ lists, not necessarily the nearest overall. Missing upstream values stay null:
`coordinates` unless both latitude and longitude are numbers, `provider`/`providerId` when OpenAQ
lists no provider.

**Output schema:**
```ts
{
  location: z.object({
    id: z.number().describe('Station id'),
    name: z.string().describe('Station name'),
    coordinates: z.object({
      latitude: z.number(), longitude: z.number(),
    }).nullable().describe('Station coordinates. Null when OpenAQ lists no latitude or no longitude.'),
    provider: z.string().nullable().describe('Network that operates the station (e.g. "AirNow") — cite it alongside OpenAQ. Null when OpenAQ lists none.'),
    providerId: z.number().nullable().describe('Provider id, usable as providersId in openaq_find_locations. Null when OpenAQ lists none.'),
    timezone: z.string().nullable().describe('IANA timezone of the station'),
    distanceMeters: z.number().nullable().describe('Distance from query coordinates in metres, when resolved via coordinates; null when called by locationId'),
    datetimeLast: z.object({
      utc: z.string().describe('Most recent measurement time, UTC (ISO 8601)'),
      local: z.string().describe('Most recent measurement time in the station\'s local timezone'),
    }).nullable().describe('Timestamp of the station\'s most recent measurement — tells you whether "latest" is minutes or hours old before reading per-value timestamps. Null if the station has never reported.'),
  }).describe('The station these readings came from'),
  readings: z.array(z.object({
    parameter: z.object({
      id: z.number().describe('Parameter id'),
      name: z.string().describe('Pollutant code (e.g. "pm25")'),
      displayName: z.string().nullable().describe('Human-readable pollutant name'),
    }).describe('What was measured'),
    value: z.number().describe('Measured concentration'),
    unit: z.string().describe('Unit for this value (e.g. "µg/m³", "ppm", "ppb"). Always read it — units differ across stations and pollutants; the value is meaningless without it.'),
    sensorId: z.number().describe('Sensor id — use the corresponding locationId + parametersId to fetch this sensor\'s history via openaq_get_measurements'),
    datetimeUtc: z.string().describe('Measurement time, UTC (ISO 8601)'),
    datetimeLocal: z.string().describe('Measurement time in the station\'s local timezone'),
  })).describe('Latest value per sensor. An old datetime means the station reports infrequently or is stale — not that the value is current.'),
}
// enrichment: notice — only when coordinate resolution compared a full 1,000-station page, so the
// station is the nearest of the first 1,000 OpenAQ lists, not necessarily the nearest overall.
```

**Errors:**
```ts
errors: [
  { reason: 'location_not_found', code: JsonRpcErrorCode.NotFound,
    when: 'The locationId does not exist (API returns {"detail":"Location not found"})',
    recovery: 'Verify the id via openaq_find_locations.',
    retryable: false },
  { reason: 'parameter_not_at_location', code: JsonRpcErrorCode.NotFound,   // data { locationId, parametersId, available }
    when: 'No sensor at the resolved station measures parametersId (often the wrong unit variant was chosen)',
    recovery: 'Pick one of the ids listed in data.available, or confirm the id and its unit in openaq_list_parameters — the same pollutant has different ids for µg/m³ vs ppm vs ppb.',
    retryable: false },
  { reason: 'no_station_near_coordinates', code: JsonRpcErrorCode.NotFound,
    when: 'The 25km auto-resolution sweep found no station measuring the requested parametersId',
    recovery: 'Try a different parametersId, sweep a wider area with an openaq_find_locations bbox query, or fall back to the modeled open-meteo air-quality tool. No station does not mean clean air.',
    retryable: false },
  { reason: 'no_recent_values', code: JsonRpcErrorCode.NotFound,
    when: 'The station has the requested sensors but its latest feed carried no values for them',
    recovery: 'Check datetimeLast from openaq_find_locations; the station may be dormant. Try a nearby station.',
    retryable: false },
  { reason: 'invalid_location_scope', code: JsonRpcErrorCode.ValidationError,
    when: 'Both locationId and coordinates were provided, or neither was',
    recovery: 'Pass exactly one — a locationId from openaq_find_locations to read a known station, or coordinates plus parametersId to auto-resolve the nearest one.',
    retryable: false },
  { reason: 'missing_coordinates_parameter', code: JsonRpcErrorCode.ValidationError,
    when: 'coordinates was provided without parametersId',
    recovery: 'Provide parametersId so the nearest matching station can be resolved, or pass a locationId instead.',
    retryable: false },
  // plus upstream_error / rate_limited / upstream_timeout / invalid_api_key, thrownBy: 'service'
]
```
The sweep already runs at OpenAQ's 25000 m radius ceiling, so the `no_station_near_coordinates`
recovery never suggests widening the radius.

---

### `openaq_get_measurements`

**Description:** Historical measurement series for one pollutant at one station over a date range —
for trend analysis and "was last week worse than the monthly average?". Pass a `locationId` and a
`parametersId` and work in stations — you get the series for that pollutant at that station. Choose
`aggregation`: `raw` (every reported value),
`hourly`, or `daily` — `daily` and `hourly` add a per-bucket statistical summary (min, median,
max, mean, sd). Large ranges produce thousands of rows and spill to a DataCanvas: the response
returns a preview plus a `canvasId` and table name you query with `openaq_dataframe_query`. Values
carry their unit; the server never converts between µg/m³, ppm, and ppb.

**Input schema:**
```ts
{
  locationId: z.number().int().positive()
    .describe('Station id from openaq_find_locations.'),
  parametersId: z.number().int().positive()
    .describe('Parameter id to pull the series for (e.g. 2 = PM2.5 µg/m³). Get ids from openaq_list_parameters. Must be a parameter the station measures — find_locations lists each station\'s parameters.'),
  // Both bounds also refine to a real calendar date/time — Date.parse rolls "2026-02-30" over to March 2.
  datetimeFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2}Z)?$/).optional()
    .describe('Start of the range, inclusive. A date "YYYY-MM-DD" opens at local midnight of that day in the station\'s timezone (UTC midnight when OpenAQ lists none); a full UTC timestamp is sent as is. Omit to start from the sensor\'s earliest data — the series runs oldest first, so set datetimeFrom to reach recent values.'),
  datetimeTo: z.string().regex(/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2}Z)?$/).optional()
    .describe('End of the range, inclusive. A date covers that whole station-local day, closing at the next local midnight (23 or 25 hours on a DST day); a timestamp is sent as is. Must land after datetimeFrom. Omit for "up to now".'),
  aggregation: z.enum(['raw', 'hourly', 'daily']).default('raw')
    .describe('Time bucketing. "raw" = every reported value (often hourly at source). "hourly"/"daily" = server-side rollups with a statistical summary per bucket. Use "daily" for multi-month trends to keep the series small; "raw" for fine-grained recent analysis.'),
  limit: z.number().int().min(1).max(1000).default(1000)
    .describe('Max rows per page from the API (1–1000). Default 1000. The tool pages internally up to the 5000-row pull ceiling.'),
  canvas_id: z.string().optional()
    .describe('DataCanvas id from a prior call to reuse the same canvas (e.g. to compare two stations\' series side by side). Omit to start fresh; the response returns a new canvas_id when the series spills.'),
}
```

**Output schema:**
```ts
{
  location: z.object({
    id: z.number().describe('Station id'),
    name: z.string().describe('Station name'),
    provider: z.string().nullable().describe('Network that operates the station. Null when OpenAQ lists none.'),
    providerId: z.number().nullable().describe('Provider id, usable as providersId in openaq_find_locations'),
    timezone: z.string().nullable().describe('IANA timezone; daily buckets and date-only bounds follow its calendar days'),
  }).describe('Station the series came from'),
  parameter: z.object({
    id: z.number().describe('Parameter id'),
    name: z.string().describe('Pollutant code'),
    unit: z.string().describe('Unit for every value in this series. The server does not convert units.'),
    displayName: z.string().nullable().describe('Human-readable pollutant name'),
  }).describe('What was measured, resolved from the station\'s sensor'),
  sensorId: z.number().describe('Resolved sensor id the series was pulled from'),
  aggregation: z.enum(['raw', 'hourly', 'daily']).describe('Bucketing applied'),
  series: z.array(z.object({
    datetimeFrom: z.string().describe('Bucket start, UTC (ISO 8601)'),
    datetimeTo: z.string().describe('Bucket end, UTC (ISO 8601)'),
    value: z.number().nullable().describe('Value for the bucket (the measurement for raw; the bucket aggregate for hourly/daily). Null for a gap bucket the sensor reported nothing into'),
    summary: z.object({
      min: z.number().nullable(), median: z.number().nullable(), max: z.number().nullable(),
      avg: z.number().nullable(), sd: z.number().nullable().describe('Standard deviation — null when only one reading in the bucket'),
    }).nullable().describe('Per-bucket statistics — present for hourly/daily, null for raw. Every field is null in a gap bucket'),
    percentComplete: z.number().nullable().describe('Observed readings as a percentage of expected; usually 0–100, 200 on a DST fall-back hour'),
    flagged: z.boolean().describe('True if the source flagged this value (quality concern)'),
  })).describe('The (possibly previewed) series in the order OpenAQ returns it (oldest first). When truncated, this is a preview of pulledCount rows — query canvasId for the rest.'),
  rowCount: z.number().describe('Rows in this response (preview length when spilled)'),
  pulledCount: z.number().describe('Rows pulled from OpenAQ, at most 5000 — the canvas table\'s row count when canvasId is present'),
  pullComplete: z.boolean().describe('True when pulledCount is the whole series for the range; false when the 5000-row cap or a failed page stopped it early'),
  // DataCanvas staging fields — optional, present only when staging succeeded:
  canvasId: z.string().optional().describe('DataCanvas id holding the staged series — pulledCount rows of it. Call openaq_dataframe_describe on this id for the table\'s columns, then openaq_dataframe_query to run SQL.'),
  tableName: z.string().optional().describe('Canvas table holding the staged series (e.g. "measurements_1701"). One table per sensor, so re-staging the same sensor on this canvas overwrites it.'),
  truncated: z.boolean().optional().describe('True when the series exceeded the inline limit, so series is a preview of the pulled rows. Describes the preview only — canvasId reports staging, pullComplete reports the pull.'),
}
// enrichment: totalCount (rows in the full series for this range; a floor when
// totalCountIsLowerBound is set), totalCountIsLowerBound, effectiveRange
// ({ datetimeFrom, datetimeTo } UTC instants sent upstream, null when omitted),
// gapCount (hourly/daily only; 0 when complete), gaps (first 20 missing
// { datetimeFrom, datetimeTo } spans; omitted at 0), notice
```

**Errors:**
```ts
errors: [
  { reason: 'location_not_found', code: JsonRpcErrorCode.NotFound,
    when: 'The locationId does not exist',
    recovery: 'Verify the id via openaq_find_locations.',
    retryable: false },
  { reason: 'parameter_not_at_location', code: JsonRpcErrorCode.NotFound,
    when: 'No sensor at the station measures parametersId (often the wrong unit variant was chosen)',
    recovery: 'Check the station\'s parameters in openaq_find_locations output, and confirm the id (and its unit) in openaq_list_parameters — the same pollutant has different ids for µg/m³ vs ppm vs ppb.',
    retryable: false },
  { reason: 'no_data_for_range', code: JsonRpcErrorCode.NotFound,
    when: 'The sensor has no measurements in the requested date range',
    recovery: 'Widen the range or check the station\'s datetimeFirst/datetimeLast from openaq_find_locations.',
    retryable: false },
  { reason: 'invalid_date_range', code: JsonRpcErrorCode.ValidationError,
    when: 'Once date-only bounds are expanded to the station\'s local day, datetimeTo does not land after datetimeFrom',
    recovery: 'Move datetimeTo to a later instant than datetimeFrom; a date-only bound spans the whole station-local day.',
    retryable: false },
  { reason: 'canvas_not_found', code: JsonRpcErrorCode.NotFound,
    when: 'The supplied canvas_id is unknown or has expired, so the series cannot be staged onto it',
    recovery: 'Omit canvas_id to stage the series on a fresh canvas, or re-run the call that produced the id you meant to reuse.',
    retryable: false },
  // plus upstream_error / rate_limited / upstream_timeout / invalid_api_key, thrownBy: 'service'
]
```
**Canvas degraded mode (not a thrown error):** When `CANVAS_PROVIDER_TYPE` is not `duckdb` and the
series would stage (it overflows the preview, or a `canvas_id` was supplied), the handler returns
the rows it holds — the truncated preview, or the whole inline series — plus `totalCount` and a
`notice` enrichment naming the supplied canvas when there was one. It does **not** throw — the rows
in hand are still useful. The `dataframe_query`/`dataframe_describe` tools throw
`canvas_unavailable` (`ServiceUnavailable`) when invoked without DuckDB. This non-throwing
degradation must NOT be added to `errors[]` — that contract is for thrown errors only.

---

### `openaq_list_parameters`

**Description:** Catalog of every measurable pollutant and its canonical unit: id, code, display
name, unit, and a one-line description (pm25, pm10, o3, no2, so2, co, bc, and more). This is the
unit-disambiguation reference — the same pollutant exists under several ids with different units
(CO is id 4 in µg/m³, id 8 in ppm, id 102 in ppb), so use this to pick the exact `parametersId` for
`openaq_find_locations` / `openaq_get_readings` / `openaq_get_measurements` and to interpret a
reading's unit. A small bounded catalog fetched live from OpenAQ.

**Input schema:**
```ts
{
  query: z.string().optional()
    .describe('Case-insensitive filter over the bounded parameter catalog by code, display name, and description (e.g. "pm" for particulates, "ozone", "co"). Omit to list everything.'),
  pollutantsOnly: z.boolean().default(false)
    .describe('When true, exclude meteorological/auxiliary parameters (temperature, humidity, wind, pressure, particle-count channels) and return only air pollutants. Default false (full catalog).'),
}
```

**Output schema:**
```ts
{
  parameters: z.array(z.object({
    id: z.number().describe('Parameter id — the precise selector for the other tools (unit-specific)'),
    name: z.string().describe('Pollutant code (e.g. "pm25", "o3", "co")'),
    displayName: z.string().nullable().describe('Human-readable name (e.g. "PM2.5", "O₃ mass")'),
    unit: z.string().describe('Canonical measurement unit for this id (e.g. "µg/m³", "ppm", "ppb"). The same pollutant code appears under multiple ids with different units.'),
    description: z.string().nullable().describe('One-line description of the pollutant'),
  })).describe('Matching parameters. Multiple rows can share a name with different ids/units — pick the id whose unit you want.'),
}
// enrichment: totalCount
```

**Errors:**
```ts
errors: [
  // upstream_error / rate_limited / upstream_timeout / invalid_api_key, thrownBy: 'service'
]
```
A `query` with no matches returns an empty array with a `notice` enrichment ("no parameters matched
'<query>'") — not an error; the agent should broaden or drop the filter.

---

### `openaq_list_countries`

**Description:** Catalog of country-level coverage: id, OpenAQ country code, name, the date span of
available station data (`datetimeFirst`/`datetimeLast`), and which parameters are measured anywhere
in that country. The availability check before a regional sweep — answers "which countries have NO2
monitoring?" and tells you whether a country has recent data before you call
`openaq_find_locations`. Coverage is uneven worldwide; this surfaces where measured data exists.
Results come a page at a time (20 countries by default); `totalCount` is the full filtered count.

**Input schema:**
```ts
{
  query: z.string().optional()
    .describe('Case-insensitive filter over the country catalog by code and name. A two-letter query matches an exact ISO 3166-1 alpha-2 code first (e.g. "US" → United States) and falls back to substrings when no code matches; longer queries match as substrings (e.g. "united", "germany"). Omit to page through the whole catalog.'),
  parametersId: z.number().int().positive().optional()
    .describe('Only return countries that measure this parameter id somewhere (e.g. 2 = PM2.5 µg/m³) — the one-call answer to "which countries have NO2 monitoring?". Get ids from openaq_list_parameters; the same pollutant has several ids for different units. Composes with query.'),
  limit: z.number().int().min(1).max(100).default(20)
    .describe('Max countries to return (1–100). Default 20. Applied after query and parametersId, in OpenAQ catalog order.'),
  page: z.number().int().min(1).default(1)
    .describe('Which page of the filtered list to return (1-based). Default 1. … A page past the last one returns no countries and a notice naming the last page.'),
}
```
Handler: fetch the whole catalog (one `/countries?limit=1000` call), apply `query` then
`parametersId`, then slice the page in upstream (ascending country id) order. The total is exact, so
`truncated` fires only when rows remain past the page — an exactly full last page is not truncated —
and a page past the end is an empty success with a notice naming the last page, not an error. A filter
that matches nothing keeps its no-match notice whatever the page.

**Output schema:**
```ts
{
  countries: z.array(z.object({
    id: z.number().describe('Country id (OpenAQ internal)'),
    code: z.string().describe('OpenAQ country code: ISO 3166-1 alpha-2, or "-99" where OpenAQ has none — pass as iso to openaq_find_locations'),
    name: z.string().describe('Country name'),
    datetimeFirst: z.string().nullable().describe('UTC timestamp of the earliest available measurement in this country (ISO 8601)'),
    datetimeLast: z.string().nullable().describe('UTC timestamp of the most recent measurement — recent means the country has live coverage'),
    parameters: z.array(z.object({
      id: z.number().describe('Parameter id measured somewhere in this country'),
      name: z.string().describe('Pollutant code'),
      unit: z.string().describe('Unit for this parameter id'),
    })).describe('Parameters measured anywhere in this country — a coverage hint, not a per-station guarantee'),
  })).describe('Matching countries with coverage metadata.'),
}
// enrichment: totalCount (filtered, across every page); when more rows follow the page,
// truncated / shown / cap (optional) and a notice naming the next page
```

**Errors:**
```ts
errors: [
  // upstream_error / rate_limited / upstream_timeout / invalid_api_key, thrownBy: 'service'
]
```
No domain errors: a filter that matches nothing and a page past the end are both successful empty
results carrying a `notice`.

---

### `openaq_dataframe_query` / `openaq_dataframe_describe`

Standard DataCanvas consumer tools (per the `api-canvas` skill's minimum-viable shape). Both
`readOnlyHint: true`. `dataframe_query` runs a read-only SQL `SELECT` (four-layer gate enforces
read-only) against tables `openaq_get_measurements` staged (`measurements_<sensorId>`);
`dataframe_describe` lists staged tables + columns. Both throw `canvas_unavailable`
(`ServiceUnavailable`) when `CANVAS_PROVIDER_TYPE` is not `duckdb`, and the framework's
`missing_table` (`NotFound`, re-stage hint) / `register_as_clash` surface as-is. Schemas follow the
skill's recipe (`canvas_id` + `sql` in, `rows` + `rowCount` out for query; `canvas_id` in,
`tables[]` out for describe), plus the response bound the recipe leaves to the consumer:
`dataframe_query` passes an explicit 200-row `rowLimit` to `instance.query` and forwards the
provider's `truncated` as an optional output field, with a `notice` naming
`ORDER BY <column> LIMIT 200 OFFSET <n>` as the continuation. The four-layer SQL gate bounds what a
statement may *do*, never how many rows it yields, so a `CROSS JOIN` over a staged series otherwise
reaches the 10,000-row DuckDB ceiling and lands ~1.8 MB in one response.

---

## DataCanvas plan

**Decision: canvas spillover on `openaq_get_measurements` only.** Recorded in the Decisions Log.

- **Earns its keep on shape, not size.** A measurement series is analytical — an agent runs
  `SELECT … GROUP BY`, computes a monthly mean, compares last week to the period average, or joins
  two stations' series. That is exactly the canvas's purpose. The other tools are
  discovery/categorical (locations, parameters, countries) — bounded, find-then-drill-in — and do
  **not** get a canvas regardless of row count.
- **Too big to inline.** A multi-month raw (hourly-at-source) series is thousands of rows. Inlining
  blows context; a fixed slice blinds the agent to the rest. Spillover shows a preview + stages the
  full set.
- **Staging mechanics:** acquire the canvas (`canvas_id` optional input → mint on omit), page the
  measurements up to the row ceiling, register as `measurements_<sensorId>`. Staging runs whenever
  the series overflows the 100-row inline preview **or** a `canvas_id` was supplied — a caller who
  names a canvas is asking for this series on it, and a narrow range that silently skipped the
  canvas left nothing to join against. With no `canvas_id` a series that fits inline touches no
  canvas, so small calls burn no tenant canvas slot. Output carries `canvasId`, `tableName`,
  `truncated`, `pulledCount`, `pullComplete`, plus the preview `series` and `totalCount`.
- **One table per sensor.** The staged name is `measurements_<sensorId>` with no aggregation or
  range component, and the handler drops that name before registering. Reusing a `canvas_id` for a
  *different* sensor adds a table, so the agent can `JOIN`/`UNION` to compare stations; reusing it
  for the *same* sensor at another aggregation or window overwrites the earlier series. The drop
  reports whether it removed anything, and the staging notice says so when it did.
- **Mandatory pairing, surfaced at runtime:** because `get_measurements` can emit a `canvasId`, the
  server ships `openaq_dataframe_query` (+ `openaq_dataframe_describe`). A token with no query tool
  is dead output — and a token whose response names no tool is nearly as dead, so the staging path
  pushes a notice naming the staged table, `openaq_dataframe_describe`, then
  `openaq_dataframe_query`. Describe-first is load-bearing, not ordering preference: the staged
  table is flat (`min`, `sd`) while the response `series` is nested (`summary.min`), so SQL written
  from the response shape alone references columns that do not exist.
- **Graceful degradation:** without `CANVAS_PROVIDER_TYPE=duckdb`, `get_measurements` returns the
  truncated preview + `totalCount` and omits the canvas fields (the `canvas_unavailable` contract
  documents this); the dataframe tools throw `canvas_unavailable` with an enable hint.
- **No-auth canvas is fine:** OpenAQ is public, non-PII data — exactly the public-data analytics
  profile the canvas token model is designed for.

## Enrichment plan

Per the framework's capped-list rules, **truncation fields are OPTIONAL in the output schema** (the
framework only populates them when the cap is hit; declaring them required throws -32007 on every
non-truncated result):

| Tool | Required enrichment | Optional enrichment (cap-hit only) |
|:-----|:--------------------|:-----------------------------------|
| `openaq_find_locations` | `totalCount` (stations counted through this page, `(page − 1) × limit + rows`; exact on a short page) | On a full page: `totalCountIsLowerBound` (at least `totalCount` match), `truncated` / `shown` / `cap`, and a `notice` naming the next page |
| `openaq_get_readings` | — (returns all sensors at one location; not a capped list) | `notice` when coordinate resolution compared a full 1,000-station page (nearest of the first 1,000, not necessarily overall) |
| `openaq_get_measurements` | `totalCount` (rows in the full series; a floor when the pull stopped early and OpenAQ gave `">N"`), `effectiveRange` (UTC bounds sent upstream) | `totalCountIsLowerBound` (that floor case), `gapCount` (every hourly/daily response) and `gaps` (first 20, when any), `notice` (row cap, failed page, station with no timezone, clipped edge bucket, missing intervals, canvas unavailable, or where the series was staged — composed into one string, since `notice` is last-wins) |
| `openaq_list_parameters` | `totalCount` | `notice` when `query` matches nothing |
| `openaq_list_countries` | `totalCount` (countries matched after `query` / `parametersId`, across every page) | When rows remain past the page: `truncated` / `shown` / `cap` and a `notice` naming the next page. `notice` alone when the filters match nothing or the page is past the last one |

`totalCount` is the required spine via the total enricher; `truncated`/`shown`/`cap` are declared
**optional** in every output schema. Enrichment reaches both client surfaces automatically
(`structuredContent` + `content[]` trailer) — empty-result notices and totals go through `ctx.enrich`,
never hand-authored into `format()` text alone (which would leave `structuredContent`-only clients
blind).

`format()` for every tool renders all output fields (value **and** unit on every reading, the
`measured` framing line, `datetimeLast`, the canvas hint) so `content[]`-only clients (Claude
Desktop) see the same picture as `structuredContent` clients (Claude Code). That includes the
**rows**: a formatter that renders a slice of an array the response carries in full leaves the two
clients reasoning over different samples of the same call, and the omitted rows are response data,
not display metadata. So `get_measurements` renders all `PREVIEW_ROWS` of `series` and
`dataframe_query` renders every row inside its 200-row cap — the bounded set is built once and
projected onto both surfaces. The `capped-list-no-truncation` linter enforces disclosure on
`find_locations`, `get_measurements`, and `list_countries`; `format-parity` enforces the field-level half.

---

## Endpoint → tool map

| Tool | OpenAQ v3 endpoint(s) | Notes |
|:-----|:---------------------|:------|
| `openaq_find_locations` | `GET /v3/locations` | `coordinates`+`radius` (≤25000) / `bbox` / `iso`, narrowed by `parameters_id` / `monitor` / `mobile` / `providers_id`; `distance` present only with coordinates; `meta.found` is per-page here, so paging state comes from the rows |
| `openaq_get_readings` | `GET /v3/locations/{id}` + `GET /v3/locations/{id}/latest` | Joined on `sensorsId` — `/latest` has no parameter/unit inline. Coordinates path first calls `/v3/locations` to resolve nearest |
| `openaq_get_measurements` | `GET /v3/locations/{id}` (resolve sensor) + `GET /v3/sensors/{sensorId}/measurements` \| `/measurements/hourly` \| `/measurements/daily` | `datetime_from`/`datetime_to`; `daily`/`hourly` carry a `summary` block; pages internally then spills |
| `openaq_list_parameters` | `GET /v3/parameters` | Whole catalog in one call; filtered locally |
| `openaq_list_countries` | `GET /v3/countries` | Whole catalog in one `limit=1000` call; filtered and paged locally |
| `openaq_dataframe_query` / `_describe` | none (DataCanvas) | Query/describe staged `measurements_<sensorId>` tables |

---

## Workflow Analysis

### `openaq_get_readings` via coordinates (3 upstream calls)

| # | Call | Purpose | Path gate |
|:--|:-----|:--------|:----------|
| 1 | `GET /v3/locations?coordinates={lat,lon}&radius=25000&parameters_id={id}&limit=1000` | Candidate pool, sorted by distance in the service; `results[0]` is the nearest station measuring the parameter. A full 1,000-row page adds the nearest-of-the-first-1,000 `notice` | `coordinates` path only |
| 2 | `GET /v3/locations/{id}` | Sensor→parameter→unit map | always |
| 3 | `GET /v3/locations/{id}/latest` | Latest values keyed by sensorsId | always |
| — | Join 3 against 2 on `sensorsId` | Attach parameter + unit to each value | always |

When called by `locationId`, step 1 is skipped (2 calls). Steps 2 and 3 run in `Promise.all`. The
free-tier budget (~60 req/min) is the reason this is a fixed 2–3 calls and never fans out per sensor
or pages past step 1's first page.

### `openaq_get_measurements` (2–N upstream calls + optional spill)

| # | Call | Purpose |
|:--|:-----|:--------|
| 1 | `GET /v3/locations/{locationId}` | Find the sensor whose `parameter.id === parametersId` |
| 2…N | `GET /v3/sensors/{sensorId}/measurements[/hourly\|/daily]?datetime_from=…&datetime_to=…&page=…` | Pull the series, paging until the 5000-row ceiling or the range is exhausted |
| spill | `spillover()` → register `measurements_<sensorId>` on the canvas | Stage the full set when it exceeds the inline preview |

Surfaces the design question: cap internal paging so an unbounded `raw` range over years doesn't
loop forever — page up to a row ceiling (5000), then rely on the canvas + `totalCount` to
tell the agent the series is larger and steer it to `daily` aggregation or a narrower range. A
`limit` that does not divide the ceiling overshoots on the last page; the excess is sliced off
before counting or staging, and still counts toward `totalCount`. A rollup series that ends
exactly on the ceiling is recognized as complete from its exact `meta.found`, with no extra
request to prove the end.

---

## Implementation Order

1. **Config + service** — `src/config/server-config.ts` (`OPENAQ_API_KEY` required, `OPENAQ_API_BASE_URL`); `src/services/openaq/openaq-service.ts` (`X-API-Key` header injection, `withRetry`, plain-text-500 / 422 / 404 classification, the six methods); `src/services/openaq/types.ts` (raw response types mirroring the probed shapes).
2. **`openaq_list_parameters`** — fetch + local filter + `pollutantsOnly`; validates the parameter shape the other tools depend on.
3. **`openaq_list_countries`** — fetch + local filter.
4. **`openaq_find_locations`** — coordinates/bbox/iso scopes, parametersId narrowing, reshape `sensors[]` → `parameters[]`, distance + datetimeLast surfacing, scope validation, truncation enrichment.
5. **`openaq_get_readings`** — locationId + coordinates paths; the latest×sensors join; nearest-station resolution.
6. **`openaq_get_measurements`** — sensor resolution, aggregation routing, internal paging, DataCanvas spillover.
7. **`openaq_dataframe_query` / `openaq_dataframe_describe`** — canvas-accessor wiring (`setCanvas` in `setup()`), the api-canvas recipe.
8. **Resources** — `openaq://location/{locationId}`, `openaq://parameters`.

Each step independently testable: the service against mocked fetch + the captured fixture payloads
(include a sparse case — `displayName: null`, empty `sensors[]`, dormant station with old
`datetimeLast`); tools against fixtures; the latest×sensors join (step 5) and sensor resolution
(step 6) are the highest-complexity integrations.

---

## Known Limitations

- **Coverage is uneven and real.** Dense in North America/Europe, sparse elsewhere; many regions
  have no monitoring at all. Empty results mean no coverage, not clean air — surfaced in every
  discovery description. The modeled `open-meteo` air-quality tool is the anywhere-coverage fallback.
- **Measurements are sensor-scoped.** A station with five sensors needs five `get_measurements`
  calls (one per parameter) for a full historical picture. The tool hides the sensor id but not the
  per-parameter granularity. This is inherent to the v3 API.
- **Units vary and are not converted.** µg/m³ ↔ ppm/ppb conversion is gas- and
  temperature-dependent; the server returns the source unit and never converts, to avoid fabricating
  precision. Agents comparing across stations must account for unit differences (and can use the
  `who-gho` server for guideline thresholds in the matching unit).
- **Recency varies by station.** Reporting cadence ranges from sub-hourly to daily; some stations go
  dormant. `datetimeLast` (discovery) and per-value timestamps (readings) expose this — "latest" is
  not "live" for every station.
- **No coordinate validation upstream.** Out-of-range lat/lon yields a plain-text HTTP 500, not a
  clean 4xx. The server bounds coordinates and radius in Zod; the service's parse-failure rule is
  the backstop.
- **Radius hard-capped at 25000m.** Larger areas need `bbox` (which returns no distance) or multiple
  searches.
- **No native cross-station comparison endpoint.** Comparing measured air quality across locations is
  done by the agent (multiple `get_readings`/`get_measurements` calls, or staging multiple series on
  one canvas and joining in SQL) — there is no single OpenAQ call for it.
- **Health-snapshot / WHO-grading is a cross-server workflow, not a tool here.** Geocode → nearest
  station → latest → grade against WHO guidelines spans `openstreetmap`/`open-meteo`, `openaq`, and
  `who-gho`. Keeping it out of this server's surface avoids hardcoding one network's guideline values
  and respects the single-source boundary.

---

## API Reference

### Base + auth

```
Base:  https://api.openaq.org/v3
Auth:  X-API-Key: <OPENAQ_API_KEY>   (request header; required on every call)
Rate:  ~60 req/min (free tier)
```

### URL patterns (live-probed 2026-06-13)

```
Locations:    GET /v3/locations?coordinates={lat,lon}&radius={≤25000}&limit={n}
              GET /v3/locations?bbox={minLon,minLat,maxLon,maxLat}
              GET /v3/locations?iso={cc}&parameters_id={id}
Location:     GET /v3/locations/{id}
Latest:       GET /v3/locations/{id}/latest
Measurements: GET /v3/sensors/{id}/measurements?datetime_from={d}&datetime_to={d}&limit={≤1000}&page={n}
              GET /v3/sensors/{id}/measurements/hourly?...
              GET /v3/sensors/{id}/measurements/daily?...
Parameters:   GET /v3/parameters
Countries:    GET /v3/countries
```

### Response envelope

All list endpoints wrap results in `{ "meta": { "page", "limit", "found" }, "results": [...] }`.
What `meta.found` means depends on the endpoint (measured 2026-09-23):

- **Sensor measurements** (`/v3/sensors/{id}/measurements[/hourly|/daily]`): a total across pages —
  a number, or a string like `">1000"` when it is a lower bound. Passing the raw string to
  `ctx.enrich.total()` would poison the `totalCount` field, so the service resolves it with
  `interpretFound` → `{ total, isLowerBound }`: the digits are a **floor**, never an exact total,
  and the flag says which it is. The value is never collapsed to `Infinity` — that cannot be
  published to a caller, and treating it as a sentinel to fall back from is what made an
  incomplete pull report its own row count as the series total. A caller that exhausts the range
  ignores `meta.found` entirely: its own count is exact.
- **Locations** (`/v3/locations`): **not a total.** It counts only the page returned — the string
  `">limit"` whenever the page is full, even when no later page holds anything, and the page's
  own row count otherwise (`0` past the end). `find_locations` therefore never reads it: every
  earlier page was full, so `(page − 1) × limit + rows` is the count through this page — exact on
  a short page, a floor on a full one.

Pagination is `page` + `limit` (1-based).

### Error envelope (live-probed)

| Status | Body | Cause | Maps to |
|:-------|:-----|:------|:--------|
| 404 | `{"detail":"Location not found"}` (clean JSON) | Unknown location id | `NotFound` (`location_not_found`) |
| 422 | `"[{'type': '...', 'loc': ..., 'msg': '...'}]"` (**Content-Type: application/json but body is a JSON string wrapping a Python repr** — NOT a JSON array) | Out-of-range param (e.g. `radius=26000`) | `ValidationError` — `JSON.parse(body)` yields a `string`; regex-extract `msg` value from it |
| 401 | `{"detail":"Invalid credentials"}` (rejected key) or `{"message":"…"}` (missing key) | Missing / invalid `X-API-Key` | `Unauthorized` (`invalid_api_key`), not retried |
| 429 | — | Rate limit (>~60/min) | `RateLimited` (`rate_limited`), retryable — honor `Retry-After` |
| **500** | `Internal Server Error` (plain text) | **Unvalidated bad input** (e.g. `coordinates=999,999`) | Defended at the Zod edge; backstop → transient `ServiceUnavailable`, NOT `SerializationError` |

### Canonical parameter catalog (the units reference — design-time snapshot; `openaq_list_parameters` is the live list)

The duplication is the point: pick the id whose unit you want.

| id | code | unit | display |
|:---|:-----|:-----|:--------|
| 1 | pm10 | µg/m³ | PM10 |
| 2 | pm25 | µg/m³ | PM2.5 |
| 3 | o3 | µg/m³ | O₃ mass |
| 4 | co | µg/m³ | CO mass |
| 5 | no2 | µg/m³ | NO₂ mass |
| 6 | so2 | µg/m³ | SO₂ mass |
| 7 | no2 | ppm | NO₂ |
| 8 | co | ppm | CO |
| 9 | so2 | ppm | SO₂ |
| 10 | o3 | ppm | O₃ |
| 11 | bc | µg/m³ | BC |
| 15 | no2 | ppb | NO₂ |
| 19 | pm1 | µg/m³ | PM1 |
| 21 | co2 | ppm | CO₂ |
| 22 | wind_direction | deg | Wind direction |
| 23 | nox | ppb | NOX |
| 24 | no | ppb | NO |
| 27 | nox | µg/m³ | NOx mass |
| 28 | ch4 | ppm | CH₄ |
| 32 | o3 | ppb | O₃ |
| 33 | ufp | particles/cm³ | UFP count |
| 34 | wind_speed | m/s | Wind speed |
| 35 | no | ppm | NO |
| 95 | pressure | hpa | Atmospheric pressure |
| 98 | relativehumidity | % | RH |
| 100 | temperature | c | Temperature (C) |
| 101 | so2 | ppb | SO₂ |
| 102 | co | ppb | CO |
| 125 | um003 | particles/cm³ | PM0.3 count |
| 126 | um010 | particles/cm³ | PM1 count |
| 128 | temperature | f | Temperature (F) |
| 130 | um025 | particles/cm³ | PM2.5 count |
| 132 | pressure | mb | Pressure |
| 134 | humidity | % | H |
| 135 | um100 | particles/cm³ | PM10 count |
| 19840 | nox | ppm | NOx |
| 19843 | no | µg/m³ | NO mass |
| 19844 | pm4 | µg/m³ | PM4.0 |
| 19861–19866 | bc_375…bc_370 | ng/m³ | BC by wavelength |

`pollutantsOnly` excludes the meteorological/auxiliary rows (wind_*, pressure, *humidity,
temperature, um*/ufp particle-count channels) and returns the pollutant rows. The list is fetched
live (not hardcoded) so new parameters appear automatically; this table documents what to expect.

---

## Decisions Log

| Date | Decision | Rationale |
|:-----|:---------|:----------|
| 2026-06-13 | **Five domain tools** (`find_locations`, `get_readings`, `get_measurements`, `list_parameters`, `list_countries`) + two DataCanvas consumer tools, matching the idea sketch exactly. | Maps cleanly to the five user goals (find stations, latest, history, units, coverage). No tool earns a cut; none missing. The canvas pair is required infrastructure, not a sixth domain tool. |
| 2026-06-13 | **`parametersId` (numeric id) is the parameter selector across all tools**, not a bare pollutant name. | Live catalog proves the same pollutant has multiple ids for different units (CO: 4/8/102). A name is ambiguous about units; the id is exact. `list_parameters` maps name+unit → id. |
| 2026-06-13 | **`get_measurements` resolves the sensor internally** via `/locations/{id}` → match `parameter.id` → `/sensors/{sensorId}/measurements`. Agent passes location + parameter, never a sensor id. | v3 made measurements sensor-scoped; exposing sensor ids would force the agent to walk the hierarchy. Hiding it is the server's core UX job. |
| 2026-06-13 | **`get_readings` joins `/locations/{id}/latest` against the `/locations/{id}` sensor map.** | Probing showed `/latest` is keyed only by `sensorsId` with no parameter/unit inline. Without the join, values would be unlabeled numbers — violating "always return the unit." |
| 2026-06-13 | **Never convert units; return the source unit with every value.** `list_parameters` documents the duplication. | µg/m³ ↔ ppm/ppb conversion is gas- and temperature-dependent. A silent conversion fabricates precision and would mislead both human and agent (core-principle: don't fabricate signal). |
| 2026-06-13 | **Measured-vs-modeled stated in every discovery description; empty result ≠ clean air; point at `open-meteo` for modeled coverage.** | The defining design choice. It's the reason both servers earn fleet slots, and the single most dangerous misread an agent can make about sparse measured data. |
| 2026-06-13 | **DataCanvas spillover on `get_measurements` ONLY.** Discovery tools (locations/parameters/countries) never spill. | Canvas earns its keep on *shape* (analytical — agent runs GROUP BY / joins series), not size. Discovery surfaces are categorical find-then-drill-in and fail the shape gate regardless of row count. |
| 2026-06-13 | **Truncation fields (`truncated`/`shown`/`cap`) declared OPTIONAL in output; `totalCount` required via the total enricher.** | The framework populates truncation enrichers only when the cap is hit; declaring them required throws -32007 on every non-truncated result. |
| 2026-06-13 | **Validate lat/lon + radius bounds in Zod at the edge.** | Live probe: `coordinates=999,999` returns a plain-text HTTP 500, not a clean 4xx. Bounding the input prevents a confusing upstream crash; the service parse-failure rule is the backstop. |
| 2026-06-13 | **`find_locations` supports `coordinates+radius`, `bbox`, AND `iso`; requires at least one scope.** | All three confirmed live. `bbox` enables area sweeps (no distance); `iso` enables country lists. An unfiltered global location list is not useful and risks a huge response. |
| 2026-06-13 | **`aggregation: raw\|hourly\|daily` on `get_measurements`**, surfacing the `summary` block for hourly/daily. | Both rollup endpoints confirmed live (200) with a rich per-bucket `summary`. `daily` keeps multi-month trends small; `raw` serves fine-grained recent analysis. |
| 2026-06-13 | **Single `OpenAqService`, six methods.** | One base URL, one auth header, one error envelope, one retry policy. No API seam justifies splitting (open-meteo precedent: single service, six endpoints). |
| 2026-06-13 | **Two resources** (`openaq://location/{id}`, `openaq://parameters`) as tool-output mirrors. | Both are stable-URI, read-only, useful as injectable context; both fully covered by the tool surface for tool-only clients. |
| 2026-06-13 | **No prompts.** | Data-lookup domain; no recurring analysis template. The health-snapshot idea is a cross-server workflow, deliberately not localized here. |
| 2026-06-13 | **Identity is the hyphenated `openaq-mcp-server` everywhere** (createApp `title`, manifest `display_name`); never Title Case. `name`+`title` only in createApp — no `description`/`websiteUrl` duplication. | Fleet identity rule: machine name on every surface; Title Case is a strong agent prior to strike. `description` derives from `package.json`. |
| 2026-06-13 | **Framework held at `@cyanheads/mcp-ts-core` ^0.10.6** — not bumped. | The design targets the pinned framework version; upgrades are handled deliberately, out of band. |
| 2026-09-22 | **`dataframe_query` caps responses at 200 rows**, forwarding the provider's `truncated` and naming `ORDER BY <column> LIMIT 200 OFFSET <n>` as the continuation. No `nextOffset` output field. | The 10,000-row canvas default is a DuckDB ceiling, not a response budget: a `CROSS JOIN` over a staged series reached it at ~1.8 MB. 200 keeps the widest staged row shape near 37 KB. `LIMIT`/`OFFSET` is the idiom for a SQL surface and already works, and a server-computed offset would promise an ordering the tool cannot guarantee. Capping and disclosing teaches more than rejecting an unbounded query. |
| 2026-09-22 | **`format()` renders every row the response carries**, on both `get_measurements` and `dataframe_query`. The bounded set is built once and projected onto both surfaces. | Row slices in `format()` (20 of 100, 50 of N) left a text-only client and a structured-content client reasoning over different samples of the same call. Omitted rows are response data, not display metadata, and with DataCanvas off there is no retrieval path for them at all. The cost is bounded by the preview and the query cap, which already exist. |
| 2026-09-22 | **A supplied `canvas_id` stages the series whatever its size**; omitting it leaves a series that fits inline touching no canvas. | Reading the id only inside the overflow branch discarded it silently on a narrow range — the caller got no `canvasId`, no error, and nothing to join against, while the same bad id on a wide range raised `canvas_not_found`. The verdict on an id must not depend on the result size. Minting on every small call instead would burn tenant canvas slots for nothing. |
| 2026-09-22 | **A re-stage that replaced an earlier table says so** in the staging notice, rather than changing the `measurements_<sensorId>` naming. | One table per sensor keeps re-staging the same pull idempotent, which is the common case. The cost is that the same sensor at another aggregation or window silently replaced the earlier series while the docs described reuse as additive. `drop()` already reports whether it removed a table, so the replacement is disclosed at no structural cost. |
| 2026-09-23 | **`find_locations` rejects `coordinates`+`bbox` and `radius` without `coordinates` as `invalid_search_scope`; `radius` loses its schema default.** | OpenAQ answers both with HTTP 500, which surfaced as a retried `upstream_error`, while `radius` with only `bbox`/`iso` was silently dropped. Rejecting beats a "radius ignored" notice: the value means nothing without a center, and a notice would be overwritten by the full-page guidance. The service keeps the 12000 fallback. |
| 2026-09-23 | **`find_locations` paging state comes from the rows, never `meta.found`**; an empty page past the first is `page_exhausted`, not `no_locations_found`. No `nextPage`/`hasNextPage`. | `/v3/locations` reports a per-page count (`">limit"` on any full page, even the last), so it misreported totals on every later page and read an exhausted page as missing coverage. A next page's existence is never known without fetching it, so a full page is disclosed as a floor instead. `page_exhausted` stays an error so a successful call never returns an empty list. |
| 2026-09-23 | **`iso` accepts either case (normalized to uppercase) and OpenAQ's `-99` placeholder**, forwarded unchanged. | OpenAQ matches `iso` case-sensitively, so `"us"` read as no coverage; `-99` is the code `list_countries` returns for Dhekelia and OpenAQ serves it as a filter. |
| 2026-09-23 | **`monitor`, `mobile`, and `providersId` are forwarded filters, not scopes**; each location carries `providerId`. Single provider id, no filter echo. | Client-side filtering of a page misses matches on later pages; OpenAQ owns these filters. `providerId` makes the filter value readable from a prior result. |
| 2026-09-23 | **Id inputs are positive at the schema** (`locationId`, `parametersId`, `providersId`); the location resource keeps its handler check and declares `invalid_location_id` as `ValidationError`. | A non-positive `locationId` reached OpenAQ and surfaced its raw 422; a non-positive `parametersId` is accepted upstream as a filter that matches nothing, so it read as missing coverage. No such id exists (both catalogs start at 1), so the bound drops nothing that resolves. A `params` bound on the resource would drop the reason and recovery hint; `ValidationError` is the framework's own code for a rejected resource segment and separates "not an id" from "no such station". |
| 2026-09-23 | **A date-only bound on `get_measurements` is the station's local calendar day, for every aggregation**: `datetimeFrom` opens at local midnight, `datetimeTo` closes at the next one, resolved from the timezone on the location lookup the handler already makes. Explicit timestamps pass through; a station with no timezone gets UTC days plus a notice. The response echoes `effectiveRange`, flags clipped edge buckets, and reports hourly/daily gaps (`gapCount`, first 20 `gaps`). | OpenAQ's daily buckets are local days and its hours are end-labeled with an inclusive `datetime_to`, so UTC bounds (`T00:00:00Z`…`T23:59:59Z`) returned two clipped partial days whose aggregates looked like real daily values, and dropped the last hour on every aggregation. One rule for all aggregations keeps a daily bucket equal to the hours the same request returns; UTC days for raw/hourly would make "2026-08-01" mean different hours by aggregation. Gaps are read from bucket boundaries, never a fixed step, because OpenAQ already encodes DST as 23/25-hour days and a 2-hour bucket; raw is excluded because its rows follow no cadence. |
| 2026-09-23 | **The `get_measurements` pull stops at exactly 5,000 rows, and a series counts as complete when the pager saw a short page or an exact `meta.found` matches the rows fetched.** Rows sliced off the last page still count toward the `totalCount` floor. | A `limit` that does not divide 5,000 overshot the ceiling while the cap notice named it. Only the `/hourly` and `/daily` rollups report an exact total; raw answers every full page with `">limit"`, so a rollup ending on the ceiling is recognized as complete with no extra request, while a raw series ending there stays incomplete because nothing proves its end. |
| 2026-09-23 | **`list_countries` pages the filtered catalog** with `limit` (1–100, default 20) and `page`, in `find_locations`' vocabulary (`totalCount`, optional `truncated`/`shown`/`cap`, `notice`). A page past the end is an empty success naming the last page. No `totalFound`/`returnedCount`/`nextPage` fields, no summary mode. | Reverses the earlier call that the catalog was small enough to return whole: unfiltered it was 158 countries, ~74 KB of `structuredContent`, and `parametersId: 2` still matched 156. A default of 20 keeps a page near 16 KB. The whole catalog is fetched, so the total is exact and the last page is known — a past-end page can name it, and it follows this tool's empty-result convention (success plus notice) rather than `find_locations`' `page_exhausted`, where the end is never known. |
| 2026-09-23 | **`get_readings` resolves the nearest station from a 1,000-row candidate pool** (OpenAQ's page maximum; 1001 is a 422) and sets a `notice` when that page comes back full. No paging past the first page. | `/v3/locations` sorts only by id, so the earlier 100-row pool held the 100 oldest stations and missed newer, nearer ones: around Los Angeles (PM2.5, 25 km) 283 stations match and the nearest is row 276. The larger page costs extra only when more than 100 match — for LA the response grows from 139 KB to 380 KB (median over five requests 0.49 s → 0.59 s); a Seattle search with 88 matches returns identical bytes. No observed search nears 1,000, so paging on would spend requests against a ~60/min budget for a case never seen; disclosing the full page is the cheaper honest answer. |
| 2026-09-23 | **Missing upstream location values stay null on the tool surface**: `coordinates` is null unless both latitude and longitude are numbers (`find_locations`, `get_readings`), and `country` and `provider` are null on `find_locations` when OpenAQ lists none. `format()` renders each as "not listed by OpenAQ". | The shapers used to substitute `0`, `XX`, and `Unknown`, which read as a real point in the Gulf of Guinea, a country code, and a provider name. A half-known point cannot be plotted, so a single null side nulls the pair rather than pushing the check onto every caller. Nulls at the object level stay handled even though OpenAQ's schema requires those objects, so one sparse station never fails a whole page. |

---

## Checklist (design-phase)

- [x] Server scope: single rich API, large audience → standalone server named for the platform (`openaq-mcp-server`)
- [x] External API researched and **live-probed** (locations, location detail, latest, sensor measurements, hourly/daily rollups, parameters, countries; 404/422/500/401 error cases)
- [x] User goals enumerated → five domain tools; surface audited (no cuts, none missing)
- [x] Tool surface self-sufficient for tool-only agents
- [x] Tool descriptions concrete; measured-vs-modeled + "empty ≠ clean air" + cross-server pointers in-surface
- [x] Parameter `.describe()` explains value, effect, and the units/sensor-resolution gotchas
- [x] Input schemas use constrained types (regex coordinates/bbox/dates, bounded radius/limit, enums)
- [x] Output schemas designed for the next action — chaining ids (location→readings→measurements), units on every value, datetimeLast, canvas handle
- [x] Typed error contracts per network tool (reason/code/when/recovery/retryable); recovery names the next move
- [x] Annotations set (readOnly/idempotent/openWorld on data tools; openWorld off for the static-ish catalogs)
- [x] DataCanvas earns its keep on analytical shape (`get_measurements` only); `dataframe_query`+`dataframe_describe` paired; degrades gracefully without DuckDB
- [x] Capped-list truncation fields OPTIONAL; `totalCount` required via total enricher
- [x] Service layer planned with resilience (retry boundary, backoff for 429, plain-text-500/422/404 classification)
- [x] Config env vars identified (`OPENAQ_API_KEY` required → server-config.ts, server.json, manifest.json)
- [x] Resources use `{param}` templates; both covered by tools
- [x] Design doc written to `docs/design.md`

---

## Review pass

_Independent review pass — 2026-06-13. All changes verified against the live API (`api.openaq.org/v3`)._

### Fixes applied

| # | Location | Issue | Fix |
|:--|:---------|:------|:----|
| 1 | `openaq_find_locations` output schema | `datetimeLast` and `datetimeFirst` declared as `z.string().nullable()` — but the live API returns `{ "utc": "...", "local": "..." }` objects, not strings. Confirmed on both `/v3/locations` (list) and `/v3/locations/{id}`. | Changed both to `z.object({ utc: z.string(), local: z.string() }).nullable()`. |
| 2 | `openaq_get_readings` output schema | Location object lacked `datetimeLast` — agents had no way to assess staleness without an extra `find_locations` call. The data is already in hand: the readings handler fetches `/locations/{id}` for the sensor map, which carries `datetimeLast`. | Added `datetimeLast: z.object({utc, local}).nullable()` to the location output block. |
| 3 | `openaq_get_measurements` output schema: `summary.sd` | `sd: z.number()` — but live probe of `/measurements/hourly` shows `"sd": null` for single-reading buckets. Required declaration would throw -32007 ValidationError on any single-reading hourly bucket. | Changed to `sd: z.number().nullable()`. |
| 4 | Data model comment: `distance` field in bbox results | Comment said "present ONLY when coordinates+radius given (absent/null for bbox)" — live probe shows the key IS present in bbox results, with value `null`. | Corrected to "present always, null when no center point (bbox / iso queries)". |
| 5 | `openaq_get_measurements` error contract: `canvas_unavailable` | Listed in `errors[]` as a thrown error, but the design text immediately below said "the handler still returns the truncated preview … rather than throwing." An `errors[]` entry is for thrown errors; a non-throwing entry is a contract lie that would confuse implementors and `tools/list` consumers. | Removed `canvas_unavailable` from `errors[]`. Replaced with a plaintext note explaining the degraded-mode behavior (returns preview + `notice` enrichment; never throws). The `dataframe_*` tools still throw `canvas_unavailable` when invoked without DuckDB — that's correct and unchanged. |
| 6 | 422 error envelope documentation | Described body as `[{ "type": "...", ... }]` (Pydantic JSON array). Live probe: actual body is `"[{'type': '...', ...}]"` — a **JSON string wrapping a Python `repr`** (single-quoted dicts, not valid JSON). `JSON.parse(body)` gives a `string`, not an array. | Updated error table and resilience row to call out the body format and require regex extraction of `msg` instead of JSON parsing. |
| 7 | `meta.found` handling: `totalCount` | Note said "treat `>N` as there are more" without specifying how the service should derive `totalCount`. Passing the raw string `">2"` to `ctx.enrich.total()` would poison the field. | Added explicit parse rule: `typeof found === 'number' ? found : Infinity` (or strip leading `>`). Superseded 2026-09-22 — see "Response envelope": the digits are a floor plus a lower-bound flag, never `Infinity`. |
| 8 | `openaq_get_readings` sensorId describe: typo | `'Sensor id — pass to openaq_get_measurements territory via locationId+parametersId for this sensor\'s history'` — "territory via" is garbled. | Reworded to `'Sensor id — use the corresponding locationId + parametersId to fetch this sensor\'s history via openaq_get_measurements'`. |

### Verified correct (no change needed)

- **`/latest` lacks `parameter`/`unit` inline** — confirmed live; `sensorsId` only. Join against `/locations/{id}` sensors[] is the correct design.
- **`parametersId` (numeric id) as the parameter selector** — correct. Live catalog confirms the same pollutant has multiple ids per unit variant.
- **Units never normalized** — correct. `co` is id 4 (µg/m³), 8 (ppm), 102 (ppb); server returns source unit verbatim.
- **Auth: `X-API-Key` header** — confirmed live (not a query param).
- **Radius cap 25000m** — confirmed live; 422 on 26000.
- **`openaq_list_countries` `datetimeFirst`/`datetimeLast` as plain ISO strings** — correct; the countries endpoint returns strings, not `{utc, local}` objects (different from the locations endpoint).
- **`summary` block: `sd` nullable for single-reading hourly buckets** — confirmed live.
- **DataCanvas: `get_measurements` only; discovery tools never spill** — earns keep on analytical shape, correct.
- **Truncation fields `truncated`/`shown`/`cap` declared `.optional()`** — required-truncation-field bug correctly pre-empted.
- **Identity: `openaq-mcp-server` (hyphenated) on every surface; `name`+`title` only in `createApp()`** — correct per fleet identity rule.
- **`displayName` nullable in measurements `parameter` block** — confirmed live (`null` observed). Correct in all schemas.
- **`percentComplete`** in measurements — confirmed live; part of the `coverage` block, correctly surfaced in the output schema.
