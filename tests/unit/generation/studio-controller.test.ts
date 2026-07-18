import { describe, expect, test } from 'bun:test';
import {
  createJobRequest,
  createStudioSubmissionSnapshot,
  filterRetiredExpertOverrides,
  initialGuidedValues,
  mediaAccept,
  nextMonotonicEventId,
  paidSubmissionOutcome,
  parseExpertOverrides,
  pendingActionRecoveryDelay,
  presetValues,
  readPaidSubmissionResponse,
  sizeModes,
  valuesWithRoleInputs,
  visibleFields
} from '../../../src/lib/features/generation/studio-controller';
import { IMAGE_REGISTRY_ENTRIES } from '../../../src/lib/features/registry/image-registry';
import { VIDEO_REGISTRY_ENTRIES } from '../../../src/lib/features/registry/video-registry';

function imageEntry(key: string) {
  const entry = IMAGE_REGISTRY_ENTRIES.find((item) => item.key === key);
  if (!entry) throw new Error(`Missing image entry ${key}`);
  return entry;
}

function videoEntry(key: string) {
  const entry = VIDEO_REGISTRY_ENTRIES.find((item) => item.key === key);
  if (!entry) throw new Error(`Missing video entry ${key}`);
  return entry;
}

describe('registry-driven studio controller', () => {
  test('STUDIO-01 defaults compatible safety checkers off and never adds them elsewhere', () => {
    const seedream = imageEntry('seedream-5.0-pro:text-to-image');
    expect(initialGuidedValues(seedream).enableSafetyChecker).toBe(false);
    const flux = imageEntry('flux-schnell:text-to-image');
    expect(initialGuidedValues(flux)).not.toHaveProperty('enableSafetyChecker');
  });

  test('STUDIO-02 shows both defaulted Seedream 5 Pro size fields and scrubs retired preset n', () => {
    for (const key of ['seedream-5.0-pro:text-to-image', 'seedream-5.0-pro-edit:image-edit']) {
      const seedream = imageEntry(key);
      const fresh = initialGuidedValues(seedream);
      expect(fresh).toMatchObject({
        aspectRatio: '1:1',
        resolution: '2K'
      });
      expect(fresh).not.toHaveProperty('n');
      const restored = initialGuidedValues(seedream, {
        version: 1,
        modality: 'image',
        guided: { prompt: 'saved', n: 6 },
        expertOverrides: [],
        inputRoles: []
      });
      expect(restored).toMatchObject({ prompt: 'saved', aspectRatio: '1:1', resolution: '2K' });
      expect(restored).not.toHaveProperty('n');
      expect(seedream.fields.map((field) => field.key)).not.toContain('n');
      expect(sizeModes(seedream)).toEqual([]);
      const commonFields = visibleFields(seedream, 'common', 'resolution').map(
        (field) => field.key
      );
      expect(commonFields).toEqual(expect.arrayContaining(['aspectRatio', 'resolution']));
      expect(commonFields).not.toContain('n');

      expect(
        filterRetiredExpertOverrides(seedream, [
          { key: 'first_parameter', value: 1 },
          { key: 'n', value: 6 },
          { key: 'last_parameter', value: { kept: true } }
        ])
      ).toEqual([
        { key: 'first_parameter', value: 1 },
        { key: 'last_parameter', value: { kept: true } }
      ]);
    }

    for (const key of ['seedream-4.5:text-to-image', 'seedream-5.0-lite:text-to-image'])
      expect(sizeModes(imageEntry(key))).toEqual(['resolution', 'aspect-ratio', 'custom']);

    const flux = imageEntry('flux-2-pro:text-to-image');
    expect(sizeModes(flux)).toEqual([]);
    expect(visibleFields(flux, 'common', 'resolution').map((field) => field.key)).toEqual(
      expect.arrayContaining(['aspectRatio', 'resolution'])
    );

    const supporting = imageEntry('flux-schnell:text-to-image');
    expect(
      initialGuidedValues(supporting, {
        version: 1,
        modality: 'image',
        guided: { prompt: 'saved', n: 4 },
        expertOverrides: [],
        inputRoles: []
      }).n
    ).toBe(4);
    expect(filterRetiredExpertOverrides(supporting, [{ key: 'n', value: 4 }])).toEqual([
      { key: 'n', value: 4 }
    ]);
  });

  test('STUDIO-03 assigns scalar and list media roles to their registry request keys', () => {
    const frame = videoEntry('kling-2.6:frame-to-video');
    const values = valuesWithRoleInputs(
      frame,
      { prompt: 'animate this scene' },
      {
        'start-frame': [
          {
            id: 'start',
            role: 'start-frame',
            source: 'remote',
            url: 'https://assets.test/start.png',
            name: 'start.png',
            mediaKind: 'image'
          }
        ],
        'end-frame': [
          {
            id: 'end',
            role: 'end-frame',
            source: 'remote',
            url: 'https://assets.test/end.png',
            name: 'end.png',
            mediaKind: 'image'
          }
        ]
      }
    );
    expect(values).toMatchObject({
      imageUrls: ['https://assets.test/start.png'],
      endImageUrl: 'https://assets.test/end.png'
    });
  });

  test('STUDIO-04 serializes preset URLs and expert overrides without media bodies', () => {
    const values = presetValues(
      'image',
      { prompt: 'quiet editorial portrait', enableSafetyChecker: false },
      parseExpertOverrides('{"future_parameter":3}'),
      {
        reference: [
          {
            id: 'reference',
            role: 'reference',
            source: 'remote',
            url: 'https://assets.test/reference.png',
            name: 'reference.png',
            mediaKind: 'image'
          }
        ]
      }
    );
    expect(values.expertOverrides).toEqual([{ key: 'future_parameter', value: 3 }]);
    expect(values.inputRoles[0]?.urls).toEqual(['https://assets.test/reference.png']);
    expect(JSON.stringify(values)).not.toContain('Blob');
  });

  test('STUDIO-05 sends only guided values, media roles, expert overrides and an opaque action', () => {
    const entry = imageEntry('seedream-5.0-pro:text-to-image');
    const guided = { prompt: 'quiet editorial portrait', resolution: '2K' };
    const actionId = '019b0000-0000-7000-8000-000000000001';
    const request = createJobRequest(actionId, entry, guided, []);
    expect(request).toEqual({
      actionId,
      entryKey: entry.key,
      values: guided,
      expertOverrides: [],
      inputs: []
    });
    expect(request).not.toHaveProperty('workflow');
    expect(request).not.toHaveProperty('publicModelId');
    expect(request).not.toHaveProperty('normalizedPayload');
    const role = imageEntry('flux-2-pro-edit:image-edit').inputRoles[0];
    if (!role) throw new Error('Missing reference role.');
    expect(mediaAccept(role)).toBe('image/jpeg,image/png,image/gif,image/webp');
  });

  test('STUDIO-06 persists browser-probed media metadata with the submitted input record', () => {
    const entry = imageEntry('flux-dev:image-edit');
    const roleInputs = {
      reference: [
        {
          id: 'reference',
          role: 'reference',
          source: 'uploaded' as const,
          url: 'https://assets.test/reference.png',
          name: 'reference.png',
          mediaKind: 'image' as const,
          localSourceId: 'source-1',
          sizeBytes: 42,
          width: 1024,
          height: 768,
          metadataProbe: 'measured' as const
        }
      ]
    };
    expect(
      createJobRequest(
        '019b0000-0000-7000-8000-000000000002',
        entry,
        { prompt: 'Reframe the source' },
        [],
        roleInputs
      ).inputs[0]
    ).toMatchObject({
      localSourceId: 'source-1',
      metadata: {
        name: 'reference.png',
        sizeBytes: 42,
        width: 1024,
        height: 768,
        metadataProbe: 'measured'
      }
    });
  });

  test('STUDIO-07 captures an immutable paid-action snapshot before asynchronous validation', () => {
    const entry = imageEntry('flux-dev:image-edit');
    const guided = { prompt: 'first prompt' };
    const override = { key: 'future_parameter', value: { strength: 1 } };
    const overrides = [override];
    const reference = {
      id: 'reference',
      role: 'reference',
      source: 'remote' as const,
      url: 'https://assets.test/first.png',
      name: 'first.png',
      mediaKind: 'image' as const
    };
    const roleInputs = {
      reference: [reference]
    };
    const snapshot = createStudioSubmissionSnapshot(
      '019b0000-0000-7000-8000-000000000003',
      entry,
      guided,
      overrides,
      roleInputs
    );
    guided.prompt = 'second prompt';
    override.value = { strength: 2 };
    reference.url = 'https://assets.test/second.png';
    expect(snapshot.request.values).toEqual({ prompt: 'first prompt' });
    expect(snapshot.request.inputs[0]?.url).toBe('https://assets.test/first.png');
    expect(snapshot.preview.values).toMatchObject({
      prompt: 'first prompt',
      imageUrls: ['https://assets.test/first.png']
    });
    expect(snapshot.preview.expertOverrides).toEqual([
      { key: 'future_parameter', value: { strength: 1 } }
    ]);
  });

  test('JOB-01 distinguishes definitive rejection from an ambiguous paid response', () => {
    expect(paidSubmissionOutcome(false, false)).toBe('rejected');
    expect(paidSubmissionOutcome(false, true)).toBe('rejected');
    expect(paidSubmissionOutcome(true, false)).toBe('ambiguous');
    expect(paidSubmissionOutcome(true, true)).toBe('confirmed');
  });

  test('JOB-01 classifies non-JSON rejection and malformed success before UI state mapping', async () => {
    expect(await readPaidSubmissionResponse(new Response('rejected', { status: 400 }))).toEqual({
      outcome: 'rejected',
      result: {}
    });
    expect(
      await readPaidSubmissionResponse(new Response('accepted but malformed', { status: 202 }))
    ).toEqual({ outcome: 'ambiguous', result: {} });
    expect(
      await readPaidSubmissionResponse(
        new Response('null', { status: 400, headers: { 'content-type': 'application/json' } })
      )
    ).toEqual({ outcome: 'rejected', result: {} });
    expect(
      await readPaidSubmissionResponse(
        new Response('null', { status: 202, headers: { 'content-type': 'application/json' } })
      )
    ).toEqual({ outcome: 'ambiguous', result: {} });
    expect(await readPaidSubmissionResponse(Response.json({ job: null }, { status: 202 }))).toEqual(
      { outcome: 'ambiguous', result: { job: null } }
    );
    expect(
      await readPaidSubmissionResponse(Response.json({ job: 'invalid' }, { status: 202 }))
    ).toEqual({ outcome: 'ambiguous', result: { job: 'invalid' } });
    expect(await readPaidSubmissionResponse(Response.json({ job: {} }, { status: 202 }))).toEqual({
      outcome: 'ambiguous',
      result: { job: {} }
    });
    expect(
      await readPaidSubmissionResponse(
        Response.json({ job: { id: 'confirmed-job' } }, { status: 202 })
      )
    ).toEqual({ outcome: 'confirmed', result: { job: { id: 'confirmed-job' } } });
  });

  test('SSE-03 accepts only strictly monotonic durable event IDs', () => {
    expect(nextMonotonicEventId(-1, '0')).toBe(0);
    expect(nextMonotonicEventId(9, '10')).toBe(10);
    expect(nextMonotonicEventId(10, '10')).toBeNull();
    expect(nextMonotonicEventId(10, '9')).toBeNull();
    expect(nextMonotonicEventId(10, '')).toBeNull();
    expect(nextMonotonicEventId(10, 'not-an-id')).toBeNull();
  });

  test('JOB-12 keeps recovery bounded without treating one early 404 as authoritative', () => {
    expect(Array.from({ length: 6 }, (_, attempt) => pendingActionRecoveryDelay(attempt))).toEqual([
      0, 150, 300, 600, 1200, 2400
    ]);
    expect(pendingActionRecoveryDelay(6)).toBeNull();
  });

  test('JOB-12 unresolved actions stay locked until explicit duplicate-spend acknowledgement', async () => {
    const workspace = await Bun.file('src/lib/components/studio/StudioWorkspace.svelte').text();
    expect(workspace).toContain('Acknowledge risk and start a new action');
    expect(workspace).toContain('spend credits twice');
    expect(workspace).toContain('recoveryConcluded = onlyNotFound');
    expect(workspace).not.toContain('if (response.status === 404) {\n      clearPendingAction');
  });

  test('SSE-04 Jobs page uses the same durable lastEventId gate as Studio', async () => {
    const page = await Bun.file('src/routes/jobs/+page.svelte').text();
    expect(page).toContain('nextMonotonicEventId');
    expect(page).toContain('event.lastEventId');
    expect(page).toContain('if (next === null) return');
  });
});
