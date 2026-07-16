// Deterministic aspect-ratio parsing and closest-match resolution for opaque
// registry enum tokens (e.g. "16:9", "512x512", "auto", "1:1 HD").
// Pure, browser-safe: no server imports, no I/O, no randomness.

/** A positive number, optionally decimal (e.g. "9", "16.01"). */
const NUMBER_PATTERN = /^\d+(?:\.\d+)?$/;

/**
 * Parse a registry enum token as a `W:H` or `WxH`/`W×H` ratio.
 * Returns `null` for anything else (`"auto"`, `"1:1 HD"`, non-positive parts, etc).
 */
export function parseRatioToken(token: string): { w: number; h: number; value: number } | null {
  const trimmed = token.trim();
  const match = /^(\d+(?:\.\d+)?)\s*[:x×]\s*(\d+(?:\.\d+)?)$/i.exec(trimmed);
  if (!match) return null;
  const wRaw = match[1];
  const hRaw = match[2];
  if (!wRaw || !hRaw || !NUMBER_PATTERN.test(wRaw) || !NUMBER_PATTERN.test(hRaw)) return null;
  const w = Number(wRaw);
  const h = Number(hRaw);
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return null;
  const value = w / h;
  if (!Number.isFinite(value)) return null;
  return { w, h, value };
}

export interface ClosestRatioResult {
  token: string | null;
  value: number | null;
  kind: 'exact' | 'closest' | 'none';
}

/** Pick the supported token whose ratio is numerically closest to `target`. */
export function resolveClosestRatio(
  supported: readonly string[],
  target: number
): ClosestRatioResult {
  if (!Number.isFinite(target) || target <= 0) return { token: null, value: null, kind: 'none' };
  let best: { token: string; value: number; diff: number } | null = null;
  for (const candidate of supported) {
    const parsed = parseRatioToken(candidate);
    if (!parsed) continue;
    const diff = Math.abs(parsed.value - target);
    if (!best || diff < best.diff - 1e-9) best = { token: candidate, value: parsed.value, diff };
  }
  if (!best) return { token: null, value: null, kind: 'none' };
  return { token: best.token, value: best.value, kind: best.diff <= 1e-6 ? 'exact' : 'closest' };
}

/** Derive a target aspect ratio from source media dimensions, or `null` if invalid. */
export function ratioFromDimensions(width: number, height: number): number | null {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
  return width / height;
}

/** Convenience wrapper: resolve the closest supported ratio for a source's dimensions. */
export function resolveClosestRatioForDimensions(
  supported: readonly string[],
  source: { width: number; height: number } | null | undefined
): ClosestRatioResult {
  if (!source) return { token: null, value: null, kind: 'none' };
  const target = ratioFromDimensions(source.width, source.height);
  if (target === null) return { token: null, value: null, kind: 'none' };
  return resolveClosestRatio(supported, target);
}

/** Filter a registry enum list down to the entries that parse as ratios. */
export function supportedRatioTokens(supported: readonly string[]): string[] {
  return supported.filter((token) => parseRatioToken(token) !== null);
}
