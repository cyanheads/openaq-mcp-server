/**
 * @fileoverview Test helper that builds a stubbed OpenAqService (bypassing the
 * real constructor + env config) and installs it via setOpenAqService. Each
 * method defaults to throwing "not stubbed" so a test that hits an unexpected
 * call fails loudly instead of returning undefined.
 * @module tests/fixtures/stub-service
 */

import { OpenAqService, setOpenAqService } from '@/services/openaq/openaq-service.js';

type ServiceMethods = Pick<
  OpenAqService,
  | 'findLocations'
  | 'getLocation'
  | 'getLatest'
  | 'getMeasurements'
  | 'listParameters'
  | 'listCountries'
>;

/** Build and install a stub OpenAqService. Pass only the methods a test needs. */
export function installStubService(overrides: Partial<ServiceMethods>): OpenAqService {
  const stub = Object.create(OpenAqService.prototype) as OpenAqService;
  const notStubbed = (name: string) => () => {
    throw new Error(`stub: ${name} not provided to installStubService`);
  };
  const methods: (keyof ServiceMethods)[] = [
    'findLocations',
    'getLocation',
    'getLatest',
    'getMeasurements',
    'listParameters',
    'listCountries',
  ];
  for (const m of methods) {
    Object.assign(stub, { [m]: overrides[m] ?? notStubbed(m) });
  }
  setOpenAqService(stub);
  return stub;
}
