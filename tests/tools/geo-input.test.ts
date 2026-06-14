/**
 * @fileoverview Tests for the shared geographic input schemas. Out-of-range
 * lat/lon must be rejected at the Zod edge — the live OpenAQ API returns a
 * plain-text HTTP 500 for bad coordinates (e.g. `999,999` or a `200,…` bbox),
 * which is retried before surfacing. These lock the boundary behavior so the
 * bad input never reaches the network.
 * @module tests/tools/geo-input.test
 */

import { describe, expect, it } from 'vitest';
import { bboxSchema, coordinatesSchema } from '@/mcp-server/tools/shared/geo-input.js';

const coords = coordinatesSchema('coordinates');
const bbox = bboxSchema('bbox');

describe('coordinatesSchema', () => {
  it('accepts valid "latitude,longitude" and the exact range boundaries', () => {
    expect(coords.parse('47.6062,-122.3321')).toBe('47.6062,-122.3321');
    expect(coords.parse('90,180')).toBe('90,180');
    expect(coords.parse('-90,-180')).toBe('-90,-180');
    expect(coords.parse('0,0')).toBe('0,0');
  });

  it('rejects out-of-range latitude/longitude before any network call', () => {
    // The live API would 500 on these — they must fail at the edge instead.
    expect(() => coords.parse('999,999')).toThrow(/out of range/i);
    expect(() => coords.parse('90.1,0')).toThrow(/out of range/i);
    expect(() => coords.parse('0,180.1')).toThrow(/out of range/i);
    expect(() => coords.parse('-91,0')).toThrow(/out of range/i);
  });

  it('rejects structurally malformed coordinates via the regex', () => {
    expect(() => coords.parse('47.6062')).toThrow();
    expect(() => coords.parse('a,b')).toThrow();
    expect(() => coords.parse('47.6,-122.3,5')).toThrow();
  });
});

describe('bboxSchema', () => {
  it('accepts a valid "minLon,minLat,maxLon,maxLat" box', () => {
    expect(bbox.parse('-122.45,47.5,-122.2,47.7')).toBe('-122.45,47.5,-122.2,47.7');
    expect(bbox.parse('-180,-90,180,90')).toBe('-180,-90,180,90');
  });

  it('rejects out-of-range corners before any network call', () => {
    // `200,100,-200,-100` returns a plain-text 500 from the live API.
    expect(() => bbox.parse('200,100,-200,-100')).toThrow(/out of range/i);
    expect(() => bbox.parse('-122.45,91,-122.2,47.7')).toThrow(/out of range/i);
    expect(() => bbox.parse('-181,47.5,-122.2,47.7')).toThrow(/out of range/i);
  });

  it('rejects structurally malformed boxes via the regex', () => {
    expect(() => bbox.parse('-122.45,47.5,-122.2')).toThrow();
    expect(() => bbox.parse('a,b,c,d')).toThrow();
  });
});
