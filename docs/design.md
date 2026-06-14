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
| `openaq_find_locations` | Find air-quality monitoring stations (measured, not modeled) near a point, in a bounding box, or by country. Returns location id, name, coordinates, distance, country, provider, the parameters each measures, and `datetimeLast`. Required first step — readings and measurements key on the location/sensor ids this returns. A missing station means no coverage, not clean air. | `coordinates`, `radius`, `bbox`, `iso`, `parametersId`, `limit` | `readOnlyHint`, `idempotentHint`, `openWorldHint` |
| `openaq_get_readings` | Latest measured value for every sensor at a location (or the nearest location to coordinates). Returns per parameter: value, unit, UTC + local timestamp, and the sensor id — joined so each value carries its pollutant and unit. The current-conditions tool. Recency varies by station; each value's timestamp shows whether "latest" is minutes or hours old. | `locationId` \| (`coordinates` + `parametersId`), `parametersId` | `readOnlyHint`, `idempotentHint`, `openWorldHint` |
| `openaq_get_measurements` | Historical measurement series for one parameter at a location over a date range. Resolves the location's sensor for that parameter internally (measurements are sensor-scoped in v3) so you pass a location, not a sensor. Optional `aggregation` (`raw`/`hourly`/`daily`) — `daily` adds a per-day statistical summary. Large ranges spill to DataCanvas; the response carries `canvasId` + a truncated preview, queryable via `openaq_dataframe_query`. | `locationId`, `parametersId`, `datetimeFrom`, `datetimeTo`, `aggregation`, `canvasId` | `readOnlyHint`, `idempotentHint`, `openWorldHint` |
| `openaq_list_parameters` | Catalog of measurable pollutants and their canonical units: id, code, display name, unit, description (pm25, pm10, o3, no2, so2, co, bc, …). The unit-disambiguation tool — the same pollutant exists under several ids with different units (`co` is id 4 µg/m³, id 8 ppm, id 102 ppb). Call this to pick the right `parametersId` and to interpret a reading's unit. | `query` (local filter), `pollutantsOnly` | `readOnlyHint`, `idempotentHint` |
| `openaq_list_countries` | Catalog of country coverage: id, ISO code, name, station-data date span (`datetimeFirst`/`datetimeLast`), and the parameters measured anywhere in that country. Availability check before a regional `openaq_find_locations` sweep — answers "which countries have NO2 monitoring?". | `query` (local filter) | `readOnlyHint`, `idempotentHint` |
| `openaq_dataframe_query` | Run a read-only SQL `SELECT` against the measurement tables `openaq_get_measurements` staged on a DataCanvas. Reference tables by the name the measurements call returned (`measurements_<sensorId>`). For aggregation and cross-sensor comparison over series too large to inline. | `canvasId`, `sql` | `readOnlyHint` |
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
CO, BC, and ~38 more parameters — from government reference monitors and research-grade sensors
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
- Location discovery by `coordinates` (`lat,lon`) + `radius` (metres, **0–25000, hard-capped by the
  API**), by `bbox` (`minx,miny,maxx,maxy`), and by country `iso` code; optional `parametersId`
  narrows to locations that measure a given parameter.
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

- `findLocations(params)` → `LocationsResponse` (`/locations` with coordinates+radius / bbox / iso / parametersId)
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

The 500-on-bad-coordinates case is defended primarily at the **Zod edge** (bounded lat/lon/radius);
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
near a point, within a bounding box, or by country. Returns each station's id, name, coordinates,
distance from the query point (when searching by coordinates), country, provider, the parameters its
sensors measure, and the timestamp of its most recent data (`datetimeLast`). Required first step:
`openaq_get_readings` and `openaq_get_measurements` key on the location id this returns. Coverage is
uneven and real — a station only reports the parameters it measures, and the absence of a nearby
station means no monitoring there, not clean air. For dense modeled coverage anywhere on Earth, use
`open-meteo-mcp-server`'s air-quality tool instead.

**Input schema:**
```ts
{
  coordinates: z.string().regex(/^-?\d{1,3}(\.\d+)?,-?\d{1,3}(\.\d+)?$/).optional()
    .describe('Center point as "latitude,longitude" (e.g. "47.6062,-122.3321"). Pair with radius for a near-me search. Resolve a place name to coordinates with openstreetmap-mcp-server or open-meteo geocode first. Provide either coordinates+radius OR bbox, not both.'),
  radius: z.number().int().min(1).max(25000).default(12000)
    .describe('Search radius in metres around coordinates (1–25000; the API hard-caps at 25000). Default 12000 (~12km). Only used with coordinates.'),
  bbox: z.string().regex(/^(-?\d+(\.\d+)?,){3}-?\d+(\.\d+)?$/).optional()
    .describe('Bounding box as "minLon,minLat,maxLon,maxLat" (west,south,east,north). Alternative to coordinates+radius for area sweeps. Results have no distance field (no center point).'),
  iso: z.string().length(2).optional()
    .describe('Restrict to a country by ISO 3166-1 alpha-2 code (e.g. "US", "IN", "DE"). Combine with bbox/coordinates to scope, or use alone for a country-wide list. Discover coverage with openaq_list_countries.'),
  parametersId: z.number().int().optional()
    .describe('Only return stations that measure this parameter id (e.g. 2 = PM2.5 µg/m³). Get ids from openaq_list_parameters — the same pollutant has several ids for different units. Narrows the station set; each returned station still lists all its sensors.'),
  limit: z.number().int().min(1).max(100).default(20)
    .describe('Max stations to return (1–100). Default 20. Results are ordered by distance when searching by coordinates.'),
}
```
Handler validates that at least one of `coordinates`, `bbox`, or `iso` is provided (else
`validationError` — an unfiltered global location list is not useful and risks a huge response).

**Output schema:**
```ts
{
  locations: z.array(z.object({
    id: z.number().describe('Location id — pass to openaq_get_readings / openaq_get_measurements'),
    name: z.string().describe('Station name'),
    locality: z.string().nullable().describe('Locality or metro area, when provided'),
    country: z.object({
      code: z.string().describe('ISO 3166-1 alpha-2 country code'),
      name: z.string().describe('Country name'),
    }).describe('Country the station is in'),
    coordinates: z.object({
      latitude: z.number().describe('Station latitude (decimal degrees)'),
      longitude: z.number().describe('Station longitude (decimal degrees)'),
    }).describe('Station location'),
    distanceMeters: z.number().nullable().describe('Distance from the query coordinates in metres. Null when searching by bbox or iso (no center point).'),
    provider: z.string().describe('Data provider / network (e.g. "AirNow", "OpenAQ LCS")'),
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
  })).describe('Matching stations. Empty array means no monitoring coverage for the query — NOT clean air. Widen the radius, try openaq_list_countries, or use the modeled open-meteo air-quality tool.'),
}
// enrichment (optional, framework-populated): totalCount (total matches), truncated/shown/cap when limit was hit
```

**Errors:**
```ts
errors: [
  { reason: 'no_locations_found', code: JsonRpcErrorCode.NotFound,
    when: 'No monitoring stations match the given area or filters',
    recovery: 'Widen the radius (up to 25000m), drop the parametersId filter, check coverage with openaq_list_countries, or fall back to the modeled open-meteo air-quality tool. No station does not mean clean air.',
    retryable: false },
  { reason: 'no_search_scope', code: JsonRpcErrorCode.ValidationError,
    when: 'None of coordinates, bbox, or iso was provided',
    recovery: 'Provide coordinates+radius for a near-me search, bbox for an area, or iso for a country.',
    retryable: false },
  { reason: 'upstream_error', code: JsonRpcErrorCode.ServiceUnavailable,
    when: 'OpenAQ returned 5xx, a rate-limit (429), or timed out',
    recovery: 'Retry after a short backoff. The free tier allows ~60 requests per minute.',
    retryable: true },
]
```

---

### `openaq_get_readings`

**Description:** Latest measured value for every sensor at a monitoring station — the
current-conditions tool. Returns one record per parameter, each with the value, its unit, the UTC
and local timestamp, and the sensor id, joined so every value carries its pollutant and unit (the
raw latest feed is keyed only by sensor id). Pass a `locationId` from `openaq_find_locations`, or
pass `coordinates` to auto-resolve to the nearest station that measures the requested
`parametersId`. Data recency varies by station reporting cadence — read each value's timestamp to
know whether "latest" is minutes or hours old. These are measured observations with coverage gaps,
not a modeled grid.

**Input schema:**
```ts
{
  locationId: z.number().int().optional()
    .describe('Station id from openaq_find_locations. Provide this OR coordinates. When set, returns the latest value for every sensor at this station.'),
  coordinates: z.string().regex(/^-?\d{1,3}(\.\d+)?,-?\d{1,3}(\.\d+)?$/).optional()
    .describe('Fallback "latitude,longitude" when you do not have a locationId — resolves to the nearest station (within 25km) that measures parametersId, then reads its latest values. Requires parametersId.'),
  parametersId: z.number().int().optional()
    .describe('Required with coordinates: which parameter id the nearest station must measure (get ids from openaq_list_parameters). With locationId, optionally filters the returned values to this parameter id; omit to get all sensors.'),
}
```
Handler: exactly one of `locationId` / `coordinates` required; `coordinates` requires
`parametersId`. The `coordinates` path is `find_locations(coordinates, radius:25000, parametersId,
limit:1)` → nearest location → readings on it.

**Output schema:**
```ts
{
  location: z.object({
    id: z.number().describe('Station id'),
    name: z.string().describe('Station name'),
    coordinates: z.object({
      latitude: z.number(), longitude: z.number(),
    }).describe('Station coordinates'),
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
```

**Errors:**
```ts
errors: [
  { reason: 'location_not_found', code: JsonRpcErrorCode.NotFound,
    when: 'The locationId does not exist (API returns {"detail":"Location not found"})',
    recovery: 'Verify the id via openaq_find_locations.',
    retryable: false },
  { reason: 'no_station_near_coordinates', code: JsonRpcErrorCode.NotFound,
    when: 'No station within 25km of coordinates measures the requested parametersId',
    recovery: 'Widen your search with openaq_find_locations (radius up to 25000m), try a different parametersId, or use the modeled open-meteo air-quality tool for coverage. No station does not mean clean air.',
    retryable: false },
  { reason: 'no_recent_values', code: JsonRpcErrorCode.NotFound,
    when: 'The station exists but its latest feed returned no values (no recent reporting)',
    recovery: 'Check datetimeLast from openaq_find_locations; the station may be dormant. Try a nearby station.',
    retryable: false },
  { reason: 'missing_coordinates_parameter', code: JsonRpcErrorCode.ValidationError,
    when: 'coordinates was provided without parametersId',
    recovery: 'Provide parametersId so the nearest matching station can be resolved, or pass a locationId instead.',
    retryable: false },
  { reason: 'upstream_error', code: JsonRpcErrorCode.ServiceUnavailable,
    when: 'OpenAQ returned 5xx, a rate-limit (429), or timed out',
    recovery: 'Retry after a short backoff.',
    retryable: true },
]
```

---

### `openaq_get_measurements`

**Description:** Historical measurement series for one pollutant at one station over a date range —
for trend analysis and "was last week worse than the monthly average?". Pass a `locationId` and a
`parametersId`; the tool resolves the station's sensor for that parameter internally (v3 series are
sensor-scoped, but you think in stations). Choose `aggregation`: `raw` (every reported value),
`hourly`, or `daily` — `daily` and `hourly` add a per-bucket statistical summary (min, median,
max, mean, sd). Large ranges produce thousands of rows and spill to a DataCanvas: the response
returns a preview plus a `canvasId` and table name you query with `openaq_dataframe_query`. Values
carry their unit; the server never converts between µg/m³, ppm, and ppb.

**Input schema:**
```ts
{
  locationId: z.number().int()
    .describe('Station id from openaq_find_locations.'),
  parametersId: z.number().int()
    .describe('Parameter id to pull the series for (e.g. 2 = PM2.5 µg/m³). Get ids from openaq_list_parameters. Must be a parameter the station measures — find_locations lists each station\'s parameters.'),
  datetimeFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2}Z)?$/).optional()
    .describe('Start of the range, inclusive. Date "YYYY-MM-DD" or full UTC "YYYY-MM-DDTHH:MM:SSZ". Omit to get the most recent values.'),
  datetimeTo: z.string().regex(/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2}Z)?$/).optional()
    .describe('End of the range, inclusive. Must be on or after datetimeFrom. Omit for "up to now".'),
  aggregation: z.enum(['raw', 'hourly', 'daily']).default('raw')
    .describe('Time bucketing. "raw" = every reported value (often hourly at source). "hourly"/"daily" = server-side rollups with a statistical summary per bucket. Use "daily" for multi-month trends to keep the series small; "raw" for fine-grained recent analysis.'),
  limit: z.number().int().min(1).max(1000).default(1000)
    .describe('Max rows per page from the API (1–1000). Default 1000. The tool pages internally up to the spill threshold.'),
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
    value: z.number().describe('Value for the bucket (the measurement for raw; the bucket aggregate for hourly/daily)'),
    summary: z.object({
      min: z.number(), median: z.number(), max: z.number(),
      avg: z.number(), sd: z.number().nullable().describe('Standard deviation — null when only one reading in the bucket'),
    }).nullable().describe('Per-bucket statistics — present for hourly/daily, null for raw'),
    percentComplete: z.number().nullable().describe('Coverage of the bucket (0–100); low values flag gappy data'),
    flagged: z.boolean().describe('True if the source flagged this value (quality concern)'),
  })).describe('The (possibly previewed) series, newest or oldest first per the API. When truncated, this is a preview — query canvasId for the full set.'),
  rowCount: z.number().describe('Rows in this response (preview length when spilled)'),
  // DataCanvas spill fields — optional, present only when the range spilled:
  canvasId: z.string().optional().describe('DataCanvas id holding the full series. Query with openaq_dataframe_query.'),
  tableName: z.string().optional().describe('Canvas table name for the full series (e.g. "measurements_1701"). Reference it in SQL.'),
  truncated: z.boolean().optional().describe('True when the series exceeded the inline limit and the full set was staged on canvasId. Absent/false when everything fit inline.'),
}
// enrichment: totalCount (total rows in the full series)
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
    when: 'datetimeTo is before datetimeFrom',
    recovery: 'Ensure datetimeTo is on or after datetimeFrom.',
    retryable: false },
  { reason: 'upstream_error', code: JsonRpcErrorCode.ServiceUnavailable,
    when: 'OpenAQ returned 5xx, a rate-limit (429), or timed out',
    recovery: 'Retry after a short backoff.',
    retryable: true },
]
```
**Canvas degraded mode (not a thrown error):** When `CANVAS_PROVIDER_TYPE` is not `duckdb` and the
range would require spillover, the handler returns the truncated preview + `totalCount` and a
`notice` enrichment ("series truncated — enable DataCanvas for the full set"). It does **not** throw
— the truncated preview is still useful. The `dataframe_query`/`dataframe_describe` tools throw
`canvas_unavailable` (`ServiceUnavailable`) when invoked without DuckDB. This non-throwing
degradation must NOT be added to `errors[]` — that contract is for thrown errors only.

---

### `openaq_list_parameters`

**Description:** Catalog of every measurable pollutant and its canonical unit: id, code, display
name, unit, and a one-line description (pm25, pm10, o3, no2, so2, co, bc, and ~38 more). This is the
unit-disambiguation reference — the same pollutant exists under several ids with different units
(CO is id 4 in µg/m³, id 8 in ppm, id 102 in ppb), so use this to pick the exact `parametersId` for
`openaq_find_locations` / `openaq_get_readings` / `openaq_get_measurements` and to interpret a
reading's unit. A small bounded catalog fetched live from OpenAQ.

**Input schema:**
```ts
{
  query: z.string().optional()
    .describe('Local case-insensitive filter on code, display name, and description (e.g. "pm" for particulates, "ozone", "co"). The full catalog is small (~44 entries); omit to list everything. This filters the fetched list on our side — it is not an upstream search.'),
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
  { reason: 'upstream_error', code: JsonRpcErrorCode.ServiceUnavailable,
    when: 'OpenAQ /parameters returned 5xx, a rate-limit, or timed out',
    recovery: 'Retry after a short backoff.',
    retryable: true },
]
```
A `query` with no matches returns an empty array with a `notice` enrichment ("no parameters matched
'<query>'") — not an error; the agent should broaden or drop the filter.

---

### `openaq_list_countries`

**Description:** Catalog of country-level coverage: id, ISO code, name, the date span of available
station data (`datetimeFirst`/`datetimeLast`), and which parameters are measured anywhere in that
country. The availability check before a regional sweep — answers "which countries have NO2
monitoring?" and tells you whether a country has recent data before you call
`openaq_find_locations`. Coverage is uneven worldwide; this surfaces where measured data exists.

**Input schema:**
```ts
{
  query: z.string().optional()
    .describe('Local case-insensitive filter on country code and name (e.g. "united", "IN", "germany"). The list is bounded (~153 countries); omit to list all. Filters the fetched list on our side, not an upstream search.'),
}
```

**Output schema:**
```ts
{
  countries: z.array(z.object({
    id: z.number().describe('Country id (OpenAQ internal)'),
    code: z.string().describe('ISO 3166-1 alpha-2 code — pass as iso to openaq_find_locations'),
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
// enrichment: totalCount
```

**Errors:**
```ts
errors: [
  { reason: 'upstream_error', code: JsonRpcErrorCode.ServiceUnavailable,
    when: 'OpenAQ /countries returned 5xx, a rate-limit, or timed out',
    recovery: 'Retry after a short backoff.',
    retryable: true },
]
```

---

### `openaq_dataframe_query` / `openaq_dataframe_describe`

Standard DataCanvas consumer tools (per the `api-canvas` skill's minimum-viable shape). Both
`readOnlyHint: true`. `dataframe_query` runs a read-only SQL `SELECT` (four-layer gate enforces
read-only) against tables `openaq_get_measurements` staged (`measurements_<sensorId>`);
`dataframe_describe` lists staged tables + columns. Both throw `canvas_unavailable`
(`ServiceUnavailable`) when `CANVAS_PROVIDER_TYPE` is not `duckdb`, and the framework's
`missing_table` (`NotFound`, re-stage hint) / `register_as_clash` surface as-is. Schemas follow the
skill's recipe verbatim (`canvas_id` + `sql` in, `rows` + `row_count` out for query; `canvas_id` in,
`tables[]` out for describe) — no domain-specific fields.

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
- **Spill mechanics:** acquire canvas (`canvas_id` optional input → mint on omit), stream the paged
  measurements via `spillover()` (preview ≈ 100k chars ≈ 25k tokens), register as
  `measurements_<sensorId>`. Output carries `canvasId`, `tableName`, `truncated`, plus the preview
  `series` and `totalCount`. Reusing a `canvas_id` across two `get_measurements` calls stages a
  second table (`measurements_<otherSensorId>`) so the agent can `JOIN`/`UNION` to compare stations.
- **Mandatory pairing:** because `get_measurements` can emit a `canvasId`, the server ships
  `openaq_dataframe_query` (+ `openaq_dataframe_describe`). A token with no query tool is dead
  output.
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
| `openaq_find_locations` | `totalCount` (total matching stations, via `ctx.enrich.total`) | `truncated` / `shown` / `cap` (via `ctx.enrich.truncated` when `limit` hit) |
| `openaq_get_readings` | — (returns all sensors at one location; not a capped list) | — |
| `openaq_get_measurements` | `totalCount` (total rows in the full series) | `truncated` (series spilled; also a top-level output field) |
| `openaq_list_parameters` | `totalCount` | `notice` when `query` matches nothing |
| `openaq_list_countries` | `totalCount` | `notice` when `query` matches nothing |

`totalCount` is the required spine via the total enricher; `truncated`/`shown`/`cap` are declared
**optional** in every output schema. Enrichment reaches both client surfaces automatically
(`structuredContent` + `content[]` trailer) — empty-result notices and totals go through `ctx.enrich`,
never hand-authored into `format()` text alone (which would leave `structuredContent`-only clients
blind).

`format()` for every tool renders all output fields (value **and** unit on every reading, the
`measured` framing line, `datetimeLast`, the canvas hint) so `content[]`-only clients (Claude
Desktop) see the same picture as `structuredContent` clients (Claude Code). The `capped-list-no-truncation`
linter enforces disclosure on `find_locations` and `get_measurements`.

---

## Endpoint → tool map

| Tool | OpenAQ v3 endpoint(s) | Notes |
|:-----|:---------------------|:------|
| `openaq_find_locations` | `GET /v3/locations` | `coordinates`+`radius` (≤25000) / `bbox` / `iso` / `parameters_id`; `distance` present only with coordinates |
| `openaq_get_readings` | `GET /v3/locations/{id}` + `GET /v3/locations/{id}/latest` | Joined on `sensorsId` — `/latest` has no parameter/unit inline. Coordinates path first calls `/v3/locations` to resolve nearest |
| `openaq_get_measurements` | `GET /v3/locations/{id}` (resolve sensor) + `GET /v3/sensors/{sensorId}/measurements` \| `/measurements/hourly` \| `/measurements/daily` | `datetime_from`/`datetime_to`; `daily`/`hourly` carry a `summary` block; pages internally then spills |
| `openaq_list_parameters` | `GET /v3/parameters` | ~44 entries; filtered locally |
| `openaq_list_countries` | `GET /v3/countries` | ~153 entries; filtered locally |
| `openaq_dataframe_query` / `_describe` | none (DataCanvas) | Query/describe staged `measurements_<sensorId>` tables |

---

## Workflow Analysis

### `openaq_get_readings` via coordinates (3 upstream calls)

| # | Call | Purpose | Path gate |
|:--|:-----|:--------|:----------|
| 1 | `GET /v3/locations?coordinates={lat,lon}&radius=25000&parameters_id={id}&limit=1` | Resolve nearest station measuring the parameter | `coordinates` path only |
| 2 | `GET /v3/locations/{id}` | Sensor→parameter→unit map | always |
| 3 | `GET /v3/locations/{id}/latest` | Latest values keyed by sensorsId | always |
| — | Join 3 against 2 on `sensorsId` | Attach parameter + unit to each value | always |

When called by `locationId`, step 1 is skipped (2 calls). Steps 2 and 3 run in `Promise.all`. The
free-tier budget (~60 req/min) is the reason this is a fixed 2–3 calls and never fans out per sensor.

### `openaq_get_measurements` (2–N upstream calls + optional spill)

| # | Call | Purpose |
|:--|:-----|:--------|
| 1 | `GET /v3/locations/{locationId}` | Find the sensor whose `parameter.id === parametersId` |
| 2…N | `GET /v3/sensors/{sensorId}/measurements[/hourly\|/daily]?datetime_from=…&datetime_to=…&page=…` | Pull the series, paging until the spill threshold or the range is exhausted |
| spill | `spillover()` → register `measurements_<sensorId>` on the canvas | Stage the full set when it exceeds the inline preview |

Surfaces the design question: cap internal paging so an unbounded `raw` range over years doesn't
loop forever — page up to a row ceiling (e.g. 5×1000), then rely on the canvas + `totalCount` to
tell the agent the series is larger and steer it to `daily` aggregation or a narrower range.

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
`meta.found` is a number for bounded sets, or a string like `">2"` when more pages exist. The
service must parse this: `typeof found === 'number' ? found : Infinity` (or extract the trailing
number for display). Pass the resolved value to `ctx.enrich.total()` — passing the raw string would
poison the `totalCount` field. Pagination is `page` + `limit` (1-based).

### Error envelope (live-probed)

| Status | Body | Cause | Maps to |
|:-------|:-----|:------|:--------|
| 404 | `{"detail":"Location not found"}` (clean JSON) | Unknown location id | `NotFound` (`location_not_found`) |
| 422 | `"[{'type': '...', 'loc': ..., 'msg': '...'}]"` (**Content-Type: application/json but body is a JSON string wrapping a Python repr** — NOT a JSON array) | Out-of-range param (e.g. `radius=26000`) | `ValidationError` — `JSON.parse(body)` yields a `string`; regex-extract `msg` value from it |
| 401 | — | Missing / invalid `X-API-Key` | `ConfigurationError` at startup; `ServiceUnavailable`/auth at runtime |
| 429 | — | Rate limit (>~60/min) | `ServiceUnavailable`, retryable — honor `Retry-After` |
| **500** | `Internal Server Error` (plain text) | **Unvalidated bad input** (e.g. `coordinates=999,999`) | Defended at the Zod edge; backstop → transient `ServiceUnavailable`, NOT `SerializationError` |

### Canonical parameter catalog (the units reference — full live list, 44 entries)

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
| 7 | `meta.found` handling: `totalCount` | Note said "treat `>N` as there are more" without specifying how the service should derive `totalCount`. Passing the raw string `">2"` to `ctx.enrich.total()` would poison the field. | Added explicit parse rule: `typeof found === 'number' ? found : Infinity` (or strip leading `>`). |
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
