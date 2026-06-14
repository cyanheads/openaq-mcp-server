#!/usr/bin/env node
/**
 * @fileoverview openaq-mcp-server MCP server entry point. Exposes measured air
 * quality from the OpenAQ v3 API (physical-sensor observations from government
 * reference monitors and research-grade sensors worldwide).
 * @module index
 */

import { createApp } from '@cyanheads/mcp-ts-core';
import { locationResource } from './mcp-server/resources/definitions/location.resource.js';
import { parametersResource } from './mcp-server/resources/definitions/parameters.resource.js';
import { dataframeDescribe } from './mcp-server/tools/definitions/dataframe-describe.tool.js';
import { dataframeQuery } from './mcp-server/tools/definitions/dataframe-query.tool.js';
import { findLocations } from './mcp-server/tools/definitions/find-locations.tool.js';
import { getMeasurements } from './mcp-server/tools/definitions/get-measurements.tool.js';
import { getReadings } from './mcp-server/tools/definitions/get-readings.tool.js';
import { listCountries } from './mcp-server/tools/definitions/list-countries.tool.js';
import { listParameters } from './mcp-server/tools/definitions/list-parameters.tool.js';
import { setCanvas } from './services/canvas-accessor.js';
import { initOpenAqService } from './services/openaq/openaq-service.js';

await createApp({
  name: 'openaq-mcp-server',
  title: 'openaq-mcp-server',
  tools: [
    findLocations,
    getReadings,
    getMeasurements,
    listParameters,
    listCountries,
    dataframeQuery,
    dataframeDescribe,
  ],
  resources: [locationResource, parametersResource],
  instructions:
    'Measured air quality from physical sensors (OpenAQ v3) — the ground-truth counterpart to modeled air-quality grids. Workflow: openaq_find_locations (find stations near a point / in a bbox / by country) → openaq_get_readings (latest values) or openaq_get_measurements (historical series). An empty find_locations result means NO monitoring coverage, NOT clean air — widen the radius, check openaq_list_countries, or fall back to open-meteo-mcp-server for modeled coverage. Units vary by sensor and are NEVER converted; the same pollutant has multiple parameter ids for different units (use openaq_list_parameters to disambiguate). Large measurement series spill to a DataCanvas — query them with openaq_dataframe_query (requires CANVAS_PROVIDER_TYPE=duckdb).',
  setup(core) {
    initOpenAqService(core.config, core.storage);
    setCanvas(core.canvas);
  },
});
