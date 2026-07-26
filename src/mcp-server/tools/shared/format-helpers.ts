/**
 * @fileoverview Display-only formatting shared by the measurement formatters.
 * `structuredContent` always carries the exact upstream number; these helpers
 * shape the human-facing `content[]` twin so IEEE-754 artifacts
 * (`0.019899999999999998`) don't reach a reader who is scanning the markdown.
 * @module mcp-server/tools/shared/format-helpers
 */

/** Decimal places kept for values at or above 1. */
const FIXED_DECIMALS = 4;
/** Significant digits kept for values below 1, so sub-ppm readings survive rounding. */
const SUB_UNIT_PRECISION = 4;

/**
 * Render a measurement number for `content[]` text. Rounds away floating-point
 * noise without converting units or altering sign — a negative reading is valid
 * sensor output and is preserved. Values below 1 round to significant digits
 * rather than decimal places so a 0.0026 ppm reading does not collapse to 0.
 *
 * Display only: never apply this to `structuredContent` or to canvas rows.
 *
 * @param value - The exact number, or null/undefined when the bucket has no data.
 * @param fallback - Text rendered in place of an absent number.
 */
export function displayNumber(value: number | null | undefined, fallback = 'n/a'): string {
  if (value == null || !Number.isFinite(value)) return fallback;
  const rounded =
    Math.abs(value) < 1
      ? Number(value.toPrecision(SUB_UNIT_PRECISION))
      : Number(value.toFixed(FIXED_DECIMALS));
  return String(rounded);
}
