import { describe, expect, test } from 'bun:test';
import { prepareJobCreateRequest } from '../../../src/lib/server/jobs/create-request';
import { seedImageRegistry, seedVideoRegistry } from '../../../src/lib/server/registry/repository';
import { createJobFixture } from '../../helpers/job-fixture';

const actionId = '019b0000-0000-7000-8000-000000000010';

describe('server-authoritative paid request preparation', () => {
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
        input: { size: '1:1', resolution: '2K' }
      });
      expect(prepared.normalizedPayload.input).not.toHaveProperty('n');
      expect(prepared.guidedRequest).not.toHaveProperty('n');
      expect(prepared.expectedOutputCount).toBe(1);
    } finally {
      await fixture.cleanup();
    }
  });

  test('JOB-10 rejects retired Seedream 5 Pro n at guided and Expert paid boundaries', async () => {
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
              values: { prompt: 'Retired Expert count' },
              expertOverrides: [{ key: 'n', value: 6 }],
              inputs
            },
            resolve
          )
        ).rejects.toThrow(
          'Expert override n is retired for Seedream 5.0 Pro; current schema does not support it.'
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
