# Changelog

All notable changes to this project. Each entry links to its full per-version file in [changelog/](changelog/).

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
