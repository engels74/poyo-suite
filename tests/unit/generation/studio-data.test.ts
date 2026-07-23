import { describe, expect, mock, test } from 'bun:test';
import { VIDEO_CURRENT_ENTRIES } from '../../../src/lib/features/registry/video-registry';

mock.module('../../../src/lib/server/platform/runtime', () => ({
  getPlatformServices: () => {
    throw new Error('getPlatformServices must not run while testing storedJobEntry');
  }
}));

const { storedJobEntry } = await import('../../../src/lib/server/generation/studio-data');

describe('stored studio job entry matching', () => {
  test('does not translate a stale Wan image-to-video frame workflow into a transient preset', () => {
    expect(
      storedJobEntry(
        VIDEO_CURRENT_ENTRIES,
        'wan2.7-image-to-video:frame-to-video',
        'frame-to-video'
      )
    ).toBeNull();
  });

  test('keeps a current Wan image-to-video stored job unchanged', () => {
    const entry = storedJobEntry(
      VIDEO_CURRENT_ENTRIES,
      'wan2.7-image-to-video:image-to-video',
      'image-to-video'
    );

    expect(entry).toMatchObject({
      key: 'wan2.7-image-to-video:image-to-video',
      workflow: 'image-to-video'
    });
  });

  test('keeps an unrelated current frame-to-video stored job unchanged', () => {
    const entry = storedJobEntry(
      VIDEO_CURRENT_ENTRIES,
      'kling-2.6:frame-to-video',
      'frame-to-video'
    );

    expect(entry).toMatchObject({
      key: 'kling-2.6:frame-to-video',
      workflow: 'frame-to-video'
    });
  });
});
