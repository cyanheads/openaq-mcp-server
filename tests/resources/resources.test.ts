/**
 * @fileoverview Resource tests — openaq://location/{locationId} (metadata + sensor
 * map, NotFound on bad id) and openaq://parameters (full catalog mirror).
 * @module tests/resources/resources.test
 */

import { JsonRpcErrorCode, notFound } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { locationResource } from '@/mcp-server/resources/definitions/location.resource.js';
import { parametersResource } from '@/mcp-server/resources/definitions/parameters.resource.js';
import { setOpenAqService } from '@/services/openaq/openaq-service.js';
import { parameters, seattleLocation } from '../fixtures/openaq.js';
import { installStubService } from '../fixtures/stub-service.js';

afterEach(() => setOpenAqService(undefined as never));

describe('openaq://location/{locationId}', () => {
  it('returns location metadata with the sensor→parameter→unit map', async () => {
    installStubService({ getLocation: async () => seattleLocation });
    const ctx = createMockContext({ uri: new URL('openaq://location/931') });
    const result = (await locationResource.handler({ locationId: '931' }, ctx)) as {
      id: number;
      sensors: { parameterId: number; unit: string }[];
    };
    expect(result.id).toBe(931);
    expect(result.sensors).toEqual(
      expect.arrayContaining([expect.objectContaining({ parameterId: 2, unit: 'µg/m³' })]),
    );
  });

  it('throws NotFound for a non-numeric id', async () => {
    installStubService({});
    const ctx = createMockContext({ uri: new URL('openaq://location/abc') });
    await expect(locationResource.handler({ locationId: 'abc' }, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
    });
  });

  it('maps an upstream 404 to NotFound', async () => {
    installStubService({
      getLocation: async () => {
        throw notFound('Location not found');
      },
    });
    const ctx = createMockContext({ uri: new URL('openaq://location/99999999') });
    await expect(locationResource.handler({ locationId: '99999999' }, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
    });
  });
});

describe('openaq://parameters', () => {
  it('returns the full pollutant + unit catalog', async () => {
    installStubService({ listParameters: async () => parameters });
    const ctx = createMockContext({ uri: new URL('openaq://parameters') });
    const result = (await parametersResource.handler({}, ctx)) as {
      parameters: { id: number; unit: string }[];
    };
    expect(result.parameters).toHaveLength(parameters.length);
    expect(result.parameters[0]).toMatchObject({ id: 2, unit: 'µg/m³' });
  });
});
