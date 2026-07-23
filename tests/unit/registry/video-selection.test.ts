import { describe, expect, test } from 'bun:test';
import { normalizeRegistryRequest } from '../../../src/lib/features/registry/normalize-registry';
const WAN_IMAGE_TO_VIDEO_KEY = 'wan2.7-image-to-video:image-to-video';

describe('video registry selection', () => {
  test('rejects the stale WAN frame-to-video key', () => {
    expect(() =>
      normalizeRegistryRequest('wan2.7-image-to-video:frame-to-video', {
        imageUrls: ['https://assets.example/start.png'],
        duration: 2,
        resolution: '720p'
      })
    ).toThrow('Unknown or non-selectable video registry workflow.');
  });

  test('normalizes the current WAN image-to-video key', () => {
    expect(
      normalizeRegistryRequest(WAN_IMAGE_TO_VIDEO_KEY, {
        imageUrls: ['https://assets.example/start.png'],
        duration: 2,
        resolution: '720p'
      }).request
    ).toEqual({
      model: 'wan2.7-image-to-video',
      input: {
        image_urls: ['https://assets.example/start.png'],
        duration: 2,
        resolution: '720p',
        enable_safety_checker: false,
        multi_shots: false
      }
    });
  });

  test('preserves an unrelated current frame-to-video workflow', () => {
    expect(
      normalizeRegistryRequest('kling-2.6:frame-to-video', {
        prompt: 'studio video',
        duration: 5,
        aspectRatio: '1:1',
        imageUrls: ['https://assets.example/start-frame.png'],
        endImageUrl: 'https://assets.example/end-frame.png'
      }).request
    ).toEqual({
      model: 'kling-2.6',
      input: {
        sound: false,
        prompt: 'studio video',
        duration: 5,
        aspect_ratio: '1:1',
        image_urls: ['https://assets.example/start-frame.png'],
        end_image_url: 'https://assets.example/end-frame.png'
      }
    });
  });
});
