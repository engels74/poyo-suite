import { beforeEach, describe, expect, test } from 'bun:test';
import type { StudioJobDto } from '../../../src/lib/features/generation/contracts';
import type { Estimate } from '../../../src/lib/features/pricing/contracts';
import {
  applyBatchJob,
  batchItemCompatibilityIssues,
  beginPaidBatchRetry,
  createBatchItem,
  duplicateBatchItem,
  readStudioBatch,
  restoreBatchItemForRegistry,
  restoreBatchRoleInputs,
  summarizeReadyBatchEstimates,
  summarizeSettledBatchCharges,
  writeStudioBatch,
  type StudioBatch
} from '../../../src/lib/features/generation/studio-batch';
import { IMAGE_REGISTRY } from '../../../src/lib/features/registry/image-registry';

class MemoryStorage {
  private store = new Map<string, string>();
  getItem(key: string): string | null {
    return this.store.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.store.set(key, value);
  }
  removeItem(key: string): void {
    this.store.delete(key);
  }
}

beforeEach(() => {
  (globalThis as { localStorage: Storage }).localStorage =
    new MemoryStorage() as unknown as Storage;
});

const request = {
  actionId: '019b0000-0000-7000-8000-000000000001',
  entryKey: 'seedream-5.0-pro:text-to-image',
  values: { prompt: 'One', aspectRatio: '16:9', resolution: '2K' },
  expertOverrides: [],
  inputs: []
};
const sourceId = '019b0000-0000-7000-8000-000000000099';
const estimate: Estimate = {
  classification: 'estimate',
  credits: 60,
  signature:
    'version=pricing-signature-v1|registry=video-2026-07-20.1|model=wan2.7-image-to-video|workflow=image-to-video|unit=per-second|duration=5|resolution=720p',
  basis: { unit: 'per-second', creditsPerUnit: 12, units: 5 },
  provenance: 'published',
  sourceVerifiedAt: '2026-07-20T00:00:00.000Z',
  expiresAt: '2026-07-21T00:00:00.000Z',
  freshness: 'fresh',
  availability: 'available'
};

function job(overrides: Partial<StudioJobDto> = {}): StudioJobDto {
  return {
    id: 'job-1',
    workflow: 'text-to-image',
    publicModelId: 'seedream-5.0-pro',
    localPhase: 'monitoring',
    remoteStatus: 'running',
    failureDomain: 'none',
    attentionCode: null,
    poyoTaskId: 'task-1',
    progress: 25,
    estimatedCredits: null,
    actualCredits: null,
    lastPolledAt: null,
    createdAt: '2026-07-17T00:00:00.000Z',
    updatedAt: '2026-07-17T00:00:00.000Z',
    completedAt: null,
    ...overrides
  };
}

describe('studio batch persistence and state', () => {
  test('BATCH-01 creates and round-trips a secrets-free batch item', () => {
    const item = createBatchItem(
      {
        modality: 'image',
        displayName: 'Seedream 5 Pro',
        sizeMode: 'aspect-ratio',
        automaticFields: [],
        request,
        estimate
      },
      {
        itemId: 'item-1',
        actionId: request.actionId,
        now: '2026-07-17T00:00:00.000Z'
      }
    );
    const batch: StudioBatch = { version: 1, modality: 'image', items: [item] };
    writeStudioBatch('image', batch);
    expect(readStudioBatch('image')).toEqual(batch);
    expect(readStudioBatch('image')?.items[0]?.estimate).toEqual(estimate);
    expect(JSON.stringify(batch)).not.toContain('POYO_API_KEY');
    expect(JSON.stringify(batch)).not.toContain('/Users/');
  });

  test('BATCH-01 preserves nonblank stale paid recovery data and current video workflows verbatim', () => {
    const stale = createBatchItem(
      {
        modality: 'video',
        displayName: 'Wan 2.7 Video',
        sizeMode: 'aspect-ratio',
        automaticFields: ['aspectRatio'],
        request: {
          ...request,
          entryKey: 'retired-video-model:old-workflow',
          values: {
            prompt: 'Animate',
            aspectRatio: '16:9',
            resolution: '720p',
            duration: 2
          }
        },
        estimate: null
      },
      {
        itemId: 'wan-item-1',
        actionId: request.actionId,
        now: '2026-07-17T00:00:00.000Z'
      }
    );
    const submitting = { ...stale, state: 'submitting' as const };
    const batch: StudioBatch = {
      version: 1,
      modality: 'video',
      items: [submitting]
    };
    localStorage.setItem('poyo-studio-batch:video', JSON.stringify(batch));
    const restored = readStudioBatch('video')?.items[0];
    expect(restored).toEqual(submitting);
    if (!restored) throw new Error('Missing saved batch item.');
    expect(restoreBatchItemForRegistry(restored, undefined)).toEqual({
      ...submitting,
      state: 'unknown',
      error:
        'The app restarted before this paid submission was confirmed. Check the saved action before retrying.'
    });

    const unknown = {
      ...submitting,
      state: 'unknown' as const,
      error: 'Reconcile this paid action.'
    };
    expect(restoreBatchItemForRegistry(unknown, undefined)).toEqual(unknown);

    for (const entryKey of ['wan2.7-image-to-video:image-to-video', 'kling-2.6:frame-to-video']) {
      const current = {
        ...stale,
        request: { ...stale.request, entryKey },
        state: 'draft' as const
      };
      expect(writeStudioBatch('video', { version: 1, modality: 'video', items: [current] })).toBe(
        true
      );
      expect(readStudioBatch('video')?.items[0]).toEqual(current);
    }
  });

  test('BATCH-02 duplicates a draft with new stable IDs and no shared mutable values', () => {
    const item = createBatchItem(
      {
        modality: 'image',
        displayName: 'Seedream 5 Pro',
        sizeMode: 'aspect-ratio',
        automaticFields: ['aspectRatio'],
        request
      },
      { itemId: 'item-1', actionId: request.actionId, now: '2026-07-17T00:00:00.000Z' }
    );
    const copy = duplicateBatchItem(item, {
      itemId: 'item-2',
      actionId: '019b0000-0000-7000-8000-000000000002',
      now: '2026-07-17T01:00:00.000Z'
    });
    expect(copy.id).toBe('item-2');
    expect(copy.request.actionId).toBe('019b0000-0000-7000-8000-000000000002');
    expect(copy.state).toBe('draft');
    copy.request.values.prompt = 'Two';
    expect(item.request.values.prompt).toBe('One');
  });

  test('BATCH-03 maps durable job truth without losing an item after partial failure', () => {
    const item = createBatchItem(
      {
        modality: 'image',
        displayName: 'Seedream 5 Pro',
        sizeMode: 'aspect-ratio',
        automaticFields: [],
        request
      },
      { itemId: 'item-1', actionId: request.actionId, now: '2026-07-17T00:00:00.000Z' }
    );
    expect(applyBatchJob(item, job()).state).toBe('running');
    expect(
      applyBatchJob(item, job({ localPhase: 'complete', remoteStatus: 'finished', progress: 100 }))
        .state
    ).toBe('complete');
    expect(
      applyBatchJob(item, job({ localPhase: 'complete', remoteStatus: 'failed', progress: 100 }))
        .state
    ).toBe('failed');

    const complete = applyBatchJob(
      item,
      job({
        localPhase: 'complete',
        remoteStatus: 'finished',
        progress: 100,
        updatedAt: '2026-07-17T00:02:00.000Z'
      })
    );
    expect(
      applyBatchJob(
        complete,
        job({
          localPhase: 'monitoring',
          remoteStatus: 'running',
          updatedAt: '2026-07-17T00:01:00.000Z'
        })
      )
    ).toEqual(complete);
  });

  test('BATCH-04 restores uploaded reference metadata without a browser File or local path', () => {
    const item = createBatchItem(
      {
        modality: 'image',
        displayName: 'Flux Dev',
        sizeMode: 'aspect-ratio',
        automaticFields: ['aspectRatio'],
        request: {
          ...request,
          inputs: [
            {
              role: 'reference',
              source: 'uploaded',
              mediaKind: 'image',
              url: 'https://uploads.test/source.png',
              localSourceId: sourceId,
              metadata: {
                name: '/Users/alice/private/source.png',
                expiresAt: '2026-07-18T00:00:00.000Z',
                width: 900,
                height: 1601
              }
            }
          ]
        }
      },
      { itemId: 'item-1', actionId: request.actionId, now: '2026-07-17T00:00:00.000Z' }
    );
    const batch: StudioBatch = { version: 1, modality: 'image', items: [item] };
    expect(writeStudioBatch('image', batch)).toBe(true);
    const stored = readStudioBatch('image');
    expect(stored).not.toBeNull();
    expect(JSON.stringify(stored)).not.toContain('/Users/alice');
    expect(JSON.stringify(stored)).not.toContain('uploads.test');
    expect(JSON.stringify(stored)).not.toContain('expiresAt');
    expect(stored?.items[0]?.request.inputs[0]?.url).toBe(
      `https://retained-source.invalid/${sourceId}`
    );
    expect(restoreBatchRoleInputs(stored?.items[0] ?? item).reference?.[0]).toMatchObject({
      localSourceId: sourceId,
      width: 900,
      height: 1601,
      name: 'Uploaded reference'
    });
  });

  test('BATCH-04 rejects blank video selections without persisting uploaded source details', () => {
    const item = createBatchItem(
      {
        modality: 'video',
        displayName: 'Invalid video item',
        sizeMode: 'resolution',
        automaticFields: [],
        request: {
          ...request,
          entryKey: '   ',
          values: { prompt: 'Animate' },
          inputs: [
            {
              role: 'reference',
              source: 'uploaded',
              mediaKind: 'image',
              url: 'https://uploads.test/private-source.png',
              localSourceId: sourceId,
              metadata: {
                name: '/Users/alice/private/source.png',
                expiresAt: '2026-07-18T00:00:00.000Z'
              }
            }
          ]
        }
      },
      { itemId: 'item-1', actionId: request.actionId, now: '2026-07-17T00:00:00.000Z' }
    );
    const storageKey = 'poyo-studio-batch:video';
    const existing = JSON.stringify({ sentinel: true });
    localStorage.setItem(storageKey, existing);

    expect(writeStudioBatch('video', { version: 1, modality: 'video', items: [item] })).toBe(false);
    expect(localStorage.getItem(storageKey)).toBe(existing);
  });

  test('BATCH-05 rejects malformed, oversized, and over-capacity storage', () => {
    localStorage.setItem('poyo-studio-batch:image', '{bad');
    expect(readStudioBatch('image')).toBeNull();
    localStorage.setItem('poyo-studio-batch:image', 'x'.repeat(500_001));
    expect(readStudioBatch('image')).toBeNull();
    localStorage.setItem(
      'poyo-studio-batch:image',
      JSON.stringify({
        version: 1,
        modality: 'image',
        items: Array.from({ length: 21 }, () => ({}))
      })
    );
    expect(readStudioBatch('image')).toBeNull();

    const item = createBatchItem(
      {
        modality: 'image',
        displayName: 'Seedream 5 Pro',
        sizeMode: 'aspect-ratio',
        automaticFields: [],
        request
      },
      { itemId: 'item-1', actionId: request.actionId, now: '2026-07-17T00:00:00.000Z' }
    );
    for (const malformed of [
      { ...item, request: { ...item.request, inputs: [{}] } },
      { ...item, request: { ...item.request, expertOverrides: [{}] } },
      { ...item, estimate: { ...estimate, rawTier: { secret: true } } },
      { ...item, estimate: { ...estimate, credits: Number.POSITIVE_INFINITY } },
      { ...item, estimate: { ...estimate, signature: 'prompt=private' } },
      { ...item, job: { id: 'truncated' } },
      { ...item, outputs: [{ outputId: 'truncated' }] }
    ]) {
      localStorage.setItem(
        'poyo-studio-batch:image',
        JSON.stringify({ version: 1, modality: 'image', items: [malformed] })
      );
      expect(readStudioBatch('image')).toBeNull();
    }
    localStorage.setItem(
      'poyo-studio-batch:image',
      JSON.stringify({
        version: 1,
        modality: 'image',
        items: [{ ...item, estimate: undefined }]
      })
    );
    expect(readStudioBatch('image')).toBeNull();
    for (const persistedEstimate of [null, estimate]) {
      const persisted = { ...item, estimate: persistedEstimate };
      localStorage.setItem(
        'poyo-studio-batch:image',
        JSON.stringify({ version: 1, modality: 'image', items: [persisted] })
      );
      expect(readStudioBatch('image')).toEqual({
        version: 1,
        modality: 'image',
        items: [persisted]
      });
    }
  });

  test('retains an estimate on duplication and replaces it after successful revalidation', async () => {
    const item = createBatchItem(
      {
        modality: 'image',
        displayName: 'Seedream 5 Pro',
        sizeMode: 'aspect-ratio',
        automaticFields: [],
        request,
        estimate: { ...estimate, freshness: 'stale' }
      },
      { itemId: 'item-1', actionId: request.actionId, now: '2026-07-17T00:00:00.000Z' }
    );
    const copy = duplicateBatchItem(item, {
      itemId: 'item-2',
      actionId: '019b0000-0000-7000-8000-000000000002',
      now: '2026-07-17T01:00:00.000Z'
    });
    expect(copy.estimate).toEqual({ ...estimate, freshness: 'stale' });
    const refreshed = createBatchItem(
      { ...item, estimate },
      { itemId: item.id, actionId: item.request.actionId, now: '2026-07-17T02:00:00.000Z' }
    );
    expect(refreshed.estimate).toEqual(estimate);

    const workspace = await Bun.file('src/lib/components/studio/StudioWorkspace.svelte').text();
    expect(workspace).toContain('const validated = await validateSubmissionSnapshot');
    expect(workspace).toContain('estimate: validated.estimate ?? null');
    expect(workspace).toContain('return result;');
  });

  test('totals normalized quantity for unique ready actions without submitted duplicates', () => {
    const makeItem = (itemId: string, actionId: string, quantity: number, credits: number) =>
      createBatchItem(
        {
          modality: 'image',
          displayName: 'Seedream 5 Pro',
          sizeMode: 'aspect-ratio',
          automaticFields: [],
          request: { ...request, actionId, values: { ...request.values, n: quantity } },
          estimate: {
            ...estimate,
            credits,
            basis: { unit: 'per-output', creditsPerUnit: credits / quantity, units: quantity }
          }
        },
        { itemId, actionId, now: '2026-07-17T00:00:00.000Z' }
      ) satisfies ReturnType<typeof createBatchItem>;
    const readyA = makeItem('ready-a', '019b0000-0000-7000-8000-000000000011', 3, 24);
    const readyADuplicate = { ...readyA, id: 'ready-a-duplicate' };
    const readyB = makeItem('ready-b', '019b0000-0000-7000-8000-000000000012', 2, 16);
    expect(summarizeReadyBatchEstimates([readyA, readyADuplicate, readyB])).toEqual({
      itemCount: 2,
      quantity: 5,
      credits: 40
    });

    const submittedA = {
      ...readyA,
      id: 'submitted-a',
      state: 'queued' as const,
      job: job()
    };
    expect(summarizeReadyBatchEstimates([readyA, readyADuplicate, submittedA, readyB])).toEqual({
      itemCount: 1,
      quantity: 2,
      credits: 16
    });
    expect(
      summarizeReadyBatchEstimates([
        readyB,
        { ...makeItem('ready-c', '019b0000-0000-7000-8000-000000000013', 4, 0), estimate: null }
      ])
    ).toEqual({ itemCount: 2, quantity: 6, credits: null });
  });

  test('totals only settled Poyo task charges once per paid action', async () => {
    const makeItem = (itemId: string, actionId: string) =>
      createBatchItem(
        {
          modality: 'image',
          displayName: 'Seedream 5 Pro',
          sizeMode: 'aspect-ratio',
          automaticFields: [],
          request: { ...request, actionId }
        },
        { itemId, actionId, now: '2026-07-17T00:00:00.000Z' }
      );
    const actionA = '019b0000-0000-7000-8000-000000000021';
    const actionB = '019b0000-0000-7000-8000-000000000022';
    const chargedA = applyBatchJob(
      makeItem('charged-a', actionA),
      job({
        id: 'job-a',
        localPhase: 'complete',
        remoteStatus: 'failed',
        actualCredits: 2.25,
        taskCharge: {
          classification: 'task-charge',
          credits: 2.25,
          source: 'poyo-task',
          terminalStatus: 'failed',
          settledAt: '2026-07-17T00:01:00.000Z'
        }
      })
    );
    const chargedADuplicate = { ...chargedA, id: 'charged-a-duplicate' };
    const chargedB = applyBatchJob(
      makeItem('charged-b', actionB),
      job({
        id: 'job-b',
        localPhase: 'complete',
        remoteStatus: 'finished',
        actualCredits: 1.125,
        taskCharge: {
          classification: 'task-charge',
          credits: 1.125,
          source: 'poyo-task',
          terminalStatus: 'finished',
          settledAt: '2026-07-17T00:02:00.000Z'
        }
      })
    );
    const terminalWithoutCharge = applyBatchJob(
      makeItem('unsettled', '019b0000-0000-7000-8000-000000000023'),
      job({
        id: 'job-unsettled',
        localPhase: 'complete',
        remoteStatus: 'failed',
        actualCredits: null,
        taskCharge: null
      })
    );

    expect(summarizeSettledBatchCharges([])).toEqual({ actionCount: 0, credits: 0 });
    expect(
      summarizeSettledBatchCharges([chargedA, chargedADuplicate, chargedB, terminalWithoutCharge])
    ).toEqual({ actionCount: 2, credits: 3.375 });

    const review = await Bun.file('src/lib/components/studio/BatchReview.svelte').text();
    expect(review).toContain("'no settled Poyo task charges'");
    expect(review).not.toContain('Actual batch total: {settledCharges.credits} credits');

    const workspace = await Bun.file('src/lib/components/studio/StudioWorkspace.svelte').text();
    for (const label of [
      "return 'observed median'",
      "return 'published + observed'",
      "return 'published'",
      "? 'generation remains enabled' : 'complete setup to generate'",
      'Estimated credits:',
      'Charged:',
      'Outstanding projection:'
    ]) {
      expect(workspace).toContain(label);
    }
  });

  test('BATCH-06 begins a paid retry with a durable new action and no stale job or output', () => {
    const item = createBatchItem(
      {
        modality: 'image',
        displayName: 'Seedream 5 Pro',
        sizeMode: 'aspect-ratio',
        automaticFields: [],
        request
      },
      { itemId: 'item-1', actionId: request.actionId, now: '2026-07-17T00:00:00.000Z' }
    );
    const failed = {
      ...applyBatchJob(item, job({ remoteStatus: 'failed' })),
      outputs: [
        {
          outputId: 'output-1',
          mediaKind: 'image' as const,
          mediaUrl: null,
          aspectRatio: null,
          pixelWidth: null,
          pixelHeight: null,
          fileName: null,
          downloadState: 'failed',
          localAvailable: false
        }
      ]
    };
    const nextAction = '019b0000-0000-7000-8000-000000000002';
    const retry = beginPaidBatchRetry(failed, nextAction, '2026-07-17T01:00:00.000Z');
    expect(retry).toMatchObject({
      state: 'submitting',
      job: null,
      outputs: [],
      request: { actionId: nextAction }
    });
  });

  test('BATCH-07 detects same-key registry drift before a saved draft can submit', () => {
    const entry = IMAGE_REGISTRY.entries.find(
      (candidate) => candidate.key === 'seedream-5.0-pro:text-to-image'
    );
    if (!entry) throw new Error('Missing Seedream registry fixture.');
    const item = createBatchItem(
      {
        modality: 'image',
        displayName: entry.displayName,
        sizeMode: 'aspect-ratio',
        automaticFields: ['aspectRatio'],
        request
      },
      { itemId: 'item-1', actionId: request.actionId, now: '2026-07-17T00:00:00.000Z' }
    );
    expect(batchItemCompatibilityIssues(item, entry)).toEqual([]);
    const withoutAspectRatio = {
      ...entry,
      fields: entry.fields.filter((field) => field.key !== 'aspectRatio')
    };
    expect(batchItemCompatibilityIssues(item, withoutAspectRatio)).toEqual(
      expect.arrayContaining([
        'Automatic aspectRatio is no longer supported.',
        'The saved aspectRatio option is no longer supported.'
      ])
    );
    expect(
      batchItemCompatibilityIssues(item, {
        ...entry,
        fields: [
          ...entry.fields,
          {
            key: 'newRequiredField',
            apiKey: 'new_required_field',
            kind: 'text',
            level: 'common',
            required: true
          }
        ]
      })
    ).toContain('The newRequiredField option is now required.');
  });

  test('BATCH-DIM keeps custom dimensions compatible only while the capability exists', () => {
    const entry = IMAGE_REGISTRY.entries.find(
      (candidate) => candidate.key === 'flux-schnell:text-to-image'
    );
    if (!entry) throw new Error('Missing Flux Schnell registry fixture.');
    expect(entry.fields).toContainEqual(
      expect.objectContaining({ key: 'dimensions', kind: 'dimensions' })
    );
    const item = createBatchItem(
      {
        modality: 'image',
        displayName: entry.displayName,
        sizeMode: 'custom',
        automaticFields: [],
        request: {
          ...request,
          entryKey: entry.key,
          values: { prompt: 'custom', width: 1024, height: 1024 }
        }
      },
      { itemId: 'item-1', actionId: request.actionId, now: '2026-07-17T00:00:00.000Z' }
    );

    expect(batchItemCompatibilityIssues(item, entry)).toEqual([]);
    expect(restoreBatchItemForRegistry(item, entry)).toMatchObject({
      state: 'draft',
      error: null,
      request: { values: { width: 1024, height: 1024 } }
    });

    const withoutDimensions = {
      ...entry,
      fields: entry.fields.filter((field) => field.kind !== 'dimensions')
    };
    expect(batchItemCompatibilityIssues(item, withoutDimensions)).toEqual(
      expect.arrayContaining([
        'The saved width option is no longer supported.',
        'The saved height option is no longer supported.'
      ])
    );
  });

  test('BATCH-08 preserves allowed Expert overrides and paid ambiguity across registry drift', () => {
    const entry = IMAGE_REGISTRY.entries.find(
      (candidate) => candidate.key === 'seedream-5.0-pro:text-to-image'
    );
    if (!entry) throw new Error('Missing Seedream registry fixture.');
    const item = createBatchItem(
      {
        modality: 'image',
        displayName: entry.displayName,
        sizeMode: 'aspect-ratio',
        automaticFields: ['aspectRatio'],
        request: {
          ...request,
          expertOverrides: [{ key: 'future_parameter', value: 'kept' }]
        }
      },
      { itemId: 'item-1', actionId: request.actionId, now: '2026-07-17T00:00:00.000Z' }
    );
    expect(batchItemCompatibilityIssues(item, entry)).toEqual([]);
    expect(
      batchItemCompatibilityIssues(
        {
          ...item,
          request: { ...item.request, expertOverrides: [{ key: 'api_key', value: 'blocked' }] }
        },
        entry
      )
    ).toContain('The saved Expert api_key override is no longer supported.');

    expect(restoreBatchItemForRegistry({ ...item, state: 'submitting' }, undefined)).toMatchObject({
      state: 'unknown',
      request: { actionId: request.actionId }
    });
    expect(
      restoreBatchItemForRegistry(
        { ...item, state: 'unknown', error: 'Reconcile this paid action.' },
        { ...entry, fields: [] }
      )
    ).toMatchObject({ state: 'unknown', error: 'Reconcile this paid action.' });
  });
});
