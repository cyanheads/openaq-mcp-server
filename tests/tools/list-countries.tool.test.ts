/**
 * @fileoverview openaq_list_countries tests — headline coverage catalog, local
 * filtering, empty-query notice, and plain-ISO-string datetimes (countries
 * endpoint returns strings, not {utc,local} objects).
 * @module tests/tools/list-countries.tool.test
 */

import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { listCountries } from '@/mcp-server/tools/definitions/list-countries.tool.js';
import { setOpenAqService } from '@/services/openaq/openaq-service.js';
import { countries } from '../fixtures/openaq.js';
import { installStubService } from '../fixtures/stub-service.js';

afterEach(() => setOpenAqService(undefined as never));

describe('openaq_list_countries', () => {
  it('returns countries with coverage span and measured parameters (the headline goal)', async () => {
    installStubService({ listCountries: async () => countries });
    const ctx = createMockContext();
    const result = await listCountries.handler(listCountries.input.parse({}), ctx);

    expect(result.countries).toHaveLength(2);
    const us = result.countries.find((c) => c.code === 'US');
    expect(us?.datetimeFirst).toBe('2016-01-01T00:00:00Z'); // plain string, not {utc,local}
    expect(us?.parameters.map((p) => p.name)).toContain('pm25');
    expect(getEnrichment(ctx).totalCount).toBe(2);
  });

  it('answers "which countries measure NO2" style queries via local filter', async () => {
    installStubService({ listCountries: async () => countries });
    const ctx = createMockContext();
    const result = await listCountries.handler(listCountries.input.parse({ query: 'india' }), ctx);
    expect(result.countries).toHaveLength(1);
    expect(result.countries[0]?.code).toBe('IN');
  });

  it('emits a notice when the filter matches nothing', async () => {
    installStubService({ listCountries: async () => countries });
    const ctx = createMockContext();
    const result = await listCountries.handler(
      listCountries.input.parse({ query: 'atlantis' }),
      ctx,
    );
    expect(result.countries).toHaveLength(0);
    expect(getEnrichment(ctx).notice).toContain('atlantis');
  });

  it('format renders code, id, span, and parameter ids/units', () => {
    const blocks = listCountries.format!({
      countries: [
        {
          id: 155,
          code: 'US',
          name: 'United States',
          datetimeFirst: '2016-01-01T00:00:00Z',
          datetimeLast: '2026-06-13T19:00:00Z',
          parameters: [{ id: 2, name: 'pm25', unit: 'µg/m³' }],
        },
      ],
    });
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('US');
    expect(text).toContain('155');
    expect(text).toContain('pm25');
  });
});
