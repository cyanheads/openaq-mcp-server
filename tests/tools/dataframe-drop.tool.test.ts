/**
 * @fileoverview Canvas reclamation through the tool contract and real tenant-scoped DuckDB.
 * @module tests/tools/dataframe-drop.tool.test
 */

import { CanvasRegistry, DataCanvas, DuckdbProvider } from '@cyanheads/mcp-ts-core/canvas';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { dataframeDrop } from '@/mcp-server/tools/definitions/dataframe-drop.tool.js';
import { setCanvas } from '@/services/canvas-accessor.js';

afterEach(() => setCanvas(undefined));

describe('openaq_dataframe_drop', () => {
  it('reports the disabled canvas provider on both error surfaces', async () => {
    const result = await runToolContract(dataframeDrop, { canvas_id: 'abc1234567' });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: { code: JsonRpcErrorCode.ServiceUnavailable, data: { reason: 'canvas_unavailable' } },
    });
    expect(result.content).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'text',
          text: expect.stringContaining('CANVAS_PROVIDER_TYPE=duckdb'),
        }),
      ]),
    );
  });

  it.each(['', 'bad', 'too-long-to-be-a-canvas', 'bad id 123'])(
    'rejects malformed %j before calling the provider',
    async (canvas_id) => {
      const result = await runToolContract(dataframeDrop, { canvas_id });
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        error: {
          code: JsonRpcErrorCode.InvalidParams,
          data: { reason: 'invalid_arguments' },
        },
      });
      expect(result.content).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: 'text', text: expect.stringContaining('canvas ID') }),
        ]),
      );
    },
  );

  it('drops an owned canvas, preserves other tenants, and reports repeat/unknown drops identically', async () => {
    const provider = new DuckdbProvider({
      memoryLimitMb: 64,
      defaultRowLimit: 200,
      schemaSniffRows: 100,
      exportRootPath: '/tmp/openaq-drop-tests',
    });
    const canvas = new DataCanvas(provider, new CanvasRegistry(provider));
    setCanvas(canvas);
    const owner = createMockContext({ tenantId: 'owner' });
    const instance = await canvas.acquire(undefined, owner);
    await instance.registerTable('measurements_1701', [{ value: 0.25 }]);
    try {
      const foreign = await runToolContract(
        dataframeDrop,
        { canvas_id: instance.canvasId },
        { context: { tenantId: 'other' } },
      );
      expect(foreign.structuredContent).toEqual({ canvasId: instance.canvasId, dropped: false });
      expect((await instance.query('SELECT value FROM measurements_1701')).rows).toEqual([
        { value: 0.25 },
      ]);
      const dropped = await runToolContract(
        dataframeDrop,
        { canvas_id: instance.canvasId },
        { context: { tenantId: 'owner' } },
      );
      expect(dropped.structuredContent).toEqual({ canvasId: instance.canvasId, dropped: true });
      expect(dropped.content).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: 'text',
            text: expect.stringContaining(instance.canvasId),
          }),
        ]),
      );
      expect(JSON.stringify(dropped.content)).toContain('true');
      expect(canvas.countForTenant(owner)).toBe(0);
      const repeated = await runToolContract(
        dataframeDrop,
        { canvas_id: instance.canvasId },
        { context: { tenantId: 'owner' } },
      );
      const unknown = await runToolContract(
        dataframeDrop,
        { canvas_id: 'missing123' },
        { context: { tenantId: 'owner' } },
      );
      expect(repeated.structuredContent).toMatchObject({ dropped: false });
      expect(unknown.structuredContent).toMatchObject({ dropped: false });
      expect(JSON.stringify(repeated.content)).toContain('false');
      expect(JSON.stringify(unknown.content)).toContain('false');
    } finally {
      await canvas.shutdown(owner);
    }
  });
});
