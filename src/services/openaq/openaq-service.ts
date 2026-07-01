/**
 * @fileoverview OpenAqService — wraps the OpenAQ v3 REST API (api.openaq.org/v3).
 * One base URL, one auth model (`X-API-Key` header), one error envelope, one
 * retry policy. Methods mirror the API shapes; tool handlers reshape/join them.
 *
 * Error classification (live-probed 2026-06-13):
 *  - 404 `{"detail":"Location not found"}` (clean JSON) → NotFound.
 *  - 422 `"[{'type':...,'msg':...}]"` — a JSON STRING wrapping a Python repr, NOT
 *    a JSON array. Regex-extract the `msg` value; surface as ValidationError.
 *  - 500 `Internal Server Error` (plain text) for unvalidated bad input (e.g.
 *    coordinates=999,999). Defended at the Zod edge; backstop → transient
 *    ServiceUnavailable, never SerializationError.
 *  - 429 → RateLimited, retryable (honor Retry-After).
 * @module services/openaq/openaq-service
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import {
  notFound,
  rateLimited,
  serviceUnavailable,
  validationError,
} from '@cyanheads/mcp-ts-core/errors';
import type { StorageService } from '@cyanheads/mcp-ts-core/storage';
import { withRetry } from '@cyanheads/mcp-ts-core/utils';
import { getServerConfig } from '@/config/server-config.js';
import type {
  OpenAqAggregation,
  OpenAqCountry,
  OpenAqLatest,
  OpenAqListResponse,
  OpenAqLocation,
  OpenAqMeasurement,
  OpenAqParameter,
} from './types.js';

/** Filters for `GET /v3/locations`. Exactly the upstream query params we forward. */
export interface FindLocationsParams {
  bbox?: string;
  coordinates?: string;
  iso?: string;
  limit: number;
  page?: number;
  parametersId?: number;
  radius?: number;
}

/** Filters for `GET /v3/sensors/{id}/measurements[/hourly|/daily]`. */
export interface MeasurementsParams {
  aggregation: OpenAqAggregation;
  datetimeFrom?: string;
  datetimeTo?: string;
  limit: number;
  page: number;
}

/** A measurements page, carrying the parsed `meta.found` total for enrichment. */
export interface MeasurementsPage {
  /** Parsed total across all pages — `Infinity` when the API reports `">N"`. */
  found: number;
  results: OpenAqMeasurement[];
}

const FETCH_TIMEOUT_MS = 15_000;

/**
 * Interpret `meta.found` (which may be a string like `">5"`) into a numeric floor
 * plus whether it is a lower bound. `">N"` means strictly more than N exist, so the
 * embedded number is a floor, not an exact total. A bare number is exact.
 */
function interpretFound(found: number | string | undefined): {
  isLowerBound: boolean;
  total: number;
} {
  if (typeof found === 'number') return { total: found, isLowerBound: false };
  if (typeof found === 'string') {
    const digits = found.replace(/[^\d]/g, '');
    return { total: digits.length > 0 ? Number(digits) : 0, isLowerBound: found.includes('>') };
  }
  return { total: 0, isLowerBound: false };
}

/**
 * `meta.found` → a usable number for the measurement pager. A `">N"` lower bound is
 * an unbounded ceiling (`Infinity`) — the row cap, not this value, bounds the pull.
 */
function parseFound(found: number | string | undefined): number {
  const { total, isLowerBound } = interpretFound(found);
  return isLowerBound ? Number.POSITIVE_INFINITY : total;
}

/** Pull the first `'msg'` value out of OpenAQ's Python-repr 422 body. */
function extractValidationMessage(body: string): string {
  const match = body.match(/'msg':\s*'([^']*)'/);
  return match?.[1] ?? 'OpenAQ rejected the request parameters.';
}

export class OpenAqService {
  private readonly baseUrl: string;
  private readonly apiKey: string;

  constructor(_config: AppConfig, _storage: StorageService) {
    const cfg = getServerConfig();
    this.baseUrl = cfg.baseUrl.replace(/\/$/, '');
    this.apiKey = cfg.apiKey;
  }

  /**
   * Single-attempt GET with auth header, timeout, and OpenAQ-specific error
   * classification. The caller (each public method) wraps this in `withRetry`.
   */
  private async request<T>(path: string, ctx: Context): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const timeout = AbortSignal.timeout(FETCH_TIMEOUT_MS);
    const signal = AbortSignal.any([timeout, ctx.signal]);

    let response: Response;
    try {
      response = await fetch(url, {
        method: 'GET',
        headers: { 'X-API-Key': this.apiKey, Accept: 'application/json' },
        signal,
      });
    } catch (err) {
      if (timeout.aborted) {
        throw serviceUnavailable('OpenAQ request timed out.', { path }, { cause: err });
      }
      // Network-level failure (DNS, connection reset) — transient.
      throw serviceUnavailable('OpenAQ request failed.', { path }, { cause: err });
    }

    if (!response.ok) {
      await this.throwForStatus(response, path);
    }

    const text = await response.text();
    try {
      return JSON.parse(text) as T;
    } catch (err) {
      // HTTP 200 with a non-JSON body (CDN page, plain-text error) — transient,
      // not a SerializationError (the data didn't fail to deserialize, the
      // upstream returned the wrong content).
      throw serviceUnavailable('OpenAQ returned a non-JSON response.', { path }, { cause: err });
    }
  }

  /** Map a non-OK OpenAQ response to the correct McpError. Always throws. */
  private async throwForStatus(response: Response, path: string): Promise<never> {
    const status = response.status;
    const body = await response.text().catch(() => '');

    if (status === 404) {
      // Clean JSON `{"detail":"..."}` — surface as NotFound. Reason set by the handler's contract.
      throw notFound('OpenAQ resource not found.', { path, status });
    }
    if (status === 422) {
      throw validationError(extractValidationMessage(body), { path, status });
    }
    if (status === 429) {
      const retryAfter = response.headers.get('retry-after');
      throw rateLimited('OpenAQ rate limit exceeded (~60 req/min on the free tier).', {
        path,
        status,
        ...(retryAfter ? { retryAfter } : {}),
      });
    }
    // 5xx (incl. the plain-text 500 on unvalidated coordinates) and any other
    // non-OK status → transient ServiceUnavailable, retryable.
    throw serviceUnavailable(`OpenAQ returned HTTP ${status}.`, { path, status });
  }

  /** Wrap a single-attempt request in retry with rate-limit-calibrated backoff. */
  private get<T>(path: string, operation: string, ctx: Context): Promise<T> {
    return withRetry(() => this.request<T>(path, ctx), {
      operation,
      maxRetries: 2,
      baseDelayMs: 1000,
      signal: ctx.signal,
    });
  }

  /** `GET /v3/locations` — coordinates+radius / bbox / iso / parametersId. */
  async findLocations(
    params: FindLocationsParams,
    ctx: Context,
  ): Promise<OpenAqListResponse<OpenAqLocation>> {
    const qs = new URLSearchParams();
    if (params.coordinates) {
      qs.set('coordinates', params.coordinates);
      qs.set('radius', String(params.radius ?? 12_000));
    }
    if (params.bbox) qs.set('bbox', params.bbox);
    if (params.iso) qs.set('iso', params.iso);
    if (params.parametersId !== undefined) qs.set('parameters_id', String(params.parametersId));
    qs.set('limit', String(params.limit));
    if (params.page !== undefined) qs.set('page', String(params.page));
    const res = await this.get<OpenAqListResponse<OpenAqLocation>>(
      `/locations?${qs.toString()}`,
      'openaq.findLocations',
      ctx,
    );
    // OpenAQ /v3/locations is NOT distance-sorted. When searching by coordinates,
    // order results ascending by distance so results[0] is the true nearest — both
    // find_locations output and get_readings auto-resolution depend on this. bbox/iso
    // results carry distance: null (no center point), so leave their order untouched.
    if (params.coordinates) {
      res.results.sort(
        (a, b) =>
          (a.distance ?? Number.POSITIVE_INFINITY) - (b.distance ?? Number.POSITIVE_INFINITY),
      );
    }
    return res;
  }

  /** `GET /v3/locations/{id}` — the canonical sensor→parameter→unit map. */
  async getLocation(locationId: number, ctx: Context): Promise<OpenAqLocation> {
    const res = await this.get<OpenAqListResponse<OpenAqLocation>>(
      `/locations/${locationId}`,
      'openaq.getLocation',
      ctx,
    );
    const location = res.results[0];
    if (!location) throw notFound('OpenAQ location not found.', { locationId });
    return location;
  }

  /** `GET /v3/locations/{id}/latest` — values keyed by sensorsId, no parameter/unit inline. */
  async getLatest(locationId: number, ctx: Context): Promise<OpenAqLatest[]> {
    const res = await this.get<OpenAqListResponse<OpenAqLatest>>(
      `/locations/${locationId}/latest`,
      'openaq.getLatest',
      ctx,
    );
    return res.results;
  }

  /** `GET /v3/sensors/{id}/measurements[/hourly|/daily]` — one page of the series. */
  async getMeasurements(
    sensorId: number,
    params: MeasurementsParams,
    ctx: Context,
  ): Promise<MeasurementsPage> {
    const suffix =
      params.aggregation === 'hourly' ? '/hourly' : params.aggregation === 'daily' ? '/daily' : '';
    const qs = new URLSearchParams();
    if (params.datetimeFrom) qs.set('datetime_from', params.datetimeFrom);
    if (params.datetimeTo) qs.set('datetime_to', params.datetimeTo);
    qs.set('limit', String(params.limit));
    qs.set('page', String(params.page));
    const res = await this.get<OpenAqListResponse<OpenAqMeasurement>>(
      `/sensors/${sensorId}/measurements${suffix}?${qs.toString()}`,
      'openaq.getMeasurements',
      ctx,
    );
    return { results: res.results, found: parseFound(res.meta?.found) };
  }

  /** `GET /v3/parameters` — the full pollutant + unit catalog (~44 entries). */
  async listParameters(ctx: Context): Promise<OpenAqParameter[]> {
    const res = await this.get<OpenAqListResponse<OpenAqParameter>>(
      '/parameters?limit=1000',
      'openaq.listParameters',
      ctx,
    );
    return res.results;
  }

  /** `GET /v3/countries` — country coverage catalog (~153 entries). */
  async listCountries(ctx: Context): Promise<OpenAqCountry[]> {
    const res = await this.get<OpenAqListResponse<OpenAqCountry>>(
      '/countries?limit=1000',
      'openaq.listCountries',
      ctx,
    );
    return res.results;
  }
}

// --- Init/accessor pattern ---

let _service: OpenAqService | undefined;

/** Initialize the OpenAQ service. Called from `createApp()` `setup()`. */
export function initOpenAqService(config: AppConfig, storage: StorageService): void {
  _service = new OpenAqService(config, storage);
}

/** Accessor for the initialized OpenAQ service. */
export function getOpenAqService(): OpenAqService {
  if (!_service) {
    throw new Error('OpenAqService not initialized — call initOpenAqService() in setup()');
  }
  return _service;
}

/** Test-only: inject a service instance (e.g. a stubbed subclass). */
export function setOpenAqService(service: OpenAqService): void {
  _service = service;
}

export { extractValidationMessage, interpretFound, parseFound };
