/**
 * @fileoverview openaq://parameters resource — the full pollutant + unit catalog,
 * the same data as openaq_list_parameters. Injectable context for clients that
 * support resources. The unit-disambiguation reference (the same pollutant appears
 * under several ids with different units).
 * @module mcp-server/resources/definitions/parameters.resource
 */

import { resource, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { withUpstream } from '@/mcp-server/tools/shared/upstream-errors.js';
import { getOpenAqService } from '@/services/openaq/openaq-service.js';

export const parametersResource = resource('openaq://parameters', {
  name: 'openaq-parameters',
  description:
    'Full catalog of measurable pollutants and their canonical units (id, code, display name, unit, description). Same data as openaq_list_parameters. The unit-disambiguation reference — the same pollutant appears under several ids with different units (CO is id 4 µg/m³, id 8 ppm, id 102 ppb).',
  mimeType: 'application/json',
  params: z.object({}),
  errors: [
    {
      reason: 'upstream_error',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'OpenAQ /parameters returned 5xx or an unreadable body on every retry.',
      recovery:
        'Retry after a short backoff; if it keeps failing, OpenAQ is degraded and the catalog is briefly unavailable.',
      retryable: true,
    },
    {
      reason: 'rate_limited',
      code: JsonRpcErrorCode.RateLimited,
      when: 'OpenAQ returned 429 — the request budget for this key is exhausted.',
      recovery:
        'Wait the retryAfter seconds given in data (about 60 if absent) before retrying; the free tier allows roughly 60 requests per minute.',
      retryable: true,
    },
    {
      reason: 'upstream_timeout',
      code: JsonRpcErrorCode.Timeout,
      when: 'OpenAQ /parameters did not respond within the request timeout on every retry.',
      recovery:
        'Retry once after a short pause; the parameter catalog is small, so a timeout points at OpenAQ being slow rather than the request.',
      retryable: true,
    },
    {
      reason: 'invalid_api_key',
      code: JsonRpcErrorCode.Unauthorized,
      when: 'OpenAQ returned 401 — the configured OPENAQ_API_KEY is missing, invalid, or revoked.',
      recovery:
        "Stop retrying — every OpenAQ read fails until the server's OPENAQ_API_KEY is replaced with a valid key from an OpenAQ Explorer account.",
      retryable: false,
    },
  ],
  async handler(_params, ctx) {
    const parameters = await withUpstream(ctx, () => getOpenAqService().listParameters(ctx));
    return {
      parameters: parameters.map((p) => ({
        id: p.id,
        name: p.name,
        displayName: p.displayName,
        unit: p.units,
        description: p.description,
      })),
    };
  },
  list: () => ({
    resources: [
      { uri: 'openaq://parameters', name: 'openaq-parameters', mimeType: 'application/json' },
    ],
  }),
});
