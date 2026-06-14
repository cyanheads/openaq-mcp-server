/**
 * @fileoverview Module-level accessor for the optional DataCanvas service.
 * The framework wires `core.canvas` onto `CoreServices` in `setup()` (present only
 * when `CANVAS_PROVIDER_TYPE=duckdb`); handlers reach it through this accessor since
 * the canvas is not exposed on the per-request `Context`.
 * @module services/canvas-accessor
 */

import type { DataCanvas } from '@cyanheads/mcp-ts-core/canvas';

let _canvas: DataCanvas | undefined;

/** Store the canvas service (or `undefined` when canvas is disabled). Called from `setup()`. */
export const setCanvas = (canvas: DataCanvas | undefined): void => {
  _canvas = canvas;
};

/** Return the canvas service, or `undefined` when `CANVAS_PROVIDER_TYPE` is not `duckdb`. */
export const getCanvas = (): DataCanvas | undefined => _canvas;
