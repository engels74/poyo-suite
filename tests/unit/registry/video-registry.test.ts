import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { modelCatalogue, videoCatalogue } from '../../../src/lib/features/registry/catalogue';
import { normalizeRegistryRequest } from '../../../src/lib/features/registry/normalize-registry';
import {
  minimumValidVideoRequest,
  normalizeVideoRequest
} from '../../../src/lib/features/registry/normalize-video';
import type {
  GuidedVideoRequest,
  VideoRegistryEntry
} from '../../../src/lib/features/registry/types';
import {
  VIDEO_AUDIT_RECORDS,
  VIDEO_CURRENT_ENTRIES,
  VIDEO_EXCLUDED_ENTRIES,
  VIDEO_PAGE_SLUGS,
  VIDEO_PUBLIC_IDS,
  VIDEO_REGISTRY_ENTRIES
} from '../../../src/lib/features/registry/video-registry';
import { migrateDatabase } from '../../../src/lib/server/platform/database';
import { seedImageRegistry, seedVideoRegistry } from '../../../src/lib/server/registry/repository';

function videoEntry(key: string): VideoRegistryEntry {
  const entry = VIDEO_REGISTRY_ENTRIES.find((candidate) => candidate.key === key);
  if (!entry) throw new Error(`Missing video registry fixture: ${key}`);
  return entry;
}

function minimum(key: string): GuidedVideoRequest {
  return minimumValidVideoRequest(videoEntry(key));
}

describe('audited video registry coverage', () => {
  test('REG-01/02 accounts for 35 pages, 53 IDs, 121 current workflows and explicit exclusions', () => {
    expect(VIDEO_PAGE_SLUGS).toHaveLength(35);
    expect(new Set(VIDEO_PAGE_SLUGS).size).toBe(35);
    expect(VIDEO_PUBLIC_IDS).toHaveLength(53);
    expect(VIDEO_CURRENT_ENTRIES).toHaveLength(121);
    expect(VIDEO_EXCLUDED_ENTRIES).toHaveLength(2);
    expect(VIDEO_EXCLUDED_ENTRIES.every((entry) => entry.status === 'excluded-initial-scope')).toBe(
      true
    );
    expect(VIDEO_EXCLUDED_ENTRIES.map((entry) => entry.publicModelId).sort()).toEqual([
      'kling-avatar-2.0/pro',
      'kling-avatar-2.0/standard'
    ]);
    expect(VIDEO_AUDIT_RECORDS).toHaveLength(8);
    expect(VIDEO_AUDIT_RECORDS.filter((record) => record.status === 'legacy')).toHaveLength(2);
    expect(VIDEO_AUDIT_RECORDS.filter((record) => record.status === 'unindexed')).toHaveLength(6);
  });

  test('REG-03 normalizes a minimum exact request for every current video workflow', () => {
    for (const entry of VIDEO_CURRENT_ENTRIES) {
      const preview = normalizeVideoRequest(entry.key, minimumValidVideoRequest(entry));
      expect(preview.request.model).toBe(entry.publicModelId);
      expect(entry.ui.form).toBe('guided-video');
      expect(entry.payload.adapter).toBe('video-input-v1');
      expect(entry.response.normalizer).toBe('poyo-task-video-v1');
      expect(entry.provenance.markdownSha256).toHaveLength(64);
      expect(entry.provenance.jsonSha256).toHaveLength(64);
      expect(entry.provenance.jsonStatus).toBe('available');
      expect(entry.provenance.sourceManifestVersion).toMatch(/^1:[a-f0-9]{64}$/);
    }
  });

  test('REG-02 excludes avatar and legacy records from selectors and payload adapters', () => {
    expect(videoCatalogue('avatar')).toEqual([]);
    expect(videoCatalogue().every((entry) => entry.status === 'current')).toBe(true);
    expect(() => normalizeVideoRequest('kling-avatar-2.0/standard:avatar-video', {})).toThrow(
      'non-selectable'
    );
    expect(modelCatalogue('sora-2-beta')).toEqual([]);
  });

  test('REG-01 persists current, excluded and audit snapshots idempotently', () => {
    const database = new Database(':memory:', { strict: true });
    migrateDatabase(database);
    seedImageRegistry(database);
    seedVideoRegistry(database);
    seedVideoRegistry(database);
    expect(
      database.query<{ count: number }, []>('SELECT COUNT(*) count FROM registry_versions').get()
        ?.count
    ).toBe(2);
    expect(
      database
        .query<{ count: number }, []>(
          "SELECT COUNT(*) count FROM registry_entries WHERE modality='video'"
        )
        .get()?.count
    ).toBe(131);
    expect(
      database
        .query<{ count: number }, []>(
          "SELECT COUNT(*) count FROM registry_entries WHERE status='excluded-initial-scope'"
        )
        .get()?.count
    ).toBe(2);
    expect(
      database.query<{ count: number }, []>('SELECT COUNT(*) count FROM registry_entries').get()
        ?.count
    ).toBe(183);
    database.close();
  });
});

describe('reviewed video conditional adapters', () => {
  test('REG-04B rejects malformed scalar, structured and media role runtime kinds', () => {
    const textKey = 'happy-horse:text-to-video';
    const textValues = minimum(textKey);
    for (const [values, message] of [
      [{ ...textValues, prompt: { injected: true } }, 'prompt must be a string'],
      [{ ...textValues, prompt: null }, 'prompt must be a string'],
      [{ ...textValues, duration: '5' }, 'duration must be an integer'],
      [{ ...textValues, duration: Number.NaN }, 'duration must be finite'],
      [{ ...textValues, enableSafetyChecker: 'false' }, 'enableSafetyChecker must be boolean'],
      [{ ...textValues, unknownField: true }, 'unknownField is not supported']
    ] as const) {
      expect(() => normalizeVideoRequest(textKey, values as unknown as GuidedVideoRequest)).toThrow(
        message
      );
    }

    const imageKey = 'happy-horse:image-to-video';
    expect(() =>
      normalizeVideoRequest(imageKey, {
        ...minimum(imageKey),
        imageUrls: 'https://assets.example/source.png'
      } as unknown as GuidedVideoRequest)
    ).toThrow('imageUrls must be a list of strings');
    const frameKey = 'kling-2.6:frame-to-video';
    expect(() =>
      normalizeVideoRequest(frameKey, {
        ...minimum(frameKey),
        endImageUrl: ['https://assets.example/end.png']
      } as unknown as GuidedVideoRequest)
    ).toThrow('endImageUrl must be a string');
    const shotsKey = 'kling-3.0/pro:multi-shot-video';
    expect(() =>
      normalizeVideoRequest(shotsKey, {
        ...minimum(shotsKey),
        multiPrompt: [null]
      } as unknown as GuidedVideoRequest)
    ).toThrow('multiPrompt must contain objects');
  });

  test('REG-07 emits safety false only for Happy Horse and Wan 2.7 Video families', () => {
    const safetyIds = new Set([
      'happy-horse-1.1',
      'happy-horse',
      'wan2.7-text-to-video',
      'wan2.7-image-to-video',
      'wan2.7-reference-to-video',
      'wan2.7-edit-video'
    ]);
    for (const entry of VIDEO_CURRENT_ENTRIES) {
      const values = minimumValidVideoRequest(entry);
      const input = normalizeVideoRequest(entry.key, values).request.input;
      if (safetyIds.has(entry.publicModelId)) {
        expect(input.enable_safety_checker).toBe(false);
        expect(
          normalizeVideoRequest(entry.key, { ...values, enableSafetyChecker: true }).request.input
            .enable_safety_checker
        ).toBe(true);
      } else expect(input).not.toHaveProperty('enable_safety_checker');
    }
  });

  test('REG-05 Kling 1.6 separates start/end/elements and cfg surfaces', () => {
    const proFrame = 'kling-1.6/pro:frame-to-video';
    expect(normalizeVideoRequest(proFrame, minimum(proFrame)).request.input).toMatchObject({
      start_image_url: expect.any(String),
      end_image_url: expect.any(String)
    });
    const standardReference = 'kling-1.6/standard:reference-to-video';
    expect(() =>
      normalizeVideoRequest(standardReference, { ...minimum(standardReference), cfgScale: 0.5 })
    ).toThrow('cfgScale is not supported');
    expect(
      VIDEO_REGISTRY_ENTRIES.some((entry) => entry.key === 'kling-1.6/standard:frame-to-video')
    ).toBe(false);
  });

  test('REG-05 Kling 2.6 fixes end-frame sound off without affecting other workflows', () => {
    const frame = 'kling-2.6:frame-to-video';
    expect(normalizeVideoRequest(frame, minimum(frame)).request.input.sound).toBe(false);
    expect(() => normalizeVideoRequest(frame, { ...minimum(frame), sound: true })).toThrow(
      'sound is not supported'
    );
    const text = 'kling-2.6:text-to-video';
    expect(normalizeVideoRequest(text, minimum(text)).request.input.sound).toBe(true);
  });

  test('REG-05 Kling 3/O3 multi-shot uses multi_prompt, matching duration, and sound', () => {
    for (const key of ['kling-3.0/pro:multi-shot-video', 'kling-o3/standard:multi-shot-video']) {
      const values = minimum(key);
      const input = normalizeVideoRequest(key, values).request.input;
      expect(input).toMatchObject({ multi_shots: true, sound: true });
      expect(input.multi_prompt).toBeArray();
      expect(input).not.toHaveProperty('prompt');
      expect(() => normalizeVideoRequest(key, { ...values, sound: false })).toThrow('sound=true');
      expect(() => normalizeVideoRequest(key, { ...values, prompt: 'conflict' })).toThrow(
        'prompt is not supported'
      );
      expect(() =>
        normalizeVideoRequest(key, {
          ...values,
          duration: 5,
          multiPrompt: [{ prompt: 'shot', duration: 4 }]
        })
      ).toThrow('must equal');
    }
  });

  test('REG-05 motion control validates roles, duration/orientation, and facial elements', () => {
    const motion26 = 'kling-2.6-motion-control:motion-control';
    expect(normalizeVideoRequest(motion26, minimum(motion26)).request.input).toMatchObject({
      image_urls: [expect.any(String)],
      video_urls: [expect.any(String)],
      character_orientation: 'image'
    });
    expect(() =>
      normalizeVideoRequest(motion26, {
        ...minimum(motion26),
        characterOrientation: 'image',
        referenceVideoDuration: 11
      })
    ).toThrow('through 10 seconds');
    const motion3 = 'kling-3.0-motion-control:motion-control';
    expect(() =>
      normalizeVideoRequest(motion3, {
        ...minimum(motion3),
        characterOrientation: 'image',
        elements: [{ name: 'face' }]
      })
    ).toThrow('video orientation');
  });

  test('REG-05 Happy Horse modes are mutually exclusive and edit omits duration', () => {
    const text = 'happy-horse:text-to-video';
    expect(() =>
      normalizeVideoRequest(text, {
        ...minimum(text),
        imageUrls: ['https://assets.example/image.png']
      })
    ).toThrow('imageUrls is not supported');
    const image = 'happy-horse:image-to-video';
    expect(() =>
      normalizeVideoRequest(image, {
        ...minimum(image),
        referenceImageUrls: ['https://assets.example/reference.png']
      })
    ).toThrow('referenceImageUrls is not supported');
    const edit = 'happy-horse:video-edit';
    const input = normalizeVideoRequest(edit, minimum(edit)).request.input;
    expect(input).not.toHaveProperty('duration');
    expect(input.audio_setting).toBe('auto');
  });

  test('REG-05 Hailuo enforces end-frame and 1080p duration matrices', () => {
    const frame = 'hailuo-02:frame-to-video';
    expect(() => normalizeVideoRequest(frame, { ...minimum(frame), resolution: '512P' })).toThrow(
      'requires 768P'
    );
    const hailuo23 = 'hailuo-2.3:text-to-video';
    expect(() =>
      normalizeVideoRequest(hailuo23, {
        ...minimum(hailuo23),
        resolution: '1080p',
        duration: 10
      })
    ).toThrow('6 seconds only');
  });

  test('REG-05 Seedance separates frames and references and validates audio dependencies/totals', () => {
    const reference = 'seedance-2:reference-to-video';
    expect(() =>
      normalizeVideoRequest(reference, {
        ...minimum(reference),
        referenceImageUrls: [],
        referenceAudioUrls: ['https://assets.example/audio.mp3']
      })
    ).toThrow('requires an image or video reference');
    expect(() =>
      normalizeVideoRequest(reference, {
        ...minimum(reference),
        referenceImageUrls: Array.from(
          { length: 9 },
          (_, index) => `https://assets.example/i-${index}.png`
        ),
        referenceVideoUrls: Array.from(
          { length: 3 },
          (_, index) => `https://assets.example/v-${index}.mp4`
        ),
        referenceAudioUrls: ['https://assets.example/audio.mp3']
      })
    ).toThrow('12 total');
    const frame = 'seedance-2:frame-to-video';
    expect(() =>
      normalizeVideoRequest(frame, {
        ...minimum(frame),
        referenceVideoUrls: ['https://assets.example/reference.mp4']
      })
    ).toThrow('referenceVideoUrls is not supported');
  });

  test('REG-05 VEO derives generation_type and enforces model/duration restrictions', () => {
    const reference = 'veo3.1-fast-official:reference-to-video';
    expect(normalizeVideoRequest(reference, minimum(reference)).request.input).toMatchObject({
      generation_type: 'reference',
      duration: 8
    });
    expect(() => normalizeVideoRequest(reference, { ...minimum(reference), duration: 6 })).toThrow(
      'requires 8 seconds'
    );
    const liteFrame = 'veo3.1-lite-official:frame-to-video';
    expect(() =>
      normalizeVideoRequest(liteFrame, { ...minimum(liteFrame), resolution: '1080p', duration: 6 })
    ).toThrow('requires 8 seconds');
    expect(
      VIDEO_CURRENT_ENTRIES.some((entry) => entry.key === 'veo3.1-lite:reference-to-video')
    ).toBe(false);
    expect(
      VIDEO_CURRENT_ENTRIES.some((entry) => entry.key === 'veo3.1-quality:reference-to-video')
    ).toBe(false);
  });

  test('REG-05 Wan IDs keep mode-specific roles, durations, safety, and string audio', () => {
    expect(
      normalizeVideoRequest(
        'wan2.6-video-to-video:video-to-video',
        minimum('wan2.6-video-to-video:video-to-video')
      ).request.model
    ).toBe('wan2.6-video-to-video');
    expect(() =>
      normalizeVideoRequest('wan2.6-video-to-video:video-to-video', {
        ...minimum('wan2.6-video-to-video:video-to-video'),
        duration: 15
      })
    ).toThrow('unsupported');
    const edit = 'wan2.7-edit-video:video-edit';
    expect(() => normalizeVideoRequest(edit, { ...minimum(edit), duration: 1 })).toThrow(
      '0 or 2-10'
    );
    expect(normalizeVideoRequest(edit, minimum(edit)).request.input).toMatchObject({
      video_url: expect.any(String),
      duration: 0,
      enable_safety_checker: false
    });
    const wan25 = 'wan2.5-text-to-video:text-to-video';
    expect(
      normalizeVideoRequest(wan25, { ...minimum(wan25), audio: 'background_music' }).request.input
        .audio
    ).toBe('background_music');
    expect(() =>
      normalizeVideoRequest(wan25, {
        ...minimum(wan25),
        audio: true
      } as unknown as GuidedVideoRequest)
    ).toThrow('must be a string');
  });

  test('REG-05 Omni exposes one-image, three-image, and video modes without false duration', () => {
    expect(
      normalizeVideoRequest('omni-flash:image-to-video', minimum('omni-flash:image-to-video'))
        .request.input.image_urls
    ).toHaveLength(1);
    expect(
      normalizeVideoRequest(
        'omni-flash:image-fusion-video',
        minimum('omni-flash:image-fusion-video')
      ).request.input.image_urls
    ).toHaveLength(3);
    const video = 'omni-flash:video-to-video';
    expect(normalizeVideoRequest(video, minimum(video)).request.input).not.toHaveProperty(
      'duration'
    );
    expect(() => normalizeVideoRequest(video, { ...minimum(video), duration: 6 })).toThrow(
      'duration is not supported'
    );
  });

  test('REG-09 combined preview dispatch preserves expert safeguards', () => {
    const key = 'grok-imagine:text-to-video';
    const preview = normalizeRegistryRequest(key, minimum(key), [
      { key: 'future_video_parameter', value: 3 }
    ]);
    expect(preview.request.model).toBe('grok-imagine');
    expect(preview.expertDiff).toEqual([
      { key: 'future_video_parameter', status: 'unverified', value: 3 }
    ]);
    expect(() =>
      normalizeRegistryRequest(key, minimum(key), [{ key: 'api_key', value: 'secret' }])
    ).toThrow('protected');
    expect(() =>
      normalizeRegistryRequest(key, minimum(key), [
        { key: 'future_video_parameter', value: Number.NaN }
      ])
    ).toThrow('strict JSON');
    expect(() => normalizeRegistryRequest(key, minimum(key), [null] as unknown as [])).toThrow(
      'key/value objects'
    );
  });
});
