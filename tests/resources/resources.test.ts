/**
 * @fileoverview Resource tests — openaq://location/{locationId} (metadata + sensor
 * map, ValidationError on a malformed id, NotFound on an unknown one) and
 * openaq://parameters (full catalog mirror), plus the
 * error contracts both declare: every failure carries a reason and a recovery hint,
 * not just a code.
 * @module tests/resources/resources.test
 */

import {
  JsonRpcErrorCode,
  notFound,
  rateLimited,
  serviceUnavailable,
  timeout,
  unauthorized,
} from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { locationResource } from '@/mcp-server/resources/definitions/location.resource.js';
import { parametersResource } from '@/mcp-server/resources/definitions/parameters.resource.js';
import { setOpenAqService } from '@/services/openaq/openaq-service.js';
import { parameters, seattleLocation } from '../fixtures/openaq.js';
import { installStubService } from '../fixtures/stub-service.js';

/** Rejects any fetch, so a path that reaches the network without a stub fails loudly. */
beforeEach(() => {
  vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('unmocked fetch in a unit test'));
});

afterEach(() => {
  setOpenAqService(undefined as never);
  vi.restoreAllMocks();
});

/** The recovery text a resource declared for `reason` — what the client must receive. */
const recoveryFor = (
  errors: readonly { reason: string; recovery: string }[] | undefined,
  reason: string,
): string => {
  const entry = errors?.find((e) => e.reason === reason);
  if (!entry) throw new Error(`no contract entry declared for reason "${reason}"`);
  return entry.recovery;
};

const locationCtx = (id: string) =>
  createMockContext({
    uri: new URL(`openaq://location/${id}`),
    errors: locationResource.errors,
  });

const parametersCtx = () =>
  createMockContext({
    uri: new URL('openaq://parameters'),
    errors: parametersResource.errors,
  });

describe('openaq://location/{locationId}', () => {
  it('returns location metadata with the sensor→parameter→unit map', async () => {
    installStubService({ getLocation: async () => seattleLocation });
    const result = (await locationResource.handler({ locationId: '931' }, locationCtx('931'))) as {
      id: number;
      sensors: { parameterId: number; unit: string }[];
    };
    expect(result.id).toBe(931);
    expect(result.sensors).toEqual(
      expect.arrayContaining([expect.objectContaining({ parameterId: 2, unit: 'µg/m³' })]),
    );
  });

  it('fails a non-numeric id as invalid_location_id with a recovery hint', async () => {
    installStubService({});
    await expect(
      locationResource.handler({ locationId: 'abc' }, locationCtx('abc')),
    ).rejects.toMatchObject({
      // A malformed segment is a validation failure; NotFound is kept for an id that
      // parses but names no station, so a client can tell the two apart by code (#33).
      code: JsonRpcErrorCode.ValidationError,
      data: {
        reason: 'invalid_location_id',
        locationId: 'abc',
        recovery: { hint: recoveryFor(locationResource.errors, 'invalid_location_id') },
      },
    });
  });

  it.each([
    ['zero', '0'],
    ['negative', '-5'],
    ['fractional', '9.5'],
  ])('rejects a %s id as invalid_location_id', async (_label, id) => {
    installStubService({});
    await expect(
      locationResource.handler({ locationId: id }, locationCtx(id)),
    ).rejects.toMatchObject({ data: { reason: 'invalid_location_id' } });
  });

  it.each([
    ['zero', '0'],
    ['negative', '-5'],
    ['fractional', '9.5'],
  ])(
    'fails a %s id at ValidationError with the unchanged recovery hint, before any request (#33)',
    async (_label, id) => {
      const getLocation = vi.fn(async () => seattleLocation);
      installStubService({ getLocation });
      await expect(
        locationResource.handler({ locationId: id }, locationCtx(id)),
      ).rejects.toMatchObject({
        code: JsonRpcErrorCode.ValidationError,
        data: {
          reason: 'invalid_location_id',
          locationId: id,
          recovery: {
            hint: 'Rebuild the URI with the numeric id field from an openaq_find_locations result, e.g. openaq://location/931.',
          },
        },
      });
      expect(getLocation).not.toHaveBeenCalled();
      expect(globalThis.fetch).not.toHaveBeenCalled();
    },
  );

  it('maps an upstream 404 to location_not_found with a recovery hint', async () => {
    installStubService({
      getLocation: async () => {
        throw notFound('Location not found');
      },
    });
    await expect(
      locationResource.handler({ locationId: '99999999' }, locationCtx('99999999')),
    ).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: {
        reason: 'location_not_found',
        locationId: 99999999,
        recovery: { hint: recoveryFor(locationResource.errors, 'location_not_found') },
      },
    });
  });

  it.each([
    [
      'upstream_error',
      JsonRpcErrorCode.ServiceUnavailable,
      () =>
        serviceUnavailable('OpenAQ returned HTTP 500.', { path: '/locations/931', status: 500 }),
    ],
    [
      'rate_limited',
      JsonRpcErrorCode.RateLimited,
      () => rateLimited('OpenAQ rate limit exceeded.', { status: 429, retryAfter: '30' }),
    ],
    [
      'upstream_timeout',
      JsonRpcErrorCode.Timeout,
      () => timeout('OpenAQ did not respond within 15s.', { timeoutMs: 15_000 }),
    ],
    [
      'invalid_api_key',
      JsonRpcErrorCode.Unauthorized,
      () => unauthorized('OpenAQ rejected the API key.', { status: 401 }),
    ],
  ])('routes an upstream failure to %s with its recovery hint', async (reason, code, makeErr) => {
    installStubService({
      getLocation: async () => {
        throw makeErr();
      },
    });
    await expect(
      locationResource.handler({ locationId: '931' }, locationCtx('931')),
    ).rejects.toMatchObject({
      code,
      data: { reason, recovery: { hint: recoveryFor(locationResource.errors, reason) } },
    });
  });

  it('declares every reason its handler can throw at the code it arrives with', () => {
    expect(locationResource.errors?.map((e) => e.reason)).toEqual([
      'invalid_location_id',
      'location_not_found',
      'upstream_error',
      'rate_limited',
      'upstream_timeout',
      'invalid_api_key',
    ]);
  });
});

describe('openaq://parameters', () => {
  it('returns the full pollutant + unit catalog', async () => {
    installStubService({ listParameters: async () => parameters });
    const result = (await parametersResource.handler({}, parametersCtx())) as {
      parameters: { id: number; unit: string }[];
    };
    expect(result.parameters).toHaveLength(parameters.length);
    expect(result.parameters[0]).toMatchObject({ id: 2, unit: 'µg/m³' });
  });

  it.each([
    [
      'upstream_error',
      JsonRpcErrorCode.ServiceUnavailable,
      () =>
        serviceUnavailable('OpenAQ returned HTTP 500.', {
          path: '/parameters?limit=1000',
          status: 500,
        }),
    ],
    [
      'rate_limited',
      JsonRpcErrorCode.RateLimited,
      () => rateLimited('OpenAQ rate limit exceeded.', { status: 429, retryAfter: '30' }),
    ],
    [
      'upstream_timeout',
      JsonRpcErrorCode.Timeout,
      () => timeout('OpenAQ did not respond within 15s.', { timeoutMs: 15_000 }),
    ],
    [
      'invalid_api_key',
      JsonRpcErrorCode.Unauthorized,
      () => unauthorized('OpenAQ rejected the API key.', { status: 401 }),
    ],
  ])('routes an upstream failure to %s with its recovery hint', async (reason, code, makeErr) => {
    installStubService({
      listParameters: async () => {
        throw makeErr();
      },
    });
    await expect(parametersResource.handler({}, parametersCtx())).rejects.toMatchObject({
      code,
      data: { reason, recovery: { hint: recoveryFor(parametersResource.errors, reason) } },
    });
  });

  it('preserves the service diagnostics alongside the contract reason', async () => {
    installStubService({
      listParameters: async () => {
        throw serviceUnavailable('OpenAQ returned HTTP 500.', {
          path: '/parameters?limit=1000',
          status: 500,
        });
      },
    });
    await expect(parametersResource.handler({}, parametersCtx())).rejects.toMatchObject({
      data: { reason: 'upstream_error', path: '/parameters?limit=1000', status: 500 },
    });
  });

  it('declares the four upstream transport reasons', () => {
    expect(parametersResource.errors?.map((e) => e.reason)).toEqual([
      'upstream_error',
      'rate_limited',
      'upstream_timeout',
      'invalid_api_key',
    ]);
  });
});
