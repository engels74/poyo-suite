export interface PixelDimensions {
  width: number;
  height: number;
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

export function readImageDimensions(bytes: Uint8Array): PixelDimensions | null {
  try {
    return readPng(bytes) ?? readGif(bytes) ?? readJpeg(bytes) ?? readWebp(bytes);
  } catch {
    return null;
  }
}

export function aspectRatioLabel(width: number, height: number): string | null {
  // Require positive integers: gcd() reduces via `a % b` until `b === 0`, which only terminates for
  // integers — a fractional input could recurse without ever hitting zero. Number.isInteger also
  // rejects NaN/Infinity, so it subsumes the previous finiteness guard.
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0)
    return null;
  const divisor = gcd(width, height);
  return `${width / divisor}:${height / divisor}`;
}

function gcd(a: number, b: number): number {
  return b === 0 ? a : gcd(b, a % b);
}

function viewOf(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function matchesAscii(bytes: Uint8Array, offset: number, text: string): boolean {
  for (let i = 0; i < text.length; i += 1) {
    if (bytes[offset + i] !== text.charCodeAt(i)) return false;
  }
  return true;
}

function readPng(bytes: Uint8Array): PixelDimensions | null {
  if (bytes.length < PNG_SIGNATURE.length) return null;
  for (let i = 0; i < PNG_SIGNATURE.length; i += 1) {
    if (bytes[i] !== PNG_SIGNATURE[i]) return null;
  }
  const view = viewOf(bytes);
  return { width: view.getUint32(16, false), height: view.getUint32(20, false) };
}

function readGif(bytes: Uint8Array): PixelDimensions | null {
  if (!matchesAscii(bytes, 0, 'GIF87a') && !matchesAscii(bytes, 0, 'GIF89a')) return null;
  const view = viewOf(bytes);
  return { width: view.getUint16(6, true), height: view.getUint16(8, true) };
}

function isSofMarker(code: number): boolean {
  return (
    (code >= 0xc0 && code <= 0xc3) ||
    (code >= 0xc5 && code <= 0xc7) ||
    (code >= 0xc9 && code <= 0xcb) ||
    (code >= 0xcd && code <= 0xcf)
  );
}

function isStandaloneMarker(code: number): boolean {
  return code === 0xd8 || code === 0xd9 || code === 0x01 || (code >= 0xd0 && code <= 0xd7);
}

function readJpeg(bytes: Uint8Array): PixelDimensions | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  const view = viewOf(bytes);
  let offset = 2;
  while (offset + 1 < bytes.length) {
    if (bytes[offset] !== 0xff) return null;
    let markerOffset = offset;
    while (bytes[markerOffset + 1] === 0xff) markerOffset += 1;
    const code = view.getUint8(markerOffset + 1);
    if (isStandaloneMarker(code)) {
      offset = markerOffset + 2;
      continue;
    }
    if (isSofMarker(code)) {
      return {
        height: view.getUint16(markerOffset + 5, false),
        width: view.getUint16(markerOffset + 7, false)
      };
    }
    const segmentLength = view.getUint16(markerOffset + 2, false);
    if (segmentLength < 2) return null;
    offset = markerOffset + 2 + segmentLength;
  }
  return null;
}

function read24LE(view: DataView, offset: number): number {
  return (
    view.getUint8(offset) | (view.getUint8(offset + 1) << 8) | (view.getUint8(offset + 2) << 16)
  );
}

function readWebp(bytes: Uint8Array): PixelDimensions | null {
  if (!matchesAscii(bytes, 0, 'RIFF') || !matchesAscii(bytes, 8, 'WEBP')) return null;
  const view = viewOf(bytes);
  if (matchesAscii(bytes, 12, 'VP8 ')) {
    return {
      width: view.getUint16(26, true) & 0x3fff,
      height: view.getUint16(28, true) & 0x3fff
    };
  }
  if (matchesAscii(bytes, 12, 'VP8L')) {
    const bits = view.getUint32(21, true);
    return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
  }
  if (matchesAscii(bytes, 12, 'VP8X')) {
    return { width: 1 + read24LE(view, 24), height: 1 + read24LE(view, 27) };
  }
  return null;
}
