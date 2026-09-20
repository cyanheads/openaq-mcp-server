/**
 * @fileoverview upstream-errors tests — the service-error → contract-reason
 * mapping that makes the declared upstream entries reachable. Covers all four
 * reasons, the pass-through of errors the tools handle themselves, and that the
 * service's diagnostic `data` plus the contract recovery hint both survive onto
 * the re-thrown error (which is what reaches the client).
 * @module tests/tools/upstream-errors.test
 */

import {
  type ErrorContract,
  JsonRpcErrorCode,
  type McpError,
  notFound,
  rateLimited,
  serviceUnavailable,
  timeout,
  unauthorized,
  validationError,
} from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { describe, expect, it } from 'vitest';
import { locationResource } from '@/mcp-server/resources/definitions/location.resource.js';
import { parametersResource } from '@/mcp-server/resources/definitions/parameters.resource.js';
import { findLocations } from '@/mcp-server/tools/definitions/find-locations.tool.js';
import { getMeasurements } from '@/mcp-server/tools/definitions/get-measurements.tool.js';
import { getReadings } from '@/mcp-server/tools/definitions/get-readings.tool.js';
import { listCountries } from '@/mcp-server/tools/definitions/list-countries.tool.js';
import { listParameters } from '@/mcp-server/tools/definitions/list-parameters.tool.js';
import {
  type UpstreamFailContext,
  upstreamFailure,
  withUpstream,
} from '@/mcp-server/tools/shared/upstream-errors.js';

const contract = [
  {
    reason: 'upstream_error',
    code: JsonRpcErrorCode.ServiceUnavailable,
    when: 'OpenAQ returned 5xx or an unreadable body on every retry.',
    recovery: 'Retry after a short backoff before giving up on the request.',
    retryable: true,
  },
  {
    reason: 'rate_limited',
    code: JsonRpcErrorCode.RateLimited,
    when: 'OpenAQ returned 429 — the request budget is exhausted.',
    recovery: 'Wait the retryAfter seconds in data before retrying the request.',
    retryable: true,
  },
  {
    reason: 'upstream_timeout',
    code: JsonRpcErrorCode.Timeout,
    when: 'OpenAQ did not respond within the request timeout.',
    recovery: 'Retry once after a short pause, then narrow the request.',
    retryable: true,
  },
  {
    reason: 'invalid_api_key',
    code: JsonRpcErrorCode.Unauthorized,
    when: 'OpenAQ returned 401 — the configured key is missing or rejected.',
    recovery: 'Replace the server OPENAQ_API_KEY with a valid key; retrying cannot help.',
    retryable: false,
  },
] as const;

const ctx = (): UpstreamFailContext => createMockContext({ errors: contract });

describe('upstreamFailure', () => {
  it('maps ServiceUnavailable to upstream_error with the contract recovery on the wire', () => {
    const mapped = upstreamFailure(
      ctx(),
      serviceUnavailable('OpenAQ returned HTTP 500.', { path: '/countries', status: 500 }),
    ) as McpError;

    expect(mapped.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(mapped.data).toMatchObject({
      reason: 'upstream_error',
      retryable: true,
      path: '/countries',
      status: 500,
      recovery: { hint: contract[0].recovery },
    });
  });

  it('maps RateLimited to rate_limited and preserves retryAfter', () => {
    const mapped = upstreamFailure(
      ctx(),
      rateLimited('OpenAQ rate limit exceeded.', {
        path: '/parameters',
        status: 429,
        retryAfter: '30',
      }),
    ) as McpError;

    expect(mapped.code).toBe(JsonRpcErrorCode.RateLimited);
    expect(mapped.data).toMatchObject({
      reason: 'rate_limited',
      retryAfter: '30',
      recovery: { hint: contract[1].recovery },
    });
  });

  it('maps Timeout to upstream_timeout rather than collapsing it into upstream_error', () => {
    const mapped = upstreamFailure(
      ctx(),
      timeout('OpenAQ did not respond within 15s.', { path: '/locations', timeoutMs: 15_000 }),
    ) as McpError;

    expect(mapped.code).toBe(JsonRpcErrorCode.Timeout);
    expect(mapped.data).toMatchObject({
      reason: 'upstream_timeout',
      timeoutMs: 15_000,
      recovery: { hint: contract[2].recovery },
    });
  });

  it('maps Unauthorized to invalid_api_key and marks it non-retryable', () => {
    const mapped = upstreamFailure(
      ctx(),
      unauthorized('OpenAQ rejected the API key.', { path: '/countries', status: 401 }),
    ) as McpError;

    expect(mapped.code).toBe(JsonRpcErrorCode.Unauthorized);
    expect(mapped.data).toMatchObject({
      reason: 'invalid_api_key',
      retryable: false,
      status: 401,
      recovery: { hint: contract[3].recovery },
    });
  });

  it('keeps the original error as its own cause so the service message survives', () => {
    const original = serviceUnavailable('OpenAQ returned HTTP 503.', { status: 503 });
    const mapped = upstreamFailure(ctx(), original) as McpError;
    expect(mapped.message).toContain('503');
    expect(mapped.cause).toBe(original);
  });

  it('passes NotFound through untouched so per-tool handling still owns it', () => {
    const original = notFound('OpenAQ resource not found.', { status: 404 });
    expect(upstreamFailure(ctx(), original)).toBe(original);
  });

  it('passes ValidationError through untouched', () => {
    const original = validationError('OpenAQ rejected the request parameters.');
    expect(upstreamFailure(ctx(), original)).toBe(original);
  });

  it('passes a plain Error through untouched', () => {
    const original = new Error('boom');
    expect(upstreamFailure(ctx(), original)).toBe(original);
  });
});

describe('withUpstream', () => {
  it('returns the call result when it succeeds', async () => {
    await expect(withUpstream(ctx(), async () => 'ok')).resolves.toBe('ok');
  });

  it('re-throws an upstream failure through the contract', async () => {
    await expect(
      withUpstream(ctx(), async () => {
        throw serviceUnavailable('OpenAQ returned HTTP 502.', { status: 502 });
      }),
    ).rejects.toMatchObject({ data: { reason: 'upstream_error' } });
  });

  it('re-throws a non-upstream failure unchanged', async () => {
    await expect(
      withUpstream(ctx(), async () => {
        throw notFound('nope');
      }),
    ).rejects.toMatchObject({ code: JsonRpcErrorCode.NotFound });
  });
});

/**
 * These four reasons are produced by `upstreamFailure` below the handler, so no
 * literal `ctx.fail('<reason>'` names them in a definition file and
 * `error-contract-unthrown` cannot see them as wired. `thrownBy: 'service'` is
 * what tells the rule so. Two of these definitions hold no literal `ctx.fail` at
 * all, which makes the linter blind to the whole file — this is the only guard
 * that a future edit does not quietly drop the marker.
 */
describe('every definition routing through upstreamFailure marks those reasons service-thrown', () => {
  /**
   * Each definition infers its own `errors[]` as a literal tuple, so reading a
   * shared field off one means viewing it as the contract type the builders take.
   */
  type Declaring = { readonly errors?: readonly ErrorContract[] };

  const definitions: readonly (readonly [string, Declaring])[] = [
    ['openaq_find_locations', findLocations],
    ['openaq_get_readings', getReadings],
    ['openaq_get_measurements', getMeasurements],
    ['openaq_list_parameters', listParameters],
    ['openaq_list_countries', listCountries],
    ['openaq-location resource', locationResource],
    ['openaq-parameters resource', parametersResource],
  ];

  const UPSTREAM_REASONS = [
    'upstream_error',
    'rate_limited',
    'upstream_timeout',
    'invalid_api_key',
  ];

  it.each(definitions)('%s declares all four upstream reasons', (_name, def) => {
    const reasons = def.errors?.map((e) => e.reason) ?? [];
    for (const reason of UPSTREAM_REASONS) expect(reasons).toContain(reason);
  });

  it.each(definitions)('%s marks each upstream reason thrownBy service', (_name, def) => {
    for (const reason of UPSTREAM_REASONS) {
      const entry = def.errors?.find((e) => e.reason === reason);
      expect(entry, `${reason} is declared`).toBeDefined();
      expect(entry?.thrownBy, `${reason} is marked service-thrown`).toBe('service');
    }
  });

  it('leaves a handler-thrown reason unmarked, so the lint rule still checks it', () => {
    const declaring: Declaring = findLocations;
    const handlerThrown = declaring.errors?.find((e) => e.reason === 'no_search_scope');
    expect(handlerThrown).toBeDefined();
    expect(handlerThrown?.thrownBy).toBeUndefined();
  });
});
