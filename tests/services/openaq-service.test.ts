/**
 * @fileoverview OpenAqService tests — error classification and meta.found parsing.
 * Mocks the global fetch boundary. The non-OK mock RETURNS a non-OK Response and
 * the test asserts the service THROWS (never returns it) — exercising the dead
 * error-path the framework's real fetchWithTimeout guards with the same contract.
 * @module tests/services/openaq-service.test
 */

import { JsonRpcErrorCode, type McpError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetServerConfig } from '@/config/server-config.js';
import {
  extractValidationMessage,
  interpretFound,
  OpenAqService,
  parseFound,
} from '@/services/openaq/openaq-service.js';
import {
  parameters,
  seattleLocation,
  sparseLocation,
  unsortedByDistance,
} from '../fixtures/openaq.js';

const okJson = (body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

/** A non-OK response — the mock RETURNS it; the service must THROW on it. */
const errorResponse = (status: number, body: string, headers?: Record<string, string>): Response =>
  new Response(body, { status, headers });

function makeService(): OpenAqService {
  return new OpenAqService({} as never, {} as never);
}

describe('parseFound', () => {
  it('returns a number unchanged', () => {
    expect(parseFound(42)).toBe(42);
  });
  it('parses ">N" strings as Infinity (more pages exist)', () => {
    expect(parseFound('>2')).toBe(Number.POSITIVE_INFINITY);
  });
  it('parses a plain numeric string', () => {
    expect(parseFound('150')).toBe(150);
  });
  it('treats undefined as 0', () => {
    expect(parseFound(undefined)).toBe(0);
  });
});

describe('interpretFound', () => {
  it('treats a bare number as an exact total', () => {
    expect(interpretFound(150)).toEqual({ total: 150, isLowerBound: false });
  });
  it('treats ">N" as a lower bound with N as the floor', () => {
    expect(interpretFound('>5')).toEqual({ total: 5, isLowerBound: true });
  });
  it('parses a plain numeric string as exact', () => {
    expect(interpretFound('42')).toEqual({ total: 42, isLowerBound: false });
  });
  it('treats undefined as an exact zero', () => {
    expect(interpretFound(undefined)).toEqual({ total: 0, isLowerBound: false });
  });
});

describe('extractValidationMessage', () => {
  it('pulls msg out of the Python-repr 422 body', () => {
    const body =
      "[{'type': 'less_than_equal', 'loc': ('query', 'radius'), 'msg': 'Input should be less than or equal to 25000'}]";
    expect(extractValidationMessage(body)).toBe('Input should be less than or equal to 25000');
  });
  it('falls back when no msg present', () => {
    expect(extractValidationMessage('garbage')).toContain('rejected');
  });
});

describe('OpenAqService error classification', () => {
  beforeEach(() => {
    vi.stubEnv('OPENAQ_API_KEY', 'test-key');
    vi.stubEnv('OPENAQ_API_BASE_URL', 'https://api.openaq.org/v3');
    resetServerConfig();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    resetServerConfig();
  });

  it('sends the X-API-Key header and parses results', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(okJson({ results: parameters }));
    const svc = makeService();
    const result = await svc.listParameters(createMockContext());
    expect(result).toHaveLength(parameters.length);
    const init = fetchSpy.mock.calls[0]?.[1] as RequestInit;
    expect((init.headers as Record<string, string>)['X-API-Key']).toBe('test-key');
  });

  it('throws NotFound on a 404 (does not return the non-OK response)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      errorResponse(404, JSON.stringify({ detail: 'Location not found' })),
    );
    const svc = makeService();
    await expect(svc.getLocation(99999999, createMockContext())).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
    });
  });

  it('throws ValidationError on a 422, extracting the Python-repr msg', async () => {
    const body =
      "[{'type': 'less_than_equal', 'loc': ('query', 'radius'), 'msg': 'Input should be less than or equal to 25000'}]";
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(errorResponse(422, body));
    const svc = makeService();
    await expect(
      svc.findLocations(
        { coordinates: '47.6,-122.3', radius: 26000, limit: 1 },
        createMockContext(),
      ),
    ).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      message: expect.stringContaining('25000'),
    });
  });

  /**
   * Retryable codes (429, 5xx, transient parse failures) drive `withRetry`
   * through real backoff delays. Fake timers advance through them instantly so
   * the classification assertion doesn't pay the ~3s wall-clock retry cost.
   */
  async function expectClassifiedAfterRetries(
    promise: Promise<unknown>,
    code: JsonRpcErrorCode,
  ): Promise<void> {
    const settled = promise.then(
      () => ({ ok: true as const }),
      (e: McpError) => ({ ok: false as const, e }),
    );
    await vi.runAllTimersAsync();
    const outcome = await settled;
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.e.code).toBe(code);
  }

  it('throws RateLimited on a 429 (retried, then surfaced)', async () => {
    vi.useFakeTimers();
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      errorResponse(429, 'Too Many Requests'),
    );
    const svc = makeService();
    await expectClassifiedAfterRetries(
      svc.listCountries(createMockContext()),
      JsonRpcErrorCode.RateLimited,
    );
    vi.useRealTimers();
  });

  it('maps the plain-text 500 (bad coords) to ServiceUnavailable, not SerializationError', async () => {
    vi.useFakeTimers();
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      errorResponse(500, 'Internal Server Error'),
    );
    const svc = makeService();
    await expectClassifiedAfterRetries(
      svc.listParameters(createMockContext()),
      JsonRpcErrorCode.ServiceUnavailable,
    );
    vi.useRealTimers();
  });

  it('maps a 200 non-JSON body to ServiceUnavailable, not SerializationError', async () => {
    vi.useFakeTimers();
    // Fresh Response per call — a Response body is single-use.
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      async () => new Response('<html>rate limited</html>', { status: 200 }),
    );
    const svc = makeService();
    await expectClassifiedAfterRetries(
      svc.listParameters(createMockContext()),
      JsonRpcErrorCode.ServiceUnavailable,
    );
    vi.useRealTimers();
  });

  it('getLocation throws NotFound when the results array is empty', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(okJson({ results: [] }));
    const svc = makeService();
    await expect(svc.getLocation(931, createMockContext())).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
    });
  });

  it('getMeasurements parses meta.found and returns the page', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(okJson({ meta: { found: '>2' }, results: [] }));
    const svc = makeService();
    const page = await svc.getMeasurements(
      1701,
      { aggregation: 'daily', limit: 1000, page: 1 },
      createMockContext(),
    );
    expect(page.found).toBe(Number.POSITIVE_INFINITY);
    expect(page.results).toEqual([]);
  });

  it('getLocation returns the first result for a known id', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(okJson({ results: [seattleLocation] }));
    const svc = makeService();
    const loc = await svc.getLocation(931, createMockContext());
    expect(loc.id).toBe(931);
    expect(loc.sensors).toHaveLength(2);
  });
});

describe('OpenAqService.findLocations distance sort (#2)', () => {
  beforeEach(() => {
    vi.stubEnv('OPENAQ_API_KEY', 'test-key');
    vi.stubEnv('OPENAQ_API_BASE_URL', 'https://api.openaq.org/v3');
    resetServerConfig();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    resetServerConfig();
  });

  it('sorts coordinate results ascending by distance so results[0] is the nearest', async () => {
    // Upstream returns Bremerton (22km) before the 1.4km Seattle station — the repro.
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(okJson({ results: unsortedByDistance }));
    const svc = makeService();
    const res = await svc.findLocations(
      { coordinates: '47.6062,-122.3321', radius: 12000, parametersId: 2, limit: 5 },
      createMockContext(),
    );
    expect(res.results.map((r) => r.distance)).toEqual([1364.84, 4575.1, 22257.53]);
    expect(res.results[0]?.id).toBe(931); // Seattle, not Bremerton (917)
  });

  it('leaves bbox results (distance null) in upstream order', async () => {
    const bboxResults = [
      { ...sparseLocation, id: 1 },
      { ...sparseLocation, id: 2 },
    ];
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(okJson({ results: bboxResults }));
    const svc = makeService();
    const res = await svc.findLocations(
      { bbox: '77.0,28.4,77.4,28.8', limit: 5 },
      createMockContext(),
    );
    expect(res.results.map((r) => r.id)).toEqual([1, 2]);
  });
});
