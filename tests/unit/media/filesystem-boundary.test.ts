import { describe, expect, test } from 'bun:test';
import { readExactPositioned } from '../../../src/lib/server/media/filesystem-boundary';

describe('filesystem boundary positioned reads', () => {
  test('fills a fixed prefix across short positive reads', async () => {
    const source = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const calls: Array<{ offset: number; length: number; position: number }> = [];
    const reader = {
      async read(buffer: Uint8Array, offset: number, length: number, position: number) {
        calls.push({ offset, length, position });
        const bytesRead = Math.min(3, length);
        buffer.set(source.subarray(position, position + bytesRead), offset);
        return { bytesRead };
      }
    };
    const header = new Uint8Array(source.byteLength);

    await readExactPositioned(reader, header, 0);

    expect(header).toEqual(source);
    expect(calls).toEqual([
      { offset: 0, length: 8, position: 0 },
      { offset: 3, length: 5, position: 3 },
      { offset: 6, length: 2, position: 6 }
    ]);
  });

  test('fails closed when a read makes no progress before the prefix is complete', async () => {
    const reader = {
      async read(buffer: Uint8Array, offset: number, length: number, position: number) {
        if (position > 0) return { bytesRead: 0 };
        buffer.set(new Uint8Array([0x89, 0x50]), offset);
        return { bytesRead: Math.min(2, length) };
      }
    };

    await expect(readExactPositioned(reader, new Uint8Array(8), 0)).rejects.toThrow('incomplete');
  });
});
