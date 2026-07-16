import { describe, expect, test } from 'bun:test';
import {
  aspectRatioLabel,
  readImageDimensions
} from '../../../src/lib/server/media/image-dimensions';

function bytesOf(length: number): { bytes: Uint8Array; view: DataView } {
  const buffer = new ArrayBuffer(length);
  return { bytes: new Uint8Array(buffer), view: new DataView(buffer) };
}

function asciiInto(bytes: Uint8Array, offset: number, text: string): void {
  for (let i = 0; i < text.length; i += 1) bytes[offset + i] = text.charCodeAt(i);
}

function buildPng(width: number, height: number): Uint8Array {
  const { bytes, view } = bytesOf(24);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  asciiInto(bytes, 12, 'IHDR');
  view.setUint32(16, width, false);
  view.setUint32(20, height, false);
  return bytes;
}

function buildGif(signature: 'GIF87a' | 'GIF89a', width: number, height: number): Uint8Array {
  const { bytes, view } = bytesOf(10);
  asciiInto(bytes, 0, signature);
  view.setUint16(6, width, true);
  view.setUint16(8, height, true);
  return bytes;
}

function buildJpeg(width: number, height: number): Uint8Array {
  const { bytes, view } = bytesOf(29);
  bytes.set([0xff, 0xd8], 0); // SOI
  bytes.set([0xff, 0xe0], 2); // APP0 marker
  view.setUint16(4, 16, false); // segment length (self-inclusive) -> 14 bytes of payload follow
  asciiInto(bytes, 6, 'JFIF\0');
  bytes.set([0xff, 0xc0], 20); // SOF0 marker, reached only by skipping APP0 via its length
  view.setUint16(22, 11, false); // segment length, unchecked by the SOF branch
  bytes[24] = 0x08; // sample precision
  view.setUint16(25, height, false);
  view.setUint16(27, width, false);
  return bytes;
}

function buildWebpVp8(width: number, height: number): Uint8Array {
  const { bytes, view } = bytesOf(30);
  asciiInto(bytes, 0, 'RIFF');
  asciiInto(bytes, 8, 'WEBP');
  asciiInto(bytes, 12, 'VP8 ');
  view.setUint16(26, width & 0x3fff, true);
  view.setUint16(28, height & 0x3fff, true);
  return bytes;
}

function buildWebpVp8l(width: number, height: number): Uint8Array {
  const { bytes, view } = bytesOf(25);
  asciiInto(bytes, 0, 'RIFF');
  asciiInto(bytes, 8, 'WEBP');
  asciiInto(bytes, 12, 'VP8L');
  const bits = (((height - 1) & 0x3fff) << 14) | ((width - 1) & 0x3fff);
  view.setUint32(21, bits, true);
  return bytes;
}

function buildWebpVp8x(width: number, height: number): Uint8Array {
  const { bytes } = bytesOf(30);
  asciiInto(bytes, 0, 'RIFF');
  asciiInto(bytes, 8, 'WEBP');
  asciiInto(bytes, 12, 'VP8X');
  const w = width - 1;
  const h = height - 1;
  bytes[24] = w & 0xff;
  bytes[25] = (w >> 8) & 0xff;
  bytes[26] = (w >> 16) & 0xff;
  bytes[27] = h & 0xff;
  bytes[28] = (h >> 8) & 0xff;
  bytes[29] = (h >> 16) & 0xff;
  return bytes;
}

describe('readImageDimensions', () => {
  test('parses a PNG IHDR chunk', () => {
    expect(readImageDimensions(buildPng(640, 480))).toEqual({ width: 640, height: 480 });
  });

  test('parses GIF87a and GIF89a logical screen descriptors', () => {
    expect(readImageDimensions(buildGif('GIF87a', 320, 240))).toEqual({
      width: 320,
      height: 240
    });
    expect(readImageDimensions(buildGif('GIF89a', 320, 240))).toEqual({
      width: 320,
      height: 240
    });
  });

  test('parses a JPEG SOF0 marker after skipping an APP0 segment', () => {
    expect(readImageDimensions(buildJpeg(800, 600))).toEqual({ width: 800, height: 600 });
  });

  test('parses WebP VP8 (lossy), VP8L (lossless), and VP8X (extended) chunks', () => {
    expect(readImageDimensions(buildWebpVp8(400, 300))).toEqual({ width: 400, height: 300 });
    expect(readImageDimensions(buildWebpVp8l(200, 150))).toEqual({ width: 200, height: 150 });
    expect(readImageDimensions(buildWebpVp8x(1024, 768))).toEqual({ width: 1024, height: 768 });
  });

  test('returns null for truncated, empty, or unrecognized input', () => {
    expect(readImageDimensions(buildPng(640, 480).slice(0, 10))).toBeNull();
    expect(readImageDimensions(new Uint8Array(0))).toBeNull();
    expect(readImageDimensions(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]))).toBeNull();
  });
});

describe('aspectRatioLabel', () => {
  test('reduces width/height by their gcd', () => {
    expect(aspectRatioLabel(1920, 1080)).toBe('16:9');
    expect(aspectRatioLabel(1080, 1920)).toBe('9:16');
    expect(aspectRatioLabel(512, 512)).toBe('1:1');
  });

  test('returns null for non-positive dimensions', () => {
    expect(aspectRatioLabel(0, 10)).toBeNull();
  });

  test('returns null for non-integer or non-finite dimensions', () => {
    // Guards gcd() termination: fractional inputs could recurse without ever reaching b === 0.
    expect(aspectRatioLabel(100.5, 50)).toBeNull();
    expect(aspectRatioLabel(16, 9.5)).toBeNull();
    expect(aspectRatioLabel(Number.NaN, 10)).toBeNull();
    expect(aspectRatioLabel(Number.POSITIVE_INFINITY, 10)).toBeNull();
  });
});
