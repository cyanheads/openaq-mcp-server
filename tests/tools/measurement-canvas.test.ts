/**
 * @fileoverview Measurement precision through real DuckDB staging and query tools.
 * @module tests/tools/measurement-canvas.test
 */

import {
  CanvasIdSchema,
  CanvasRegistry,
  DataCanvas,
  DuckdbProvider,
} from '@cyanheads/mcp-ts-core/canvas';
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { dataframeQuery } from '@/mcp-server/tools/definitions/dataframe-query.tool.js';
import { getMeasurements } from '@/mcp-server/tools/definitions/get-measurements.tool.js';
import { setCanvas } from '@/services/canvas-accessor.js';
import { setOpenAqService } from '@/services/openaq/openaq-service.js';
import { makeBucket, seattleLocation } from '../fixtures/openaq.js';
import { installStubService } from '../fixtures/stub-service.js';

afterEach(() => {
  setCanvas(undefined);
  setOpenAqService(undefined as never);
});

describe('measurement canvas numeric columns', () => {
  it.each([0, null])('preserves decimals after 100 leading %s values', async (leading) => {
    const provider = new DuckdbProvider({
      memoryLimitMb: 64,
      defaultRowLimit: 200,
      schemaSniffRows: 100,
      exportRootPath: '/tmp/openaq-canvas-tests',
    });
    const canvas = new DataCanvas(provider, new CanvasRegistry(provider));
    setCanvas(canvas);
    const rows = Array.from({ length: 101 }, (_, index) => {
      const from = new Date(Date.UTC(2026, 4, 1, index)).toISOString().replace('.000Z', 'Z');
      const to = new Date(Date.UTC(2026, 4, 1, index + 1)).toISOString().replace('.000Z', 'Z');
      const value = index === 100 ? 0.25 : leading;
      const row = makeBucket(from, to, { value });
      return {
        ...row,
        summary: { min: value, median: value, max: value, avg: value, sd: value },
        coverage:
          index < 100 && leading === null ? {} : { percentComplete: index === 100 ? 87.5 : 100 },
        flagInfo: { hasFlags: index === 100 },
      };
    });
    installStubService({
      getLocation: async () => seattleLocation,
      getMeasurements: async () => ({
        results: rows,
        found: rows.length,
        foundIsLowerBound: false,
      }),
    });
    try {
      const staged = await runToolContract(getMeasurements, {
        locationId: 931,
        parametersId: 2,
        aggregation: 'hourly',
      });
      expect(staged.isError).not.toBe(true);
      const stagedOutput = getMeasurements.output.parse(staged.structuredContent);
      const canvasId = CanvasIdSchema.parse(stagedOutput.canvasId);
      expect(stagedOutput.series).toHaveLength(100);
      expect(stagedOutput.pulledCount).toBe(101);
      expect(stagedOutput.truncated).toBe(true);
      const queried = await runToolContract(dataframeQuery, {
        canvas_id: canvasId,
        sql: 'SELECT * FROM measurements_1701 ORDER BY datetimeFrom DESC LIMIT 1',
      });
      expect(queried.isError).not.toBe(true);
      expect(dataframeQuery.output.parse(queried.structuredContent).rows).toEqual([
        {
          value: 0.25,
          min: 0.25,
          median: 0.25,
          max: 0.25,
          avg: 0.25,
          sd: 0.25,
          percentComplete: 87.5,
          datetimeFrom: rows[100]!.period.datetimeFrom.utc,
          datetimeTo: rows[100]!.period.datetimeTo.utc,
          flagged: true,
        },
      ]);
      const text = queried.content
        .map((block) => (block.type === 'text' ? block.text : ''))
        .join('\n');
      expect(text).toContain('0.25');
      expect(text).toContain('87.5');
      expect(text).toContain(rows[100]!.period.datetimeFrom.utc);
      expect(text).toContain(rows[100]!.period.datetimeTo.utc);
      expect(text).toContain('true');
      const first = await runToolContract(dataframeQuery, {
        canvas_id: canvasId,
        sql: 'SELECT * FROM measurements_1701 ORDER BY datetimeFrom LIMIT 1',
      });
      expect(dataframeQuery.output.parse(first.structuredContent).rows).toEqual([
        {
          datetimeFrom: rows[0]!.period.datetimeFrom.utc,
          datetimeTo: rows[0]!.period.datetimeTo.utc,
          flagged: false,
          value: leading,
          min: leading,
          median: leading,
          max: leading,
          avg: leading,
          sd: leading,
          percentComplete: leading === null ? null : 100,
        },
      ]);
      const reused = await runToolContract(getMeasurements, {
        locationId: 931,
        parametersId: 2,
        aggregation: 'hourly',
        canvas_id: canvasId,
      });
      expect(getMeasurements.output.parse(reused.structuredContent).canvasId).toBe(canvasId);
      expect(JSON.stringify(reused.structuredContent)).toContain('replaced the earlier');
      expect(JSON.stringify(reused.content)).toContain('replaced the earlier');
    } finally {
      await canvas.shutdown(createMockContext());
    }
  });
});
