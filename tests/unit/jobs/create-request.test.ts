import { describe, expect, test } from 'bun:test';
import { prepareJobCreateRequest } from '../../../src/lib/server/jobs/create-request';
import { seedImageRegistry, seedVideoRegistry } from '../../../src/lib/server/registry/repository';
import { createJobFixture } from '../../helpers/job-fixture';

const actionId = '019b0000-0000-7000-8000-000000000010';

describe('server-authoritative paid request preparation', () => {
  test('JOB-10 rejects client-authored estimate metadata', async () => {
    const fixture = await createJobFixture();
    try {
      seedImageRegistry(fixture.database);
      await expect(
        prepareJobCreateRequest(
          fixture.database,
          {
            actionId,
            entryKey: 'flux-schnell:text-to-image',
            values: { prompt: 'A registry-owned request' },
            estimate: { credits: 0 }
          },
          async () => {
            throw new Error('No source should be resolved.');
          }
        )
      ).rejects.toThrow('Unsupported job request field estimate.');
    } finally {
      await fixture.cleanup();
    }
  });

  test('JOB-10 derives model, workflow, payload, safety default and expected outputs from registry', async () => {
    const fixture = await createJobFixture();
    try {
      seedImageRegistry(fixture.database);
      seedVideoRegistry(fixture.database);
      const prepared = await prepareJobCreateRequest(
        fixture.database,
        {
          actionId,
          entryKey: 'flux-schnell:text-to-image',
          values: { prompt: 'A registry-owned request' },
          expertOverrides: [],
          inputs: []
        },
        async () => {
          throw new Error('No source should be resolved.');
        }
      );
      expect(prepared).toMatchObject({
        actionId,
        entryKey: 'flux-schnell:text-to-image',
        workflow: 'text-to-image',
        publicModelId: 'flux-schnell',
        expectedMediaKind: 'image',
        expectedOutputCount: 1,
        normalizedPayload: { model: 'flux-schnell', input: { prompt: 'A registry-owned request' } }
      });
      expect(prepared.normalizedPayload).not.toHaveProperty('callbackUrl');
    } finally {
      await fixture.cleanup();
    }
  });

  test('JOB-10 rebuilds Seedream 5 Pro size and resolution defaults at the paid boundary', async () => {
    const fixture = await createJobFixture();
    try {
      seedImageRegistry(fixture.database);
      const prepared = await prepareJobCreateRequest(
        fixture.database,
        {
          actionId,
          entryKey: 'seedream-5.0-pro:text-to-image',
          values: { prompt: 'A registry-owned Seedream request' },
          expertOverrides: [],
          inputs: []
        },
        async () => {
          throw new Error('No source should be resolved.');
        }
      );
      expect(prepared.normalizedPayload).toMatchObject({
        model: 'seedream-5.0-pro',
        input: { size: '1:1', resolution: '1K' }
      });
      expect(prepared.normalizedPayload.input).not.toHaveProperty('n');
      expect(prepared.guidedRequest).not.toHaveProperty('n');
      expect(prepared.expectedOutputCount).toBe(1);
    } finally {
      await fixture.cleanup();
    }
  });

  test('JOB-10 accepts current WAN image-to-video and unrelated frame-to-video entries while rejecting the retired WAN pair', async () => {
    const fixture = await createJobFixture();
    try {
      seedVideoRegistry(fixture.database);
      const resolve = async () => {
        throw new Error('No remote source should be resolved.');
      };
      const wan = await prepareJobCreateRequest(
        fixture.database,
        {
          actionId,
          entryKey: 'wan2.7-image-to-video:image-to-video',
          values: {
            prompt: 'Animate',
            duration: 2,
            resolution: '720p',
            multiShots: true,
            audioUrl: 'https://assets.example/soundtrack.mp3'
          },
          expertOverrides: [],
          inputs: [
            {
              role: 'start-frame',
              mediaKind: 'image',
              source: 'remote',
              url: 'https://assets.example/start.png'
            },
            {
              role: 'start-frame',
              mediaKind: 'image',
              source: 'remote',
              url: 'https://assets.example/end.png'
            },
            {
              role: 'source-video',
              mediaKind: 'video',
              source: 'remote',
              url: 'https://assets.example/motion.mp4'
            }
          ]
        },
        resolve
      );
      expect(wan).toMatchObject({
        entryKey: 'wan2.7-image-to-video:image-to-video',
        workflow: 'image-to-video',
        publicModelId: 'wan2.7-image-to-video',
        normalizedPayload: {
          model: 'wan2.7-image-to-video',
          input: {
            image_urls: ['https://assets.example/start.png', 'https://assets.example/end.png'],
            video_url: 'https://assets.example/motion.mp4',
            audio_url: 'https://assets.example/soundtrack.mp3',
            duration: 2,
            resolution: '720p',
            multi_shots: true,
            enable_safety_checker: false
          }
        }
      });
      const frame = await prepareJobCreateRequest(
        fixture.database,
        {
          actionId: '019b0000-0000-7000-8000-000000000011',
          entryKey: 'kling-2.6:frame-to-video',
          values: { prompt: 'Animate frames', duration: 5, aspectRatio: '16:9' },
          expertOverrides: [],
          inputs: [
            {
              role: 'start-frame',
              mediaKind: 'image',
              source: 'remote',
              url: 'https://assets.example/start.png'
            },
            {
              role: 'end-frame',
              mediaKind: 'image',
              source: 'remote',
              url: 'https://assets.example/end.png'
            }
          ]
        },
        resolve
      );
      expect(frame).toMatchObject({
        entryKey: 'kling-2.6:frame-to-video',
        workflow: 'frame-to-video',
        publicModelId: 'kling-2.6',
        normalizedPayload: {
          model: 'kling-2.6',
          input: {
            image_urls: ['https://assets.example/start.png'],
            end_image_url: 'https://assets.example/end.png',
            sound: false
          }
        }
      });
      await expect(
        prepareJobCreateRequest(
          fixture.database,
          {
            actionId: '019b0000-0000-7000-8000-000000000013',
            entryKey: 'wan2.7-image-to-video:image-to-video',
            values: { duration: 2, resolution: '720p', aspectRatio: '16:9' },
            expertOverrides: [],
            inputs: []
          },
          resolve
        )
      ).rejects.toThrow('Unsupported guided field aspectRatio.');
      await expect(
        prepareJobCreateRequest(
          fixture.database,
          {
            actionId: '019b0000-0000-7000-8000-000000000012',
            entryKey: 'wan2.7-image-to-video:frame-to-video',
            values: { duration: 2, resolution: '720p' },
            expertOverrides: [],
            inputs: []
          },
          resolve
        )
      ).rejects.toThrow('Registry entry is unavailable.');
    } finally {
      await fixture.cleanup();
    }
  });

  test('JOB-10 rejects unsupported Seedream 5 Pro n at guided and Expert paid boundaries', async () => {
    const fixture = await createJobFixture();
    try {
      seedImageRegistry(fixture.database);
      const resolve = async () => {
        throw new Error('No managed source should be resolved.');
      };
      for (const entryKey of [
        'seedream-5.0-pro:text-to-image',
        'seedream-5.0-pro-edit:image-edit'
      ]) {
        const inputs = entryKey.includes('-edit')
          ? [
              {
                role: 'reference',
                mediaKind: 'image' as const,
                source: 'remote' as const,
                url: 'https://assets.example/reference.png'
              }
            ]
          : [];
        await expect(
          prepareJobCreateRequest(
            fixture.database,
            {
              actionId,
              entryKey,
              values: { prompt: 'Retired guided count', n: 6 },
              expertOverrides: [],
              inputs
            },
            resolve
          )
        ).rejects.toThrow('Unsupported guided field n.');
        await expect(
          prepareJobCreateRequest(
            fixture.database,
            {
              actionId,
              entryKey,
              values: { prompt: 'Unsupported Expert count' },
              expertOverrides: [{ key: 'n', value: 6 }],
              inputs
            },
            resolve
          )
        ).rejects.toThrow(
          'Expert override n is not supported by the current Seedream 5.0 Pro schema.'
        );
      }
    } finally {
      await fixture.cleanup();
    }
  });

  test('JOB-10 preserves supported non-Pro output counts', async () => {
    const fixture = await createJobFixture();
    try {
      seedImageRegistry(fixture.database);
      const prepared = await prepareJobCreateRequest(
        fixture.database,
        {
          actionId,
          entryKey: 'flux-schnell:text-to-image',
          values: { prompt: 'Two supported outputs', n: 2 },
          expertOverrides: [],
          inputs: []
        },
        async () => {
          throw new Error('No source should be resolved.');
        }
      );
      expect(prepared.normalizedPayload.input.n).toBe(2);
      expect(prepared.expectedOutputCount).toBe(2);
    } finally {
      await fixture.cleanup();
    }
  });

  test('JOB-10 replaces a retained-source placeholder with a freshly uploaded URL', async () => {
    const fixture = await createJobFixture();
    try {
      seedImageRegistry(fixture.database);
      const localSourceId = '019b0000-0000-7000-8000-000000000099';
      let refreshRequested = false;
      const prepared = await prepareJobCreateRequest(
        fixture.database,
        {
          actionId,
          entryKey: 'seedream-5.0-pro-edit:image-edit',
          values: { prompt: 'Retain the composition', aspectRatio: '9:16', resolution: '2K' },
          expertOverrides: [],
          inputs: [
            {
              role: 'reference',
              mediaKind: 'image',
              source: 'uploaded',
              url: `https://retained-source.invalid/${localSourceId}`,
              localSourceId,
              metadata: { name: 'Uploaded reference', width: 900, height: 1601 }
            }
          ]
        },
        async (id, mediaKind, refreshUpload) => {
          expect(id).toBe(localSourceId);
          expect(mediaKind).toBe('image');
          refreshRequested = refreshUpload;
          return { id, url: 'https://poyo.test/fresh-retained-source.png' };
        }
      );
      expect(refreshRequested).toBe(true);
      expect(prepared.inputs?.[0]).toMatchObject({
        managedSourceId: localSourceId,
        url: 'https://poyo.test/fresh-retained-source.png'
      });
      expect(prepared.normalizedPayload.input.image_urls).toEqual([
        'https://poyo.test/fresh-retained-source.png'
      ]);
    } finally {
      await fixture.cleanup();
    }
  });

  test('JOB-10 rejects browser-authored envelopes, protected overrides, stale entries and media tampering', async () => {
    const fixture = await createJobFixture();
    try {
      seedImageRegistry(fixture.database);
      seedVideoRegistry(fixture.database);
      const resolve = async () => {
        throw new Error('No managed source should be resolved.');
      };
      await expect(
        prepareJobCreateRequest(
          fixture.database,
          {
            actionId,
            entryKey: 'flux-schnell:text-to-image',
            values: { prompt: 'tampered' },
            expertOverrides: [],
            inputs: [],
            normalizedPayload: {
              model: 'different-paid-model',
              input: { enable_safety_checker: true },
              callbackUrl: 'http://127.0.0.1/callback'
            }
          },
          resolve
        )
      ).rejects.toThrow('Unsupported job request field');
      await expect(
        prepareJobCreateRequest(
          fixture.database,
          {
            actionId,
            entryKey: 'flux-schnell:text-to-image',
            values: { prompt: 'tampered' },
            expertOverrides: [{ key: 'callback_url', value: 'http://127.0.0.1/callback' }],
            inputs: []
          },
          resolve
        )
      ).rejects.toThrow('protected');
      await expect(
        prepareJobCreateRequest(
          fixture.database,
          {
            actionId,
            entryKey: 'removed-model:text-to-image',
            values: { prompt: 'stale' },
            expertOverrides: [],
            inputs: []
          },
          resolve
        )
      ).rejects.toThrow('unavailable');
      await expect(
        prepareJobCreateRequest(
          fixture.database,
          {
            actionId,
            entryKey: 'flux-dev:image-edit',
            values: { prompt: 'smuggled media', imageUrls: ['https://attacker.test/source.png'] },
            expertOverrides: [],
            inputs: []
          },
          resolve
        )
      ).rejects.toThrow('Unsupported guided field');

      for (const [entryKey, values, message] of [
        ['flux-schnell:text-to-image', { prompt: { injected: true } }, 'prompt must be a string'],
        ['flux-schnell:text-to-image', { prompt: 'render', n: '4' }, 'n must be an integer'],
        [
          'seedream-4.5:text-to-image',
          { prompt: 'render', enableSafetyChecker: 'false' },
          'enableSafetyChecker must be boolean'
        ],
        [
          'happy-horse:text-to-video',
          { prompt: 'animate', duration: '5' },
          'duration must be an integer'
        ],
        [
          'happy-horse:text-to-video',
          { prompt: 'animate', duration: 5, enableSafetyChecker: 'false' },
          'enableSafetyChecker must be boolean'
        ],
        ['happy-horse:text-to-video', { prompt: null, duration: 5 }, 'prompt must be a string'],
        [
          'happy-horse:text-to-video',
          { prompt: 'animate', duration: 5, unknownField: [] },
          'Unsupported guided field'
        ]
      ] as const) {
        await expect(
          prepareJobCreateRequest(
            fixture.database,
            { actionId, entryKey, values, expertOverrides: [], inputs: [] },
            resolve
          )
        ).rejects.toThrow(message);
      }
    } finally {
      await fixture.cleanup();
    }
  });
});
