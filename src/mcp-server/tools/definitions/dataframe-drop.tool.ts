/**
 * @fileoverview Opt-in reclamation of a complete measurement canvas and its tables.
 * @module mcp-server/tools/definitions/dataframe-drop.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { CanvasIdSchema } from '@cyanheads/mcp-ts-core/canvas';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getCanvas } from '@/services/canvas-accessor.js';

/** Delete one reachable canvas; unknown or previously deleted handles are a no-op. */
export const dataframeDrop = tool('openaq_dataframe_drop', {
  title: 'openaq-mcp-server: dataframe drop',
  description:
    'Delete a measurement canvas and every table staged on it, releasing its resources. Pass the canvasId returned by openaq_get_measurements only when its staged data is no longer needed; other agents sharing that id lose access too. This does not delete any OpenAQ data. Returns dropped=false when the canvas is unknown, expired, or already deleted. Available only when OPENAQ_ENABLE_CANVAS_DROP=true.',
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
  input: z.object({
    canvas_id: CanvasIdSchema.describe(
      'Canvas id returned by openaq_get_measurements. Deletes the whole canvas, not one table.',
    ),
  }),
  output: z.object({
    canvasId: z.string().describe('The canvas id requested for deletion.'),
    dropped: z
      .boolean()
      .describe(
        'True when a reachable canvas was deleted; false when no reachable canvas existed.',
      ),
  }),
  errors: [
    {
      reason: 'canvas_unavailable',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'DataCanvas is not enabled (CANVAS_PROVIDER_TYPE is not duckdb).',
      recovery:
        'Set CANVAS_PROVIDER_TYPE=duckdb and restart the server to enable canvas operations.',
      retryable: false,
    },
  ],
  async handler(input, ctx) {
    const canvas = getCanvas();
    if (!canvas) {
      throw ctx.fail('canvas_unavailable', undefined, ctx.recoveryFor('canvas_unavailable'));
    }
    const dropped = await canvas.drop(input.canvas_id, ctx);
    ctx.log.info('Canvas drop completed', { canvasId: input.canvas_id, dropped });
    return { canvasId: input.canvas_id, dropped };
  },
  format: (result) => [
    {
      type: 'text',
      text: `Canvas ${result.canvasId}: dropped=${result.dropped}. ${result.dropped ? 'All staged tables were deleted.' : 'No reachable canvas was found; nothing was deleted.'}`,
    },
  ],
});
