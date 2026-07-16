import { describe, expect, test } from 'bun:test';
import {
  parseRatioToken,
  ratioFromDimensions,
  resolveClosestRatio,
  resolveClosestRatioForDimensions,
  supportedRatioTokens
} from '../../../src/lib/features/registry/ratio-resolver';

describe('parseRatioToken', () => {
  test('parses colon ratios', () => {
    expect(parseRatioToken('16:9')?.value).toBeCloseTo(1.777, 2);
    expect(parseRatioToken('9:16')?.value).toBeCloseTo(0.5625, 4);
    expect(parseRatioToken('1:1')?.value).toBe(1);
    expect(parseRatioToken('9:16.01')?.value).toBeCloseTo(0.5622, 3);
  });
  test('parses dimension strings as ratios', () => {
    expect(parseRatioToken('512x512')?.value).toBe(1);
    expect(parseRatioToken('1024x768')?.value).toBeCloseTo(1.333, 3);
  });
  test('rejects non-ratio and invalid tokens', () => {
    expect(parseRatioToken('auto')).toBeNull();
    expect(parseRatioToken('1:1 HD')).toBeNull();
    expect(parseRatioToken('')).toBeNull();
    expect(parseRatioToken('16:0')).toBeNull();
    expect(parseRatioToken('-1:2')).toBeNull();
    expect(parseRatioToken('abc')).toBeNull();
  });
});

describe('resolveClosestRatio', () => {
  test('finds exact landscape match', () => {
    const result = resolveClosestRatio(['auto', '16:9', '9:16'], 16 / 9);
    expect(result).toEqual({ token: '16:9', value: 16 / 9, kind: 'exact' });
  });
  test('finds exact square match', () => {
    const result = resolveClosestRatio(['1:1', '16:9'], 1);
    expect(result.token).toBe('1:1');
    expect(result.kind).toBe('exact');
  });
  test('finds exact portrait match from 1080x1920 source', () => {
    const target = ratioFromDimensions(1080, 1920);
    expect(target).not.toBeNull();
    const result = resolveClosestRatio(['16:9', '9:16', '1:1'], target ?? 0);
    expect(result.token).toBe('9:16');
    expect(result.kind).toBe('exact');
  });
  test('resolves an awkward source ratio to the closest, non-exact token', () => {
    const parsed = parseRatioToken('9:16.01');
    expect(parsed).not.toBeNull();
    const result = resolveClosestRatio(['16:9', '9:16', '1:1'], parsed?.value ?? 0);
    expect(result.token).toBe('9:16');
    expect(result.kind).toBe('closest');
  });
  test('breaks ties deterministically by earliest index', () => {
    // "3:2" (1.5) and "1:2" (0.5) are equidistant from target 1.0 (both diff 0.5).
    const result = resolveClosestRatio(['3:2', '1:2'], 1.0);
    expect(result.token).toBe('3:2');
    expect(result.kind).toBe('closest');
  });
  test('returns none when supported has no parseable ratios', () => {
    expect(resolveClosestRatio([], 1)).toEqual({ token: null, value: null, kind: 'none' });
    expect(resolveClosestRatio(['auto'], 1)).toEqual({ token: null, value: null, kind: 'none' });
  });
  test('returns none for invalid targets', () => {
    expect(resolveClosestRatio(['16:9'], 0)).toEqual({ token: null, value: null, kind: 'none' });
    expect(resolveClosestRatio(['16:9'], NaN)).toEqual({ token: null, value: null, kind: 'none' });
  });
});

describe('ratioFromDimensions', () => {
  test('computes width over height', () => {
    expect(ratioFromDimensions(1920, 1080)).toBeCloseTo(1.777, 2);
  });
  test('rejects zero height', () => {
    expect(ratioFromDimensions(1920, 0)).toBeNull();
  });
  test('rejects negative dimensions', () => {
    expect(ratioFromDimensions(-100, 100)).toBeNull();
  });
  test('rejects non-finite dimensions', () => {
    expect(ratioFromDimensions(NaN, 100)).toBeNull();
  });
});

describe('resolveClosestRatioForDimensions', () => {
  test('resolves an exact match for 1920x1080', () => {
    const result = resolveClosestRatioForDimensions(['16:9', '9:16', '1:1'], {
      width: 1920,
      height: 1080
    });
    expect(result.token).toBe('16:9');
    expect(result.kind).toBe('exact');
  });
  test('returns none for a null/undefined source', () => {
    expect(resolveClosestRatioForDimensions(['16:9'], null)).toEqual({
      token: null,
      value: null,
      kind: 'none'
    });
    expect(resolveClosestRatioForDimensions(['16:9'], undefined)).toEqual({
      token: null,
      value: null,
      kind: 'none'
    });
  });
  test('returns none for degenerate source dimensions', () => {
    const result = resolveClosestRatioForDimensions(['16:9'], { width: 0, height: 10 });
    expect(result).toEqual({ token: null, value: null, kind: 'none' });
  });
});

describe('supportedRatioTokens', () => {
  test('filters out non-ratio enum members while preserving order', () => {
    expect(supportedRatioTokens(['auto', '16:9', '1:1 HD', '1:1', '512x512'])).toEqual([
      '16:9',
      '1:1',
      '512x512'
    ]);
  });
});
