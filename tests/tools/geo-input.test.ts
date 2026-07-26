/**
 * @fileoverview Tests for the shared geographic input schemas. Out-of-range
 * lat/lon must be rejected at the Zod edge — the live OpenAQ API returns a
 * plain-text HTTP 500 for bad coordinates (e.g. `999,999` or a `200,…` bbox),
 * which is retried before surfacing. These lock the boundary behavior so the
 * bad input never reaches the network.
 * @module tests/tools/geo-input.test
 */

import { z } from '@cyanheads/mcp-ts-core';
import { describe, expect, it } from 'vitest';
import { bboxSchema, coordinatesSchema } from '@/mcp-server/tools/shared/geo-input.js';

const coords = coordinatesSchema('coordinates');
const bbox = bboxSchema('bbox');

/**
 * Zod stringifies its issue list as JSON, so the per-issue messages arrive with
 * their quotes backslash-escaped. Unescape before asserting on message text.
 */
function rejectionMessage(parse: () => unknown): string {
  try {
    parse();
  } catch (err) {
    return (err as Error).message.replace(/\\"/g, '"');
  }
  throw new Error('expected the schema to reject this value');
}

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

  it('accepts whitespace around the comma and normalizes it away (#17)', () => {
    // The natural way to write a pair — a space after the comma — used to fail
    // the regex outright. Whitespace is stripped before the pattern runs, so the
    // parsed value is always the canonical space-free form the API takes.
    expect(coords.parse('47.6062, -122.3321')).toBe('47.6062,-122.3321');
    expect(coords.parse('  47.6062 ,  -122.3321  ')).toBe('47.6062,-122.3321');
    expect(coords.parse('47.6062\t,\n-122.3321')).toBe('47.6062,-122.3321');
  });

  it('range bounds still apply to a spaced pair, and are the only complaint (#17)', () => {
    // After stripping, the value is structurally valid, so the range refine is the
    // sole issue. A format issue alongside it would mean the space broke the
    // pattern check instead of being normalized away.
    const result = coords.safeParse('999, 999');
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((i) => i.code)).toEqual(['custom']);
    expect(result.error?.issues[0]?.message).toMatch(/out of range/i);
  });

  it('names the expected format when the value is still malformed after stripping (#17)', () => {
    // Previously a raw regex dump that never stated the format in words. The
    // format complaint is also the only one: the pattern check aborts, so a
    // non-numeric value doesn't collect a bogus "out of range" issue as well.
    for (const malformed of ['not a coordinate', '47.6062']) {
      const result = coords.safeParse(malformed);
      expect(result.success).toBe(false);
      expect(result.error?.issues.map((i) => i.code)).toEqual(['invalid_format']);
      expect(rejectionMessage(() => coords.parse(malformed))).toContain(
        'Expected "latitude,longitude" in decimal degrees (e.g. "47.6062,-122.3321").',
      );
    }
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

  it('accepts whitespace between corners and normalizes it away (#17)', () => {
    expect(bbox.parse('-122.5, 47.4, -122.1, 47.8')).toBe('-122.5,47.4,-122.1,47.8');
    expect(bbox.parse(' -122.5 , 47.4 , -122.1 , 47.8 ')).toBe('-122.5,47.4,-122.1,47.8');
  });

  it('range bounds still apply to a spaced box, and are the only complaint (#17)', () => {
    const result = bbox.safeParse('200, 100, -200, -100');
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((i) => i.code)).toEqual(['custom']);
    expect(result.error?.issues[0]?.message).toMatch(/out of range/i);
  });

  it('names the expected format when the box is still malformed after stripping (#17)', () => {
    const result = bbox.safeParse('a, b, c, d');
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((i) => i.code)).toEqual(['invalid_format']);
    expect(rejectionMessage(() => bbox.parse('a, b, c, d'))).toContain(
      'Expected "minLon,minLat,maxLon,maxLat" in decimal degrees (e.g. "-122.5,47.4,-122.1,47.8").',
    );
  });
});

describe('advertised JSON Schema', () => {
  // The whitespace tolerance is a server-side normalization, not a wider contract:
  // clients still plan against the canonical space-free pattern. A preprocess step
  // contributes nothing to the emitted schema — lock that so a future refactor
  // can't silently drop `type`/`pattern` from what tools/list advertises.
  it('still emits type + pattern for both builders (#17)', () => {
    const emitted = z.toJSONSchema(
      z.object({ coordinates: coords.optional(), bbox: bbox.optional() }),
      { io: 'input' },
    ) as { properties: Record<string, { description: string; pattern: string; type: string }> };

    expect(emitted.properties.coordinates).toMatchObject({
      type: 'string',
      pattern: '^-?\\d{1,3}(\\.\\d+)?,-?\\d{1,3}(\\.\\d+)?$',
      description: 'coordinates',
    });
    expect(emitted.properties.bbox).toMatchObject({
      type: 'string',
      pattern: '^(-?\\d+(\\.\\d+)?,){3}-?\\d+(\\.\\d+)?$',
      description: 'bbox',
    });
  });
});
