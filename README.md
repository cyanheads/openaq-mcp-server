<div align="center">
  <h1>@cyanheads/openaq-mcp-server</h1>
  <p><b>Find air-quality monitoring stations, read latest sensor values, and pull historical pollutant series via MCP. STDIO or Streamable HTTP.</b>
  <div>7 Tools (2 opt-in) • 2 Resources</div>
  </p>
</div>

<div align="center">

[![npm](https://img.shields.io/npm/v/@cyanheads/openaq-mcp-server?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/@cyanheads/openaq-mcp-server) [![License](https://img.shields.io/badge/License-Apache%202.0-orange.svg?style=flat-square)](./LICENSE) [![Docker](https://img.shields.io/badge/Docker-ghcr.io-2496ED?style=flat-square&logo=docker&logoColor=white)](https://github.com/users/cyanheads/packages/container/package/openaq-mcp-server) [![MCP SDK](https://img.shields.io/badge/MCP%20SDK-^2.0.0-green.svg?style=flat-square)](https://modelcontextprotocol.io/) [![TypeScript](https://img.shields.io/badge/TypeScript-^7.0.2-3178C6.svg?style=flat-square)](https://www.typescriptlang.org/) [![Bun](https://img.shields.io/badge/Bun-v1.4.0-blueviolet.svg?style=flat-square)](https://bun.sh/)

</div>

<div align="center">

[![Install in Claude Desktop](https://img.shields.io/badge/Install_in-Claude_Desktop-D97757?style=for-the-badge&logo=anthropic&logoColor=white)](https://github.com/cyanheads/openaq-mcp-server/releases/latest/download/openaq-mcp-server.mcpb) [![Install in Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/en/install-mcp?name=openaq-mcp-server&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBjeWFuaGVhZHMvb3BlbmFxLW1jcC1zZXJ2ZXIiXSwiZW52Ijp7Ik9QRU5BUV9BUElfS0VZIjoieW91ci1hcGkta2V5In19) [![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_Server-0098FF?style=for-the-badge&logo=visualstudiocode&logoColor=white)](https://vscode.dev/redirect?url=vscode:mcp/install?%7B%22name%22%3A%22openaq-mcp-server%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40cyanheads%2Fopenaq-mcp-server%22%5D%2C%22env%22%3A%7B%22OPENAQ_API_KEY%22%3A%22your-api-key%22%7D%7D)

[![Framework](https://img.shields.io/badge/Built%20on-@cyanheads/mcp--ts--core-67E8F9?style=flat-square)](https://www.npmjs.com/package/@cyanheads/mcp-ts-core)

</div>

<div align="center">

**Public Hosted Server:** [https://openaq.caseyjhand.com/mcp](https://openaq.caseyjhand.com/mcp)

</div>

---

## Overview

Measured air quality from the OpenAQ v3 API — physical-sensor observations from government reference monitors and research-grade sensors worldwide. Find monitoring stations, read current values, and pull historical pollutant series from any MCP client. Runs as a stdio process, a local Streamable HTTP server, or the public hosted endpoint above.

### Tools

| Tool | Description |
|:---|:---|
| `openaq_find_locations` | Find monitoring stations near a point, in a bounding box, or by country. The required first step — readings and measurements key on the location id this returns. |
| `openaq_get_readings` | Latest measured value for every sensor at a station, joined with its pollutant and unit. The current-conditions tool. |
| `openaq_get_measurements` | Historical series for one pollutant at one station over a date range, with `raw`/`hourly`/`daily` aggregation. Large ranges spill to a DataCanvas. |
| `openaq_list_parameters` | Catalog of measurable pollutants and their canonical units. The unit-disambiguation reference. |
| `openaq_list_countries` | Catalog of country-level coverage — data span and parameters measured, filterable by `parametersId`. An availability check before a regional sweep. |
| `openaq_dataframe_describe` | List the tables and columns staged on a DataCanvas so you can write valid SQL. |
| `openaq_dataframe_query` | Run a read-only `SELECT` over staged measurement series. |

### Resources

| Resource | Description |
|:---|:---|
| `openaq://location/{locationId}` | Location metadata for a known location id — name, coordinates, country, provider, sensors (each with parameter + unit), and data span. |
| `openaq://parameters` | Full pollutant + unit catalog (same data as `openaq_list_parameters`). |

All resource data is also reachable via tools — both resources mirror tool output, so tool-only MCP clients lose nothing.

## Capability reference

### `openaq_find_locations` <sub>tool</sub>

- Search scopes — `coordinates` with an optional `radius` (near-me) or `bbox` (area sweep), and/or an `iso` country code; at least one is required. `coordinates` with `bbox`, or `radius` without `coordinates`, fails with `invalid_search_scope`
- `radius` is in metres, 1–25000, default 12000 (the API hard-caps at 25000); larger areas need `bbox`, which returns no distance
- `iso` takes the country code `openaq_list_countries` returns — ISO 3166-1 alpha-2 in either case, or `-99` for the country OpenAQ lists without one
- `parametersId` narrows to stations that measure a given parameter; each returned station still lists all its sensors
- `monitor` (reference monitors vs low-cost sensors), `mobile` (mobile vs fixed), and `providersId` (one provider network) narrow further; `false` filters, it does not mean "either"
- `limit` caps at 100 stations per page; `page` (1-based) reaches further pages — distance ordering applies within a page, not across pages. OpenAQ reports no total for this search, so `totalCount` counts stations through the current page: exact on a short (last) page, an "at least" floor flagged by `totalCountIsLowerBound` on a full one. A page past the end fails with `page_exhausted`
- Returns each station's id, name, coordinates, distance (coordinate search only), country, provider name and `providerId`, `isMonitor`/`isMobile`, its parameters with units, and the `datetimeFirst`/`datetimeLast` data span
- An empty first page means no coverage, not clean air — widen the search area, check `openaq_list_countries`, or fall back to the modeled `open-meteo-mcp-server` air-quality tool

---

### `openaq_get_readings` <sub>tool</sub>

- Pass a `locationId` from `openaq_find_locations`, or `coordinates` + `parametersId` to auto-resolve the nearest station (within 25km) that measures that parameter
- Joins the latest feed (keyed only by sensor id) against the station's sensor → parameter → unit map, so every value carries its pollutant and unit
- With `locationId`, `parametersId` optionally filters the returned values to one parameter; omit it for all sensors
- Each value carries its UTC and local timestamp plus the station's `datetimeLast` — recency varies by station

---

### `openaq_get_measurements` <sub>tool</sub>

- Pass a `locationId` and `parametersId`; the server resolves the underlying sensor internally (v3 series are sensor-scoped)
- `aggregation`: `raw` (every reported value), `hourly`, or `daily` — rollups add a per-bucket min/median/max/mean/sd
- `datetimeFrom`/`datetimeTo` accept a date (`YYYY-MM-DD`) or full UTC timestamp; omit either for the most recent values or "up to now"
- Values carry their unit; the server never converts between µg/m³, ppm, and ppb
- Internal paging caps at 5000 rows and also stops on a failed page — `pulledCount` and `pullComplete` say what was actually collected, and `totalCount` is published as a floor (flagged by `totalCountIsLowerBound`) when OpenAQ answers the range with a `">N"` bound instead of an exact count
- Past the 100-row inline preview, `series` is a preview and the pulled rows stage on a DataCanvas (`canvasId` + `tableName`) when `CANVAS_PROVIDER_TYPE=duckdb` — without it, the response still returns the preview plus a notice. Every row the response carries is rendered in the text output too, so a text-only client sees the same set
- Pass a prior `canvas_id` to put this series on that canvas whatever its size, for cross-station `JOIN`/`UNION` queries. Reuse stages one table per sensor: a different sensor adds a table, while re-staging the same sensor overwrites its earlier series and the response says so

---

### `openaq_list_parameters` <sub>tool</sub>

- Optional `query` filters the parameter catalog by code, display name, or description (case-insensitive); `pollutantsOnly` excludes meteorological/particle-count channels (temperature, humidity, wind, pressure)
- The unit-disambiguation reference — the same pollutant appears under multiple ids for different units (e.g. CO is id 4 in µg/m³, id 8 in ppm, id 102 in ppb)
- Returns each parameter's id, code, display name, canonical unit, and a one-line description

---

### `openaq_list_countries` <sub>tool</sub>

- Optional `query` matches a two-letter input as an exact ISO 3166-1 alpha-2 code, longer input as a substring of code or name; `parametersId` filters to countries measuring that parameter anywhere
- `limit` (1–100, default 20) and `page` (1-based) page the filtered list in OpenAQ catalog order. `totalCount` is the full filtered count; when more countries follow, `truncated`/`shown`/`cap` and a notice name the next page. A page past the end returns no countries and a notice naming the last page
- Returns each country's id, OpenAQ country code (ISO 3166-1 alpha-2, or `-99` where OpenAQ has none), name, `datetimeFirst`/`datetimeLast` data span, and the parameters measured anywhere within it
- The availability check before a regional `openaq_find_locations` sweep — answers "which countries have NO2 monitoring?"

---

### `openaq_dataframe_describe` <sub>tool</sub>

- Takes a `canvas_id` returned by a prior `openaq_get_measurements` call
- Returns each staged `measurements_<sensorId>` table with its row count and column names
- Throws `canvas_unavailable` when `CANVAS_PROVIDER_TYPE` is not `duckdb`

---

### `openaq_dataframe_query` <sub>tool</sub>

- Takes a `canvas_id` and a read-only SQL `SELECT` against the staged measurement tables
- Writes, DDL, and file/network table functions are rejected — only a single `SELECT` runs
- Responses carry at most 200 rows whatever the SQL shape; `truncated` reports that the cap bit, and the notice names `ORDER BY <column> LIMIT 200 OFFSET <n>` as the way to page the rest. `rowCount` is the rows returned, not the size of the full result
- Throws `canvas_unavailable` when DuckDB is off, or `missing_table` when the SQL references a table not staged on that canvas

---

### `openaq://location/{locationId}` <sub>resource</sub>

- Returns name, locality, timezone, country, provider, `isMonitor`/`isMobile`, coordinates, sensors (each with parameter id/name/unit), and the `datetimeFirst`/`datetimeLast` span
- `locationId` comes from `openaq_find_locations`; a segment that is not a positive integer fails as `invalid_location_id` before any request
- Cached 5 minutes — station metadata is near-static, but `datetimeLast` advances as measurements land

---

### `openaq://parameters` <sub>resource</sub>

- Mirrors `openaq_list_parameters` with no query or filter — the full catalog
- Cached 1 hour — the catalog changes only when OpenAQ adds a parameter

## DataCanvas spill workflow

A multi-month `raw` series can be thousands of rows — too large to inline without blowing context. When `openaq_get_measurements` stages a series, read the staged table with the two consumer tools, in this order:

| Tool | Use |
|:---|:---|
| `openaq_dataframe_describe` | List staged tables and their columns (`value`, `datetimeFrom`, `datetimeTo`, `min`, `median`, `max`, `avg`, `sd`, `percentComplete`, `flagged`) — call first. The staged table is flat while the inline `series` is nested (`summary.min`), so SQL written from the response shape alone names columns that do not exist. |
| `openaq_dataframe_query` | Run a read-only `SELECT` for monthly means, exceedance counts, percentiles, or cross-sensor comparisons. Capped at 200 rows per response — aggregate in SQL, or page with `ORDER BY` plus `LIMIT`/`OFFSET`. |

- The staging response names both tools and the table it wrote, so the handle is never opaque.
- One table per sensor (`measurements_<sensorId>`): reuse a `canvas_id` across two sensors to `JOIN`/`UNION` their series, and re-staging the same sensor overwrites its earlier table.
- Requires `CANVAS_PROVIDER_TYPE=duckdb`. Without it — or when a configured canvas fails to start — `openaq_get_measurements` still returns the preview plus a notice rather than dropping data already fetched.
- Not available in the `.mcpb` bundle — the Claude Desktop bundle ships without DuckDB's platform-specific native binding, since bundling it would lock the bundle to the OS it was packed on. Use the npm, `npx`, or Docker install for canvas work.

## Features

Built on [`@cyanheads/mcp-ts-core`](https://github.com/cyanheads/mcp-ts-core): stdio and Streamable HTTP transports, pluggable auth (`none` / `jwt` / `oauth`), swappable storage (`in-memory`, `filesystem`, `Supabase`, `Cloudflare KV/R2/D1`), structured logging with optional OpenTelemetry tracing.

OpenAQ-specific:

- Single typed client over the OpenAQ v3 REST API with `X-API-Key` auth, retry with rate-limit-calibrated backoff, and OpenAQ-specific error classification (clean-JSON 404 → `NotFound`; the Python-repr 422 body → `ValidationError`; the plain-text 500 on bad coordinates → transient `ServiceUnavailable`)
- Hides the v3 `location → sensor → measurement` hierarchy — `openaq_get_measurements` resolves a station + parameter to the underlying sensor; `openaq_get_readings` joins the latest feed against the sensor map so every value is labeled
- DataCanvas spillover for large measurement series, queryable with read-only DuckDB SQL
- Coordinates, radius, and bbox corners (range, and west-to-east / south-to-north order) are bounded in Zod at the edge, and contradictory search scopes are rejected before the call — OpenAQ returns an opaque plain-text 500 for any of them

Agent-friendly output:

- Measured-vs-modeled framing in every discovery tool — an empty result is stated as no coverage, not clean air, with a pointer to the modeled fallback, so an agent never misreads sparse data as a clean reading
- Units travel with every value, never converted — the same pollutant has multiple parameter ids for different units, so `parametersId` is the precise selector and `openaq_list_parameters` maps pollutant + unit → id
- Chainable ids and staleness signals — location id → readings/measurements, sensor id → history; `datetimeLast` and per-value timestamps expose how fresh "latest" actually is
- Capped lists disclose truncation (`totalCount`, `truncated`) via framework enrichment, reaching both the structured and text output surfaces

## Getting started

### Public Hosted Instance

A public instance is available at `https://openaq.caseyjhand.com/mcp` — no installation required. Point any MCP client at it via Streamable HTTP, with this client config:

```json
{
  "mcpServers": {
    "openaq-mcp-server": {
      "type": "streamable-http",
      "url": "https://openaq.caseyjhand.com/mcp"
    }
  }
}
```

### Self-Hosted / Local

An OpenAQ v3 API key is required — sent as the `X-API-Key` header on every request. Get a free key from your [OpenAQ Explorer](https://explore.openaq.org/) account.

Add the following to your MCP client configuration file.

```json
{
  "mcpServers": {
    "openaq-mcp-server": {
      "type": "stdio",
      "command": "bunx",
      "args": ["@cyanheads/openaq-mcp-server@latest"],
      "env": {
        "MCP_TRANSPORT_TYPE": "stdio",
        "OPENAQ_API_KEY": "your-api-key"
      }
    }
  }
}
```

Or with npx (no Bun required):

```json
{
  "mcpServers": {
    "openaq-mcp-server": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@cyanheads/openaq-mcp-server@latest"],
      "env": {
        "MCP_TRANSPORT_TYPE": "stdio",
        "OPENAQ_API_KEY": "your-api-key"
      }
    }
  }
}
```

Or with Docker:

```json
{
  "mcpServers": {
    "openaq-mcp-server": {
      "type": "stdio",
      "command": "docker",
      "args": [
        "run", "-i", "--rm",
        "-e", "MCP_TRANSPORT_TYPE=stdio",
        "-e", "OPENAQ_API_KEY=your-api-key",
        "ghcr.io/cyanheads/openaq-mcp-server:latest"
      ]
    }
  }
}
```

To enable DataCanvas SQL over large measurement series, add `"CANVAS_PROVIDER_TYPE": "duckdb"` to `env`.

For Streamable HTTP, set the transport and start the server:

```sh
MCP_TRANSPORT_TYPE=http MCP_HTTP_PORT=3010 OPENAQ_API_KEY=your-api-key bun run start:http
# Server listens at http://localhost:3010/mcp
```

### Prerequisites

- [Bun v1.3.0](https://bun.sh/) or higher (Node.js v24+ also works at runtime).
- A free OpenAQ v3 API key — sign up at [explore.openaq.org](https://explore.openaq.org/).

### Installation

1. **Clone the repository:**

```sh
git clone https://github.com/cyanheads/openaq-mcp-server.git
```

2. **Navigate into the directory:**

```sh
cd openaq-mcp-server
```

3. **Install dependencies:**

```sh
bun install
```

4. **Configure environment:**

```sh
cp .env.example .env
# edit .env and set OPENAQ_API_KEY
```

## Configuration

All configuration is validated at startup via Zod schemas. Key environment variables:

| Variable | Description | Default |
|:---|:---|:---|
| `OPENAQ_API_KEY` | **Required.** OpenAQ v3 API key, sent as the `X-API-Key` header. A missing key surfaces as a clean startup error. | — |
| `OPENAQ_API_BASE_URL` | OpenAQ v3 API base URL. Override for a proxy or test mirror. | `https://api.openaq.org/v3` |
| `CANVAS_PROVIDER_TYPE` | Set to `duckdb` to enable DataCanvas SQL over large measurement series. Without it, large series return a truncated preview and the dataframe tools are inert. | `none` |
| `MCP_TRANSPORT_TYPE` | Transport: `stdio` or `http`. | `stdio` |
| `MCP_HTTP_PORT` | Port for the HTTP server. | `3010` |
| `MCP_AUTH_MODE` | Auth mode: `none`, `jwt`, or `oauth`. | `none` |
| `MCP_LOG_LEVEL` | Log level (RFC 5424). | `info` |
| `LOGS_DIR` | Directory for log files (Node.js only). | `<project-root>/logs` |

See [`.env.example`](./.env.example) for the full list of optional overrides.

## Running the server

### Local development

- **Build and run:**

  ```sh
  bun run rebuild
  bun run start:http   # or start:stdio
  ```

- **Run checks and tests:**

  ```sh
  bun run devcheck   # Lint, format, typecheck, security, changelog sync
  bun run test       # Vitest test suite
  bun run lint:mcp   # Validate MCP definitions against spec
  ```

### Docker

```sh
docker build -t openaq-mcp-server .
docker run --rm -e OPENAQ_API_KEY=your-api-key -p 3010:3010 openaq-mcp-server
```

The image defaults to HTTP transport, stateless session mode, and logs to `/var/log/openaq-mcp-server`. The `@duckdb/node-api` runtime dependency ships in the image, so DataCanvas works once `CANVAS_PROVIDER_TYPE=duckdb` is set. OpenTelemetry peer dependencies are installed by default — build with `--build-arg OTEL_ENABLED=false` to omit them.

## Project structure

| Directory | Purpose |
|:---|:---|
| `src/index.ts` | `createApp()` entry point — registers tools/resources and inits the service + canvas. |
| `src/config` | Server-specific environment variable parsing and validation with Zod. |
| `src/mcp-server/tools/definitions` | Tool definitions (`*.tool.ts`) — five OpenAQ tools plus two `dataframe_*` tools. |
| `src/mcp-server/resources/definitions` | Resource definitions (`*.resource.ts`) — location and parameters mirrors. |
| `src/services/openaq` | OpenAQ v3 API client, request/auth/retry, and domain types. |
| `tests/` | Unit and integration tests mirroring `src/`. |

## Development guide

See [`CLAUDE.md`](./CLAUDE.md) / [`AGENTS.md`](./AGENTS.md) for development guidelines and architectural rules. The short version:

- Handlers throw, framework catches — no `try/catch` in tool logic
- Use `ctx.log` for request-scoped logging, `ctx.state` for tenant-scoped storage
- Register new tools and resources in the `createApp()` arrays
- Wrap the OpenAQ API: validate raw → normalize to the domain type → return the output schema; surface units verbatim and never fabricate missing fields

## Data & licensing

Air quality data served by this MCP server is sourced from the [OpenAQ](https://openaq.org) platform. **Attribution to OpenAQ as the data source is required** when using this server's output ([OpenAQ Terms of Use](https://docs.openaq.org/about/terms)).

OpenAQ aggregates measurements from hundreds of government agencies, research institutions, and other monitoring networks worldwide. Each of those upstream providers may publish its own attribution or licensing terms. The `provider` field returned by `openaq_find_locations`, `openaq_get_readings`, and the `openaq://location/{locationId}` resource identifies the originating network for each station. Downstream users are responsible for reviewing and complying with the terms of any provider whose data they use.

## Contributing

Issues are welcome. Run checks and tests before submitting:

```sh
bun run devcheck
bun run test
```

## License

Apache-2.0 — see [LICENSE](./LICENSE) for details.
