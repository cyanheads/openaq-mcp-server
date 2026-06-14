/**
 * @fileoverview Shared schema fragments and type guards reused across tool
 * definitions. Keeps identical Zod snippets single-sourced so a change to the
 * UTC/local timestamp shape is one edit, not two.
 * @module mcp-server/tools/shared/schema-helpers
 */

import { z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';

/** UTC + local timestamp pair, as returned by the OpenAQ locations/sensors endpoints. */
export const datetimePair = z.object({
  utc: z.string().describe('Timestamp in UTC (ISO 8601)'),
  local: z.string().describe("Timestamp in the station's local timezone"),
});

/** Returns true when `err` is a McpError with a NotFound code. */
export const isNotFound = (err: unknown): boolean =>
  err instanceof McpError && err.code === JsonRpcErrorCode.NotFound;
