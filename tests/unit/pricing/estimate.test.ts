import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  PRICING_SIGNATURE_VERSION,
  type PricingWorkflow,
  PUBLIC_PRICING_SNAPSHOT_VERSION,
  type PublishedPricingSnapshot,
  type PublishedPricingTier,
  type TaskCharge
} from '../../../src/lib/features/pricing/contracts';
import {
  boundedObservedMedian,
  buildPricingSignature,
  estimateObservedMedian,
  estimatePublishedCredits,
  isPricingSignature,
  OBSERVED_MEDIAN_MAX_SAMPLES,
  type ObservedChargeSample
} from '../../../src/lib/features/pricing/estimate';
import {
  estimateNormalizedRegistryRequest,
  estimateNormalizedRegistryRequestWithEnvelope
} from '../../../src/lib/server/pricing/estimate-request';

interface SupportedFixture {
  tierSignature: string;
  mediaKind: 'image' | 'video';
  dimensions: PublishedPricingTier['dimensions'];
  unit: PublishedPricingTier['unit'];
  creditsPerUnit: number;
  estimateSignature: string;
  registryVersion: string;
  modelId: string;
  workflow: PricingWorkflow;
  normalizedInput: Record<string, unknown>;
  expectedCredits: number;
}

const supported = JSON.parse(
  readFileSync(join(import.meta.dir, '../../fixtures/pricing/supported-signatures.json'), 'utf8')
) as SupportedFixture[];

function tier(fixture: SupportedFixture): PublishedPricingTier {
  return {
    signature: fixture.tierSignature,
    registryVersion: fixture.registryVersion,
    modelId: fixture.modelId,
    mediaKind: fixture.mediaKind,
    workflow: fixture.workflow,
    dimensions: fixture.dimensions,
    unit: fixture.unit,
    creditsPerUnit: fixture.creditsPerUnit
  };
}

function supportedFixture(predicate: (fixture: SupportedFixture) => boolean): SupportedFixture {
  const fixture = supported.find(predicate);
  if (!fixture) throw new Error('Reviewed pricing fixture missing.');
  return fixture;
}

function snapshot(tiers = supported.map(tier), expiresAt = '2026-07-21T00:00:00.000Z') {
  return {
    version: PUBLIC_PRICING_SNAPSHOT_VERSION,
    signatureVersion: PRICING_SIGNATURE_VERSION,
    pricingHash: 'a'.repeat(64),
    registryVersions: { image: 'image-2026-07-20.1', video: 'video-2026-07-20.1' },
    source: {
      kind: 'published',
      url: 'https://poyo.ai/pricing',
      verifiedAt: '2026-07-20T00:00:00.000Z',
      expiresAt
    },
    tiers
  } satisfies PublishedPricingSnapshot;
}

function charge(credits: number, settledAt: string): TaskCharge {
  return {
    classification: 'task-charge',
    credits,
    source: 'poyo-task',
    terminalStatus: 'finished',
    settledAt
  };
}

describe('browser-safe published pricing estimates', () => {
  test('builds deterministic signatures from only bounded billing dimensions', () => {
    const first = buildPricingSignature({
      registryVersion: 'video-v1',
      modelId: 'model/one',
      workflow: 'image-to-video',
      dimensions: { resolution: '720P', duration: 5, hasAudio: false },
      unit: 'per-second'
    });
    const second = buildPricingSignature({
      registryVersion: 'video-v1',
      modelId: 'model/one',
      workflow: 'image-to-video',
      dimensions: { hasAudio: false, duration: 5, resolution: '720p' },
      unit: 'per-second'
    });
    expect(first).toBe(second);
    expect(first).toContain('model=model%2Fone');
    expect(first).not.toContain('prompt');
    expect(first).not.toContain('image_url');
    expect(isPricingSignature(first)).toBe(true);
    expect(isPricingSignature('prompt=secret')).toBe(false);
    expect(isPricingSignature(`${first}|quantity=1|quantity=2`)).toBe(false);
    expect(isPricingSignature(first.replace('model%2Fone', 'model%2fone'))).toBe(false);
  });

  test.each(supported)(
    'calculates the reviewed supported signature $estimateSignature',
    (fixture) => {
      const estimate = estimatePublishedCredits({
        snapshot: snapshot([tier(fixture)]),
        registryVersion: fixture.registryVersion,
        modelId: fixture.modelId,
        workflow: fixture.workflow,
        normalizedInput: fixture.normalizedInput,
        now: Date.parse('2026-07-20T12:00:00.000Z')
      });
      expect(estimate).toMatchObject({
        classification: 'estimate',
        credits: fixture.expectedCredits,
        signature: fixture.estimateSignature,
        provenance: 'published',
        freshness: 'fresh',
        availability: 'available'
      });
    }
  );

  test('returns stale unavailable for missing, unknown, incomplete, or ambiguous tiers', () => {
    const base = supportedFixture(
      (fixture) =>
        fixture.modelId === 'wan2.7-image-to-video' && fixture.dimensions.resolution === '720p'
    );
    const duplicate = { ...tier(base), creditsPerUnit: 99 };
    const cases = [
      { tiers: [], modelId: base.modelId, input: base.normalizedInput },
      { tiers: [tier(base)], modelId: 'unknown', input: base.normalizedInput },
      { tiers: [tier(base)], modelId: base.modelId, input: { resolution: '720p' } },
      { tiers: [tier(base), duplicate], modelId: base.modelId, input: base.normalizedInput }
    ];
    for (const value of cases) {
      expect(
        estimatePublishedCredits({
          snapshot: snapshot(value.tiers, '2026-07-19T00:00:00.000Z'),
          registryVersion: base.registryVersion,
          modelId: value.modelId,
          workflow: base.workflow,
          normalizedInput: value.input,
          now: Date.parse('2026-07-20T00:00:00.000Z')
        })
      ).toMatchObject({
        classification: 'estimate',
        credits: null,
        freshness: 'stale',
        availability: 'unavailable'
      });
    }
  });

  test('applies request quantity to per-output and per-second billable units', () => {
    const image = supportedFixture(
      (fixture) => fixture.modelId === 'seedream-5.0-pro' && fixture.workflow === 'text-to-image'
    );
    const video = supportedFixture(
      (fixture) =>
        fixture.modelId === 'wan2.7-image-to-video' && fixture.dimensions.resolution === '720p'
    );
    expect(
      estimatePublishedCredits({
        snapshot: snapshot(),
        registryVersion: image.registryVersion,
        modelId: image.modelId,
        workflow: image.workflow,
        normalizedInput: image.normalizedInput,
        quantity: 3
      })
    ).toMatchObject({ credits: 45, basis: { units: 3 } });
    expect(
      estimatePublishedCredits({
        snapshot: snapshot(),
        registryVersion: video.registryVersion,
        modelId: video.modelId,
        workflow: video.workflow,
        normalizedInput: video.normalizedInput,
        quantity: 2
      })
    ).toMatchObject({ credits: 120, basis: { units: 10 } });
  });

  test('estimates current WAN image-to-video and frame-to-video entries without pricing retired keys', () => {
    expect(
      estimateNormalizedRegistryRequest({
        snapshot: snapshot(),
        entryKey: 'wan2.7-image-to-video:image-to-video',
        normalizedRequest: {
          model: 'wan2.7-image-to-video',
          input: { duration: 5, resolution: '720p', prompt: 'not part of pricing' }
        },
        now: Date.parse('2026-07-20T12:00:00.000Z')
      })
    ).toMatchObject({
      credits: 60,
      signature:
        'version=pricing-signature-v1|registry=video-2026-07-20.1|model=wan2.7-image-to-video|workflow=image-to-video|unit=per-second|duration=5|resolution=720p',
      availability: 'available'
    });
    expect(
      estimateNormalizedRegistryRequest({
        snapshot: snapshot(),
        entryKey: 'wan2.2-image-to-video-fast:frame-to-video',
        normalizedRequest: {
          model: 'wan2.2-image-to-video-fast',
          input: { resolution: '720p', prompt: 'not part of pricing' }
        },
        now: Date.parse('2026-07-20T12:00:00.000Z')
      })
    ).toMatchObject({
      credits: 12,
      signature:
        'version=pricing-signature-v1|registry=video-2026-07-20.1|model=wan2.2-image-to-video-fast|workflow=frame-to-video|unit=per-output|quantity=1|resolution=720p',
      availability: 'available'
    });
    expect(
      estimateNormalizedRegistryRequest({
        snapshot: snapshot(),
        entryKey: 'wan2.7-image-to-video:frame-to-video',
        normalizedRequest: {
          model: 'wan2.7-image-to-video',
          input: { duration: 5, resolution: '720p' }
        }
      })
    ).toMatchObject({ credits: null, signature: null, availability: 'unavailable' });
    expect(
      estimateNormalizedRegistryRequest({
        snapshot: snapshot(),
        entryKey: 'wan2.7-image-to-video:image-to-video',
        normalizedRequest: { model: 'client-tampered-model', input: { duration: 5 } }
      })
    ).toMatchObject({ credits: null, availability: 'unavailable' });
  });

  test('does not treat excluded registry entries as pricing targets', () => {
    const result = estimateNormalizedRegistryRequestWithEnvelope({
      snapshot: snapshot(),
      entryKey: 'kling-avatar-2.0/standard:avatar-video',
      normalizedRequest: {
        model: 'kling-avatar-2.0/standard',
        input: {}
      },
      now: Date.parse('2026-07-20T12:00:00.000Z')
    });

    expect(result.estimate).toMatchObject({
      credits: null,
      signature: null,
      availability: 'unavailable'
    });
    expect(result.envelope.registryVersion).toBeNull();
  });

  test('recomputes when normalized duration, resolution, workflow input, or quantity changes', () => {
    const value = (entryKey: string, model: string, input: Record<string, unknown>) =>
      estimateNormalizedRegistryRequest({
        snapshot: snapshot(),
        entryKey,
        normalizedRequest: { model, input },
        now: Date.parse('2026-07-20T12:00:00.000Z')
      }).credits;
    expect(
      value('wan2.7-image-to-video:image-to-video', 'wan2.7-image-to-video', {
        duration: 5,
        resolution: '720p'
      })
    ).toBe(60);
    expect(
      value('wan2.7-image-to-video:image-to-video', 'wan2.7-image-to-video', {
        duration: 10,
        resolution: '720p'
      })
    ).toBe(120);
    expect(
      value('wan2.7-image-to-video:image-to-video', 'wan2.7-image-to-video', {
        duration: 5,
        resolution: '1080p'
      })
    ).toBe(90);
    expect(value('seedream-5.0-pro:text-to-image', 'seedream-5.0-pro', { n: 2 })).toBe(30);
    expect(value('seedream-5.0-pro:text-to-image', 'seedream-5.0-pro', { n: 3 })).toBe(45);
    expect(value('seedream-5.0-pro-edit:image-edit', 'seedream-5.0-pro-edit', { n: 2 })).toBe(30);
  });

  test('keeps a stale last-known-good estimate available without blocking validation', () => {
    const fixture = supportedFixture(
      (candidate) =>
        candidate.modelId === 'wan2.7-image-to-video' && candidate.dimensions.resolution === '720p'
    );
    expect(
      estimatePublishedCredits({
        snapshot: snapshot([tier(fixture)], '2026-07-19T00:00:00.000Z'),
        registryVersion: fixture.registryVersion,
        modelId: fixture.modelId,
        workflow: fixture.workflow,
        normalizedInput: fixture.normalizedInput,
        now: Date.parse('2026-07-20T00:00:00.000Z')
      })
    ).toMatchObject({ credits: 60, freshness: 'stale', availability: 'available' });
  });
});

describe('bounded observed task-charge median', () => {
  const group = {
    signature: 'estimate-signature',
    signatureVersion: PRICING_SIGNATURE_VERSION,
    registryVersion: 'video-v1',
    pricingHash: 'b'.repeat(64)
  };

  function sample(index: number, credits = index): ObservedChargeSample {
    const observedAt = new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString();
    return { ...group, observedAt, charge: charge(credits, observedAt) };
  }

  test('requires the exact invalidation group and minimum terminal sample count', () => {
    expect(boundedObservedMedian([sample(1), sample(2)], group)).toBeNull();
    expect(boundedObservedMedian([sample(1), sample(2), sample(3)], group)).toBe(2);
    expect(
      boundedObservedMedian(
        [sample(1), sample(2), { ...sample(100), pricingHash: 'c'.repeat(64) }],
        group
      )
    ).toBeNull();
    const nonterminal = {
      ...sample(3),
      charge: { ...sample(3).charge, terminalStatus: 'running' }
    } as unknown as ObservedChargeSample;
    expect(boundedObservedMedian([sample(1), sample(2), nonterminal], group)).toBeNull();
  });

  test('uses only the bounded most-recent window and supports even medians', () => {
    const samples = Array.from({ length: 30 }, (_, index) => sample(index));
    expect(OBSERVED_MEDIAN_MAX_SAMPLES).toBe(25);
    expect(boundedObservedMedian(samples, group)).toBe(17);
    expect(boundedObservedMedian([sample(1), sample(2), sample(3), sample(4)], group)).toBe(2.5);
  });

  test('keeps an observed median classified as an estimate without changing freshness', () => {
    const baseFixture = supportedFixture(
      (fixture) => fixture.modelId === 'seedream-5.0-pro' && fixture.workflow === 'text-to-image'
    );
    const published = estimatePublishedCredits({
      snapshot: snapshot(),
      registryVersion: baseFixture.registryVersion,
      modelId: baseFixture.modelId,
      workflow: baseFixture.workflow,
      normalizedInput: baseFixture.normalizedInput,
      now: Date.parse('2026-07-20T12:00:00.000Z')
    });
    const observedGroup = { ...group, signature: published.signature ?? '' };
    const observed = estimateObservedMedian(
      published,
      [sample(1, 14), sample(2, 16), sample(3, 18)].map((value) => ({
        ...value,
        signature: observedGroup.signature
      })),
      observedGroup
    );
    expect(observed).toMatchObject({
      classification: 'estimate',
      credits: 16,
      provenance: 'observed',
      freshness: 'fresh',
      availability: 'available'
    });
  });
});
