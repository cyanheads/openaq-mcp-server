# Changelog

All notable changes to this project. Each entry links to its full per-version file in [changelog/](changelog/).

## [0.2.0](changelog/0.2.x/0.2.0.md) — 2026-09-23 · ⚠️ Breaking

openaq_find_locations rejects contradictory search scopes, derives paging from its rows, and gains station-class and provider filters; openaq_list_countries pages its catalog 20 rows at a time; non-positive ids fail at the schema.

## [0.1.10](changelog/0.1.x/0.1.10.md) — 2026-09-22

openaq_get_measurements now reports honest pull totals and stages series on request; openaq_dataframe_query caps responses at 200 rows; both tools render every row they carry and point callers at describe-then-query.

## [0.1.9](changelog/0.1.x/0.1.9.md) — 2026-09-20

mcp-ts-core ^0.12.3 → ^0.13.6 — the canvas_id inputs advertise the minted-id pattern and reject a malformed id at argument validation, and an unset MCP_SESSION_MODE now resolves to stateless instead of stateful.

## [0.1.8](changelog/0.1.x/0.1.8.md) — 2026-08-24 · ⚠️ Breaking

mcp-ts-core ^0.11.0 → ^0.12.3 lands the MCP SDK v2 wire surface — protocol revision 2026-07-28, strict tool arguments, and 2020-12 schemas that declare the error envelope; a cancelled openaq_get_measurements now aborts instead of reporting a partial series.

## [0.1.7](changelog/0.1.x/0.1.7.md) — 2026-07-26

openaq_dataframe_query escapes Markdown-breaking table cells, the location and parameters resources carry typed error contracts, and 422 validation messages resolve for all four OpenAQ body shapes

## [0.1.6](changelog/0.1.x/0.1.6.md) — 2026-07-26

Six measurement-pipeline fixes: null gap-bucket values no longer fail output validation, mixed date/datetime ranges normalize correctly, a failed page or unavailable canvas preserves already-fetched rows, preview row counts are honest, and content text rounds display-only floating-point noise

## [0.1.5](changelog/0.1.x/0.1.5.md) — 2026-07-26

Upstream 5xx/429/timeout/401 failures now carry the declared reason and recovery hint on the wire instead of arriving bare; openaq_get_readings no longer misreports three failure modes

## [0.1.4](changelog/0.1.x/0.1.4.md) — 2026-07-26

openaq_list_countries gains a parametersId coverage filter and openaq_find_locations gains pagination past the 100-station cap; whitespace-tolerant coordinate/bbox parsing with readable rejection messages; empty-result responses no longer duplicate the miss across two content blocks; mcp-ts-core ^0.11.0 with TypeScript 7

## [0.1.3](changelog/0.1.x/0.1.3.md) — 2026-06-30 · 🛡️ Security

Distance-sorted nearest-station resolution and honest lower-bound totals for openaq_find_locations; exact ISO-code lookup for two-letter country queries; tool descriptions trimmed of internal mechanics; mcp-ts-core ^0.10.10 with a lock re-resolve clearing a transitive js-yaml DoS advisory

## [0.1.2](changelog/0.1.x/0.1.2.md) — 2026-06-20

mcp-ts-core ^0.10.9 maintenance — devcheck gains dependency-specifier and plugin-manifest packaging guards; re-synced devcheck scripts and framework skills; dev-dependency refresh

## [0.1.1](changelog/0.1.x/0.1.1.md) — 2026-06-15

Null-parameters crash fix for openaq_list_countries; public hosted endpoint at openaq.caseyjhand.com/mcp

## [0.1.0](changelog/0.1.x/0.1.0.md) — 2026-06-13

Initial release — measured air quality via the OpenAQ v3 API: find stations, latest readings, historical series with DataCanvas spillover, parameter and country catalogs.
