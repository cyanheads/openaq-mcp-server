/**
 * @fileoverview Server-specific environment configuration for openaq-mcp-server.
 * Lazy-parsed and kept separate from the framework's core config. Maps the
 * OpenAQ v3 API key and optional base-URL override to a validated Zod schema.
 * @module config/server-config
 */

import { z } from '@cyanheads/mcp-ts-core';
import { parseEnvConfig } from '@cyanheads/mcp-ts-core/config';

/**
 * OpenAQ v3 access config. `apiKey` is required — OpenAQ v3 rejects every
 * request without an `X-API-Key` header; a missing key surfaces as a clean
 * `ConfigurationError` startup banner naming `OPENAQ_API_KEY`.
 */
const ServerConfigSchema = z.object({
  apiKey: z.string().min(1).describe('OpenAQ v3 API key, sent as the X-API-Key header.'),
  baseUrl: z
    .string()
    .url()
    .default('https://api.openaq.org/v3')
    .describe('OpenAQ v3 API base URL. Override for a proxy or test mirror.'),
});

export type ServerConfig = z.infer<typeof ServerConfigSchema>;

let _config: ServerConfig | undefined;

/** Lazily parse and cache the server config from the environment. */
export function getServerConfig(): ServerConfig {
  _config ??= parseEnvConfig(ServerConfigSchema, {
    apiKey: 'OPENAQ_API_KEY',
    baseUrl: 'OPENAQ_API_BASE_URL',
  });
  return _config;
}

/** Test-only: clear the memoized config so a fresh environment re-parses. */
export function resetServerConfig(): void {
  _config = undefined;
}
