/**
 * @fileoverview openaq_list_parameters tests — headline catalog fetch, local
 * filtering, pollutantsOnly, empty-query notice, and unit-disambiguation (the
 * same pollutant under multiple ids/units).
 * @module tests/tools/list-parameters.tool.test
 */

import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { listParameters } from '@/mcp-server/tools/definitions/list-parameters.tool.js';
import { setOpenAqService } from '@/services/openaq/openaq-service.js';
import { parameters } from '../fixtures/openaq.js';
import { installStubService } from '../fixtures/stub-service.js';

afterEach(() => setOpenAqService(undefined as never));

describe('openaq_list_parameters', () => {
  it('returns the full catalog with id, unit, and displayName (the headline goal)', async () => {
    installStubService({ listParameters: async () => parameters });
    const ctx = createMockContext();
    const result = await listParameters.handler(listParameters.input.parse({}), ctx);

    expect(result.parameters).toHaveLength(parameters.length);
    const co = result.parameters.filter((p) => p.name === 'co');
    // The unit-disambiguation property: co appears under 3 ids with 3 units.
    expect(co.map((p) => `${p.id}:${p.unit}`).sort()).toEqual(['102:ppb', '4:µg/m³', '8:ppm']);
    expect(getEnrichment(ctx).totalCount).toBe(parameters.length);
  });

  it('filters locally by query (case-insensitive over code/displayName/description)', async () => {
    installStubService({ listParameters: async () => parameters });
    const ctx = createMockContext();
    const result = await listParameters.handler(
      listParameters.input.parse({ query: 'carbon monoxide' }),
      ctx,
    );
    expect(result.parameters.every((p) => p.name === 'co')).toBe(true);
    expect(result.parameters).toHaveLength(3);
  });

  it('pollutantsOnly excludes meteorological/auxiliary parameters', async () => {
    installStubService({ listParameters: async () => parameters });
    const ctx = createMockContext();
    const result = await listParameters.handler(
      listParameters.input.parse({ pollutantsOnly: true }),
      ctx,
    );
    const names = result.parameters.map((p) => p.name);
    expect(names).not.toContain('temperature');
    expect(names).not.toContain('wind_speed');
    expect(names).toContain('pm25');
  });

  it('emits a notice and empty array when the query matches nothing', async () => {
    installStubService({ listParameters: async () => parameters });
    const ctx = createMockContext();
    const result = await listParameters.handler(
      listParameters.input.parse({ query: 'zzznotapollutant' }),
      ctx,
    );
    expect(result.parameters).toHaveLength(0);
    expect(getEnrichment(ctx).notice).toContain('zzznotapollutant');
  });

  it('format renders id, code, unit, and display name', () => {
    const blocks = listParameters.format!({
      parameters: [
        { id: 8, name: 'co', displayName: 'CO', unit: 'ppm', description: 'Carbon monoxide' },
      ],
    });
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('8');
    expect(text).toContain('co');
    expect(text).toContain('ppm');
  });
});
