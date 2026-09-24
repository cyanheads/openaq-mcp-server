<div align="center">
  <h1>@cyanheads/openaq-mcp-server</h1>
  <p><b>Find air-quality monitoring stations, read latest sensor values, and pull historical pollutant series via MCP. STDIO or Streamable HTTP.</b>
  <div>7 Tools • 2 Resources</div>
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

Measured air quality from the OpenAQ v3 API: physical-sensor observations from government reference monitors and research-grade sensors worldwide. Find monitoring stations, read current values, and pull historical pollutant series from any MCP client. Runs as a stdio process, a local Streamable HTTP server, or the public hosted endpoint above.

### Tools

| Tool | Description |
|:---|:---|
| `openaq_find_locations` | Find monitoring stations near a point, in a bounding box, or by country; the location ids the other tools take |
| `openaq_get_readings` | Latest value for every sensor at a station, labeled with its pollutant and unit |
| `openaq_get_measurements` | Historical series for one pollutant at one station, raw or rolled up hourly/daily |
| `openaq_list_parameters` | Pollutant catalog with canonical units; maps a pollutant and unit to its parameter id |
| `openaq_list_countries` | Country coverage: data span and the parameters measured in each |
| `openaq_dataframe_describe` | List the tables and columns staged on a DataCanvas |
| `openaq_dataframe_query` | Run a read-only SQL `SELECT` over staged measurement series |

### Resources

| Resource | Description |
|:---|:---|
| `openaq://location/{locationId}` | Metadata for one station: coordinates, provider, sensors with units, data span |
| `openaq://parameters` | Full pollutant and unit catalog |

Both resources mirror tool output, so tool-only clients lose nothing.

## Capability reference

### `openaq_find_locations` <sub>tool</sub>

- Scope by `coordinates` with `radius` (metres, 1–25000, default 12000), `bbox`, and/or `iso` (a code from `openaq_list_countries`); at least one is required, and `coordinates` and `bbox` exclude each other. `parametersId`, `monitor`, `mobile`, and `providersId` narrow further; up to 100 stations per page (`limit`, default 20), 1-based `page`
- Each station carries `id`, `distanceMeters` (coordinate search only), `provider`/`providerId`, `isMonitor`/`isMobile`, its `parameters` with units, and the `datetimeFirst`/`datetimeLast` span; `coordinates`, `country`, and `provider` are null when OpenAQ lists none
- `totalCount` counts stations through the current page and is a floor when `totalCountIsLowerBound` is set; no match fails as `no_locations_found`, a page past the end as `page_exhausted`

---

### `openaq_get_readings` <sub>tool</sub>

- A `locationId`, or `coordinates` plus `parametersId` to resolve the nearest station within 25 km that measures it (compared across up to 1,000 matching stations; a full 1,000 adds a `notice`); with `locationId`, `parametersId` optionally filters to one parameter
- One reading per sensor with `value`, `unit`, `sensorId`, and `datetimeUtc`/`datetimeLocal`, plus the station's `provider`, `providerId`, `timezone`, and `datetimeLast`
- Misses are typed: `location_not_found`, `parameter_not_at_location` (with the station's `available` ids), `no_station_near_coordinates`, `no_recent_values`

---

### `openaq_get_measurements` <sub>tool</sub>

- `locationId` and `parametersId` required; `datetimeFrom`/`datetimeTo` take a UTC timestamp, sent as is, or a `YYYY-MM-DD` date, read as the station's local calendar day (a UTC day when OpenAQ lists no timezone); `aggregation` is `raw` (default), `hourly`, or `daily`, and rollups add min/median/max/avg/sd per bucket. Pulls up to 5,000 rows per call
- Returns `series` with `sensorId`, `pulledCount`, and `pullComplete`, and a `location` carrying `provider`, `providerId`, and `timezone`; `totalCount` is a floor when `totalCountIsLowerBound` is set
- `effectiveRange` echoes the UTC bounds sent upstream. Hourly and daily responses add `gapCount` and the first 20 missing intervals as `gaps`, and the notice flags an edge bucket the range clips
- Past 100 rows, `series` is a preview (`truncated`) and the pulled rows stage on a DataCanvas as `measurements_<sensorId>` (`canvasId`, `tableName`) when `CANVAS_PROVIDER_TYPE=duckdb`; a supplied `canvas_id` stages onto that canvas at any size

---

### `openaq_list_parameters` <sub>tool</sub>

- Optional case-insensitive `query` over code, display name, and description; `pollutantsOnly` drops meteorological and particle-count channels
- Rows carry `id`, `name`, `displayName`, `unit`, and `description`; one pollutant can appear under several ids by unit (CO is 4 in µg/m³, 8 in ppm, 102 in ppb)

---

### `openaq_list_countries` <sub>tool</sub>

- Optional `query` (a two-letter value matches an ISO 3166-1 alpha-2 code first; otherwise code or name substrings match) and `parametersId`; up to 100 per page (`limit`, default 20), 1-based `page`
- Rows carry `code` (the `iso` value for `openaq_find_locations`), `name`, the `datetimeFirst`/`datetimeLast` span, and the `parameters` measured anywhere in the country; `totalCount` is the full filtered count

---

### `openaq_dataframe_describe` <sub>tool</sub>

- Takes a `canvas_id` from `openaq_get_measurements` and returns each staged table's `name`, `rowCount`, and `columns`
- Fails as `canvas_unavailable` unless `CANVAS_PROVIDER_TYPE=duckdb`, or `canvas_not_found` for an unknown or expired id

---

### `openaq_dataframe_query` <sub>tool</sub>

- A `canvas_id` and one read-only `SELECT`; writes, DDL, and file/network table functions are rejected
- At most 200 rows per response, with `truncated` set when the cap cut the result; page with `ORDER BY` plus `LIMIT`/`OFFSET`
- Fails as `canvas_unavailable`, `canvas_not_found`, or `missing_table`

---

### `openaq://location/{locationId}` <sub>resource</sub>

- `application/json`: name, locality, timezone, country, provider, `isMonitor`/`isMobile`, coordinates, `sensors` (each with `parameterId` and `unit`), and the `datetimeFirst`/`datetimeLast` span
- `locationId` comes from `openaq_find_locations`; cached 5 minutes

---

### `openaq://parameters` <sub>resource</sub>

- `application/json` catalog, the same rows as an unfiltered `openaq_list_parameters`
- Cached 1 hour

## Features

Built on [`@cyanheads/mcp-ts-core`](https://github.com/cyanheads/mcp-ts-core): stdio and Streamable HTTP transports, pluggable auth (`none` / `jwt` / `oauth`), swappable storage (`in-memory`, `filesystem`, `Supabase`, `Cloudflare KV/R2/D1`), structured logging with optional OpenTelemetry tracing.

OpenAQ-specific:

- One typed client over the OpenAQ v3 REST API: `X-API-Key` auth, retry with backoff, and typed upstream failures (`invalid_api_key`, `rate_limited`, `upstream_timeout`, `upstream_error`) on every OpenAQ call
- Hides the v3 location → sensor → measurement hierarchy: readings join the latest feed to the station's sensor map, and measurements resolve a station plus parameter to its sensor
- Coordinates and bbox corners are range-checked and contradictory search scopes rejected before any request reaches OpenAQ
- Large measurement series stage on a DataCanvas for read-only DuckDB SQL, one table per sensor, so two series on one `canvas_id` can be joined

Agent-friendly output:

- Measured, not modeled: a search with no station fails as `no_locations_found` or `no_station_near_coordinates`, stated as no coverage rather than clean air
- Units travel with every value and are never converted; `parametersId` selects pollutant and unit together
- Freshness and truncation are explicit: per-value timestamps and `datetimeLast`, and `totalCount` / `truncated` / `notice` on capped results

## Getting started

### Public Hosted Instance

A public instance is available at `https://openaq.caseyjhand.com/mcp` — no installation required. Point any MCP client at it via Streamable HTTP:

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

Add `"CANVAS_PROVIDER_TYPE": "duckdb"` to `env` to enable DataCanvas SQL over large measurement series.

For Streamable HTTP, set the transport and start the server:

```sh
MCP_TRANSPORT_TYPE=http MCP_HTTP_PORT=3010 OPENAQ_API_KEY=your-api-key bun run start:http
# Server listens at http://localhost:3010/mcp
```

### Prerequisites

- [Bun v1.4.0](https://bun.sh/) or higher (or Node.js v24+).
- A free OpenAQ v3 API key from an [OpenAQ Explorer](https://explore.openaq.org/) account.

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

| Variable | Description | Default |
|:---|:---|:---|
| `OPENAQ_API_KEY` | **Required.** OpenAQ v3 API key, sent as the `X-API-Key` header. | — |
| `OPENAQ_API_BASE_URL` | OpenAQ v3 API base URL, for a proxy or test mirror. | `https://api.openaq.org/v3` |
| `CANVAS_PROVIDER_TYPE` | `duckdb` stages large measurement series for SQL via the dataframe tools; without it, large series return a preview plus a notice. The `.mcpb` bundle ships without DuckDB, so use npm, npx, or Docker for canvas work. | `none` |
| `MCP_TRANSPORT_TYPE` | Transport: `stdio` or `http`. | `stdio` |
| `MCP_HTTP_PORT` | HTTP server port. | `3010` |
| `MCP_SESSION_MODE` | HTTP session mode: `stateless`, `stateful`, or `auto`. | `stateless` |
| `MCP_AUTH_MODE` | Authentication: `none`, `jwt`, or `oauth`. | `none` |
| `MCP_LOG_LEVEL` | Log level (`debug`, `info`, `warning`, `error`, etc.). | `info` |
| `OTEL_ENABLED` | Enable [OpenTelemetry](https://github.com/cyanheads/mcp-ts-core/tree/main/docs/telemetry). | `false` |

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

The image defaults to HTTP transport, stateless session mode, and logs to `/var/log/openaq-mcp-server`. DuckDB ships in the image, so DataCanvas works once `CANVAS_PROVIDER_TYPE=duckdb` is set. OpenTelemetry peer dependencies are installed by default; build with `--build-arg OTEL_ENABLED=false` to omit them.

## Project structure

| Directory | Purpose |
|:---|:---|
| `src/index.ts` | `createApp()` entry point: registers tools and resources, wires the service and canvas. |
| `src/config` | Server-specific environment variable parsing and validation with Zod. |
| `src/mcp-server/tools` | Tool definitions (`definitions/*.tool.ts`) and shared input, error, and format helpers (`shared/`). |
| `src/mcp-server/resources` | Resource definitions (`definitions/*.resource.ts`). |
| `src/services` | OpenAQ v3 client and domain types (`openaq/`), plus the DataCanvas accessor. |
| `tests/` | Unit and integration tests mirroring `src/`. |

## Development guide

See [`CLAUDE.md`](./CLAUDE.md) / [`AGENTS.md`](./AGENTS.md) for development guidelines and architectural rules. The short version:

- Handlers throw, framework catches — catch only to map a failure to a declared error reason or to keep a partial result
- Use `ctx.log` for request-scoped logging, `ctx.state` for tenant-scoped storage
- Register new tools and resources in the `createApp()` arrays
- Wrap the OpenAQ API: validate raw → normalize to the domain type → return the output schema; surface units verbatim and never fabricate missing fields

## Contributing

Issues are welcome. Run checks and tests before submitting:

```sh
bun run devcheck
bun run test
```

## License

Apache-2.0 — see [LICENSE](./LICENSE) for details.

Data comes from the [OpenAQ](https://openaq.org) platform, and attribution to OpenAQ is required when using this server's output ([Terms of Use](https://docs.openaq.org/about/terms)). OpenAQ aggregates measurements from government agencies, research institutions, and other networks, each of which may set its own attribution or licensing terms. The `provider` field on `openaq_find_locations`, `openaq_get_readings`, and `openaq_get_measurements` results and the `openaq://location/{locationId}` resource names the originating network; review and follow the terms of any provider whose data you use.
