<div align="center">
  <h1>@cyanheads/openaq-mcp-server</h1>
  <p><b>Find air-quality monitoring stations, read latest sensor values, and pull historical pollutant series via MCP. STDIO &amp; Streamable HTTP.</b>
  <div>7 Tools (2 opt-in) • 2 Resources</div>
  </p>
</div>

<div align="center">

[![npm](https://img.shields.io/npm/v/@cyanheads/openaq-mcp-server?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/@cyanheads/openaq-mcp-server) [![License](https://img.shields.io/badge/License-Apache%202.0-orange.svg?style=flat-square)](./LICENSE) [![Docker](https://img.shields.io/badge/Docker-ghcr.io-2496ED?style=flat-square&logo=docker&logoColor=white)](https://github.com/users/cyanheads/packages/container/package/openaq-mcp-server) [![MCP SDK](https://img.shields.io/badge/MCP%20SDK-^1.29.0-green.svg?style=flat-square)](https://modelcontextprotocol.io/) [![TypeScript](https://img.shields.io/badge/TypeScript-^6.0.3-3178C6.svg?style=flat-square)](https://www.typescriptlang.org/) [![Bun](https://img.shields.io/badge/Bun-v1.3.11-blueviolet.svg?style=flat-square)](https://bun.sh/)

</div>

<div align="center">

[![Install in Claude Desktop](https://img.shields.io/badge/Install_in-Claude_Desktop-D97757?style=for-the-badge&logo=anthropic&logoColor=white)](https://github.com/cyanheads/openaq-mcp-server/releases/latest/download/openaq-mcp-server.mcpb) [![Install in Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/en/install-mcp?name=openaq-mcp-server&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBjeWFuaGVhZHMvb3BlbmFxLW1jcC1zZXJ2ZXIiXSwiZW52Ijp7Ik9QRU5BUV9BUElfS0VZIjoieW91ci1hcGkta2V5In19) [![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_Server-0098FF?style=for-the-badge&logo=visualstudiocode&logoColor=white)](https://vscode.dev/redirect?url=vscode:mcp/install?%7B%22name%22%3A%22openaq-mcp-server%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40cyanheads%2Fopenaq-mcp-server%22%5D%2C%22env%22%3A%7B%22OPENAQ_API_KEY%22%3A%22your-api-key%22%7D%7D)

[![Framework](https://img.shields.io/badge/Built%20on-@cyanheads/mcp--ts--core-67E8F9?style=flat-square)](https://www.npmjs.com/package/@cyanheads/mcp-ts-core)

</div>

---

`openaq-mcp-server` wraps the [OpenAQ v3 API](https://docs.openaq.org/) to expose **measured** air quality — physical-sensor observations from government reference monitors and research-grade sensors worldwide. It is the ground-truth counterpart to a modeled air-quality grid: where a model gives a concentration anywhere, OpenAQ gives an actual reading from a physical monitor — sparser, unevenly distributed, but real.

Coverage is uneven and honest. An empty result means there is no monitoring there, **not** that the air is clean — every discovery tool says so, and points to a modeled fallback ([`open-meteo-mcp-server`](https://github.com/cyanheads/open-meteo-mcp-server)'s air-quality tool) for anywhere-coverage.

## Tools

Five domain tools cover the workflow — discover stations, read current values, pull history, and resolve the two catalogs (pollutant units, country coverage) — plus two DataCanvas tools for SQL over historical series too large to inline. The data model is `location → sensor → parameter`; the server hides the sensor layer so you think in **stations and parameters**, never sensor ids.

| Tool | Description |
|:---|:---|
| `openaq_find_locations` | Find monitoring stations near a point, in a bounding box, or by country. The required first step — readings and measurements key on the location id this returns. |
| `openaq_get_readings` | Latest measured value for every sensor at a station, each joined with its pollutant and unit. The current-conditions tool. |
| `openaq_get_measurements` | Historical series for one pollutant at one station over a date range, with `raw`/`hourly`/`daily` aggregation. Large ranges spill to a DataCanvas. |
| `openaq_list_parameters` | Catalog of measurable pollutants and their canonical units. The unit-disambiguation reference. |
| `openaq_list_countries` | Catalog of country-level coverage — data span and parameters measured. An availability check before a regional sweep. |
| `openaq_dataframe_describe` | List the tables and columns staged on a DataCanvas so you can write valid SQL. |
| `openaq_dataframe_query` | Run a read-only `SELECT` over staged measurement series. |

### `openaq_find_locations`

Find air-quality monitoring stations (measured by physical sensors, not modeled) and the parameters each one reports.

- Three search scopes — `coordinates` + `radius` (near-me), `bbox` (area sweep), or `iso` country code; at least one is required
- `radius` is in metres, 1–25000 (the API hard-caps at 25000); larger areas need `bbox`, which returns no distance
- `parametersId` narrows to stations that measure a given parameter (each returned station still lists all its sensors)
- Returns each station's id, name, coordinates, distance (when searching by coordinates), country, provider, `isMonitor`/`isMobile`, the parameters its sensors measure with units, and the `datetimeFirst`/`datetimeLast` data span
- Empty result means **no coverage, not clean air** — widen the radius, check `openaq_list_countries`, or fall back to the modeled `open-meteo` air-quality tool

---

### `openaq_get_readings`

Latest value per sensor at a station — the current-conditions tool.

- Pass a `locationId` from `openaq_find_locations`, **or** `coordinates` + `parametersId` to auto-resolve the nearest station (within 25km) that measures that parameter
- The raw OpenAQ latest feed is keyed only by sensor id; this tool **joins** it against the station's sensor → parameter → unit map, so every value carries its pollutant and unit
- With `locationId`, `parametersId` optionally filters the returned values to one parameter; omit it for all sensors
- Each value carries its UTC and local timestamp plus the station's `datetimeLast` — recency varies by station, so "latest" may be minutes or hours old

---

### `openaq_get_measurements`

Historical measurement series for one pollutant at one station over a date range — for trend analysis and "was last week worse than the monthly average?".

- Pass a `locationId` and a `parametersId`; the tool resolves the station's sensor for that parameter internally (v3 series are sensor-scoped, but you think in stations)
- `aggregation`: `raw` (every reported value), `hourly`, or `daily` — `hourly`/`daily` add a per-bucket statistical summary (min, median, max, mean, sd)
- `datetimeFrom`/`datetimeTo` accept a date (`YYYY-MM-DD`) or full UTC timestamp (`YYYY-MM-DDTHH:MM:SSZ`); omit for the most recent values
- Values carry their unit; the server **never converts** between µg/m³, ppm, and ppb (the conversion is gas- and temperature-dependent)
- **Large ranges spill to a DataCanvas** — see below

### DataCanvas spill workflow

A multi-month `raw` series can be thousands of rows — too large to inline without blowing context, and a fixed slice would blind the agent to the rest. When a series exceeds the inline preview (100 rows), `openaq_get_measurements` stages the **full** set on a DuckDB-backed DataCanvas and returns:

- a preview (`series`, capped at 100 rows) plus `rowCount` and the `totalCount` enrichment,
- `truncated: true`, `canvasId`, and a `tableName` of the form `measurements_<sensorId>`.

You then query the full set with the two consumer tools:

| Tool | Use |
|:---|:---|
| `openaq_dataframe_describe` | List staged tables and their columns (`value`, `datetimeFrom`, `datetimeTo`, `min`, `median`, `max`, `avg`, `sd`, `percentComplete`, `flagged`) — call this first to write SQL without guessing names. |
| `openaq_dataframe_query` | Run a read-only `SELECT` for monthly means, exceedance counts, percentiles, or cross-sensor comparisons. |

Pass a prior `canvas_id` back into `openaq_get_measurements` to stage a **second** station's series on the same canvas (as `measurements_<otherSensorId>`), then `JOIN`/`UNION` the two in one query to compare stations.

**Requires `CANVAS_PROVIDER_TYPE=duckdb`.** Without it, `openaq_get_measurements` still returns the truncated preview plus a notice (it does not fail), and the two dataframe tools return a `canvas_unavailable` error directing you to enable DuckDB.

`openaq_dataframe_query` is read-only by design — a four-layer SQL gate rejects writes, DDL, and file/network table functions; only a single `SELECT` runs.

## Resources and prompts

| Type | Name | Description |
|:---|:---|:---|
| Resource | `openaq://location/{locationId}` | Location metadata for a known location id — name, coordinates, country, provider, sensors (each with parameter + unit), and data span. |
| Resource | `openaq://parameters` | Full pollutant + unit catalog (same data as `openaq_list_parameters`). |

All resource data is also reachable via tools — both resources mirror tool output, so tool-only MCP clients lose nothing. There are no prompts: this is a data-lookup domain with no recurring analysis template that earns one (a WHO-guideline health snapshot is a cross-server workflow, not localized here).

## Features

Built on [`@cyanheads/mcp-ts-core`](https://www.npmjs.com/package/@cyanheads/mcp-ts-core):

- Declarative tool and resource definitions — single file per primitive, framework handles registration and validation
- Unified error handling — handlers throw, framework catches, classifies, and formats
- Typed error contracts per tool — each network tool declares `reason`/`code`/`when`/`recovery`, so failures carry a concrete next move
- Pluggable auth (`none`, `jwt`, `oauth`) and structured, request-scoped logging with optional OpenTelemetry tracing
- STDIO and Streamable HTTP transports from one codebase

OpenAQ-specific:

- Single typed client over the OpenAQ v3 REST API with `X-API-Key` auth, retry with rate-limit-calibrated backoff, and OpenAQ-specific error classification (clean-JSON 404 → `NotFound`; the Python-repr 422 body → `ValidationError`; the plain-text 500 on bad coordinates → transient `ServiceUnavailable`)
- Hides the v3 `location → sensor → measurement` hierarchy — `openaq_get_measurements` resolves a station + parameter to the underlying sensor; `openaq_get_readings` joins the latest feed against the sensor map so every value is labeled
- DataCanvas spillover for large measurement series, queryable with read-only DuckDB SQL
- Coordinates and radius are bounded in Zod at the edge — OpenAQ returns an opaque plain-text 500 for out-of-range input, so the server rejects it cleanly before the call

Agent-friendly output:

- **Measured-vs-modeled framing in every discovery tool** — an empty result is stated as no coverage, not clean air, with a pointer to the modeled fallback, so an agent never misreads sparse data as a clean reading
- **Units travel with every value, never converted** — the same pollutant has multiple parameter ids for different units (`co` is id 4 µg/m³, id 8 ppm, id 102 ppb), so `parametersId` is the precise selector and `openaq_list_parameters` maps pollutant + unit → id
- **Chainable ids and staleness signals** — location id → readings/measurements, sensor id → history; `datetimeLast` and per-value timestamps expose how fresh "latest" actually is
- Capped lists disclose truncation (`totalCount`, `truncated`) via framework enrichment, reaching both the structured and text output surfaces

## Getting started

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

Issues and pull requests are welcome. Run checks and tests before submitting:

```sh
bun run devcheck
bun run test
```

## License

Apache-2.0 — see [LICENSE](./LICENSE) for details.
