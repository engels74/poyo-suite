import { afterEach, describe, expect, test } from 'bun:test';
import {
  type EstimateEnvelope,
  PRICING_SIGNATURE_VERSION
} from '../../../src/lib/features/pricing/contracts';
import { buildPricingSignature } from '../../../src/lib/features/pricing/estimate';
import { IMAGE_REGISTRY_VERSION } from '../../../src/lib/features/registry/image-registry';
import { latestBalance } from '../../../src/lib/server/account/balance';
import { initialJobEvents, safeJobDto } from '../../../src/lib/server/jobs/events';
import type { JobRepository } from '../../../src/lib/server/jobs/repository';
import { seedImageRegistry } from '../../../src/lib/server/registry/repository';
import { createJobFixture } from '../../helpers/job-fixture';

const cleanups: Array<() => Promise<void>> = [];
const registryVersion = IMAGE_REGISTRY_VERSION;
const signature = buildPricingSignature({
  registryVersion,
  modelId: 'seedream-5.0-pro',
  workflow: 'text-to-image',
  unit: 'per-output',
  dimensions: { quantity: 1 }
});
const pricingHash = 'a'.repeat(64);

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

function estimateEnvelope(credits: number, hash = pricingHash): EstimateEnvelope {
  return {
    signatureVersion: PRICING_SIGNATURE_VERSION,
    signature,
    registryVersion,
    pricingHash: hash,
    basis: { unit: 'per-output', creditsPerUnit: credits, units: 1 },
    provenance: 'published',
    sourceVerifiedAt: '2026-07-20T00:00:00.000Z',
    credits
  };
}

function createPricedJob(
  repository: JobRepository,
  suffix: string,
  options: {
    actionId?: string;
    credits?: number | null;
    envelope?: EstimateEnvelope | null;
    retryOfJobId?: string;
  } = {}
) {
  const credits = options.credits === undefined ? 8 : options.credits;
  const actionId = options.actionId ?? crypto.randomUUID();
  return repository.create({
    actionId,
    entryKey: 'seedream-5.0-pro:text-to-image',
    workflow: 'text-to-image',
    publicModelId: 'seedream-5.0-pro',
    guidedRequest: { prompt: `priced ${suffix}`, n: 1 },
    normalizedPayload: { model: 'seedream-5.0-pro', input: { prompt: `priced ${suffix}`, n: 1 } },
    ...(credits === null ? {} : { estimatedCredits: credits }),
    ...(credits !== null && options.envelope !== null
      ? { estimateEnvelope: options.envelope ?? estimateEnvelope(credits) }
      : {}),
    ...(options.retryOfJobId ? { retryOfJobId: options.retryOfJobId } : {})
  });
}

function claim(repository: JobRepository, jobId: string) {
  const submission = repository.claimSubmission(jobId, 'cost-integration', 60_000);
  if (!submission) throw new Error('Expected a submission claim.');
  return submission;
}

function acknowledge(repository: JobRepository, jobId: string, suffix: string): void {
  const submission = claim(repository, jobId);
  expect(repository.markSubmissionTransmitted(jobId, submission.token)).toBe(true);
  expect(
    repository.acknowledgeSubmission(jobId, submission.token, {
      taskId: `task-${suffix}`,
      statusRaw: 'not_started',
      status: 'not_started',
      createdTime: '2026-07-20T00:00:00.000Z'
    })
  ).toBe(true);
}

function terminal(
  repository: JobRepository,
  jobId: string,
  suffix: string,
  credits: number | null,
  raw: 'failed' | 'cancelled' = 'failed'
): void {
  repository.applyStatus(
    jobId,
    {
      taskId: `task-${suffix}`,
      statusRaw: raw,
      status: 'failed',
      creditsAmount: credits,
      files: [],
      createdTime: '2026-07-20T00:00:00.000Z',
      progress: 100,
      errorMessage: raw === 'cancelled' ? 'cancelled' : 'provider failure'
    },
    1_000
  );
}

function group() {
  return {
    signature,
    signatureVersion: PRICING_SIGNATURE_VERSION,
    registryVersion,
    pricingHash
  };
}

function recordBalance(
  repository: JobRepository,
  jobId: string,
  phase: 'before' | 'after',
  credits: number,
  email = 'studio@example.test'
): void {
  const actionId = repository.paidActionId(jobId);
  if (!actionId) throw new Error('Expected a paid action ID.');
  expect(repository.beginCostBalanceSample(jobId, actionId, phase)).toBe(true);
  expect(
    repository.recordCostBalanceSample(jobId, actionId, phase, {
      email,
      creditsAmount: credits,
      fetchedAt: '2026-07-20T00:00:00.000Z'
    })
  ).toBe(true);
}

describe('production observed-cost persistence', () => {
  test('accepts only exact terminal task charges, including cancellation, in the recent window', async () => {
    const fixture = await createJobFixture();
    cleanups.push(fixture.cleanup);
    seedImageRegistry(fixture.database);

    for (let index = 0; index < 30; index += 1) {
      fixture.setNow(new Date(Date.UTC(2026, 6, 20, 0, index, 0)));
      const job = createPricedJob(fixture.repository, `recent-${index}`);
      acknowledge(fixture.repository, job.id, `recent-${index}`);
      terminal(
        fixture.repository,
        job.id,
        `recent-${index}`,
        index,
        index === 29 ? 'cancelled' : 'failed'
      );
    }

    const samples = fixture.repository.observedChargeSamples(group());
    expect(samples).toHaveLength(25);
    expect(samples.map((sample) => sample.charge.credits).sort((a, b) => a - b)).toEqual(
      Array.from({ length: 25 }, (_, index) => index + 5)
    );
    expect(samples[0]?.charge).toMatchObject({
      credits: 29,
      terminalStatus: 'cancelled',
      source: 'poyo-task'
    });
  });

  test('invalidates mismatched or corrupt envelopes and never learns a nonterminal or null charge', async () => {
    const fixture = await createJobFixture();
    cleanups.push(fixture.cleanup);
    seedImageRegistry(fixture.database);

    const valid = createPricedJob(fixture.repository, 'valid');
    acknowledge(fixture.repository, valid.id, 'valid');
    terminal(fixture.repository, valid.id, 'valid', 7);

    const corruptions: Array<[string, (estimate: Record<string, unknown>) => void]> = [
      ['signature', (estimate) => (estimate.signature = `${signature}|other=true`)],
      ['signature-version', (estimate) => (estimate.signatureVersion = 'pricing-signature-v0')],
      ['registry-version', (estimate) => (estimate.registryVersion = 'image-other')],
      ['pricing-hash', (estimate) => (estimate.pricingHash = 'b'.repeat(64))]
    ];
    for (const [suffix, mutate] of corruptions) {
      const job = createPricedJob(fixture.repository, suffix);
      acknowledge(fixture.repository, job.id, suffix);
      terminal(fixture.repository, job.id, suffix, 100);
      const row = fixture.database
        .query<{ event_id: number; safe_payload_json: string }, [string]>(
          "SELECT event_id,safe_payload_json FROM job_events WHERE job_id=? AND event_type='job.created'"
        )
        .get(job.id);
      if (!row) throw new Error('Expected a created event.');
      const payload = JSON.parse(row.safe_payload_json) as { estimate: Record<string, unknown> };
      mutate(payload.estimate);
      fixture.database
        .query('UPDATE job_events SET safe_payload_json=? WHERE event_id=?')
        .run(JSON.stringify(payload), row.event_id);
    }

    for (let index = 0; index < 25; index += 1) {
      fixture.setNow(new Date(Date.UTC(2026, 6, 20, 0, index + 1, 0)));
      const job = createPricedJob(fixture.repository, `invalid-basis-${index}`);
      acknowledge(fixture.repository, job.id, `invalid-basis-${index}`);
      terminal(fixture.repository, job.id, `invalid-basis-${index}`, 200 + index);
      const row = fixture.database
        .query<{ event_id: number; safe_payload_json: string }, [string]>(
          "SELECT event_id,safe_payload_json FROM job_events WHERE job_id=? AND event_type='job.created'"
        )
        .get(job.id);
      if (!row) throw new Error('Expected a created event.');
      const payload = JSON.parse(row.safe_payload_json) as {
        estimate: { basis: { units: number } };
      };
      payload.estimate.basis.units = 0;
      fixture.database
        .query('UPDATE job_events SET safe_payload_json=? WHERE event_id=?')
        .run(JSON.stringify(payload), row.event_id);
    }

    const missingEnvelope = createPricedJob(fixture.repository, 'missing-envelope', {
      envelope: null
    });
    acknowledge(fixture.repository, missingEnvelope.id, 'missing-envelope');
    terminal(fixture.repository, missingEnvelope.id, 'missing-envelope', 101);

    const running = createPricedJob(fixture.repository, 'running');
    acknowledge(fixture.repository, running.id, 'running');
    fixture.repository.applyStatus(
      running.id,
      {
        taskId: 'task-running',
        statusRaw: 'running',
        status: 'running',
        creditsAmount: 102,
        files: [],
        createdTime: '2026-07-20T00:00:00.000Z',
        progress: 50,
        errorMessage: null
      },
      1_000
    );

    const nullCharge = createPricedJob(fixture.repository, 'null-charge');
    acknowledge(fixture.repository, nullCharge.id, 'null-charge');
    terminal(fixture.repository, nullCharge.id, 'null-charge', null);

    const balanceOnly = createPricedJob(fixture.repository, 'balance-only');
    acknowledge(fixture.repository, balanceOnly.id, 'balance-only');
    fixture.setNow(new Date('2026-07-20T01:00:00.000Z'));
    recordBalance(fixture.repository, balanceOnly.id, 'before', 50);
    fixture.setNow(new Date('2026-07-20T01:01:00.000Z'));
    terminal(fixture.repository, balanceOnly.id, 'balance-only', null);
    fixture.setNow(new Date('2026-07-20T01:02:00.000Z'));
    recordBalance(fixture.repository, balanceOnly.id, 'after', 46);

    expect(fixture.repository.observedChargeSamples(group())).toEqual([
      expect.objectContaining({ charge: expect.objectContaining({ credits: 7 }) })
    ]);
    expect(fixture.repository.get(balanceOnly.id)?.actualCredits).toBeNull();
    expect(fixture.repository.taskCharge(balanceOnly.id)).toBeNull();
    expect(fixture.repository.balanceCorroboration(balanceOnly.id)).toEqual({
      status: 'ambiguous',
      reason: 'terminal_charge_missing'
    });
  });
});

describe('strict balance corroboration', () => {
  async function setupCase(
    variant:
      | 'clean'
      | 'failed'
      | 'missing'
      | 'count'
      | 'account'
      | 'order'
      | 'terminal-missing'
      | 'terminal-outside'
      | 'event-order'
      | 'charge'
      | 'unknown'
      | 'retry'
      | 'dispatch'
      | 'unrelated'
      | 'overlap'
      | 'overlap-unknown'
      | 'overlap-terminal'
  ) {
    const fixture = await createJobFixture();
    cleanups.push(fixture.cleanup);
    seedImageRegistry(fixture.database);
    const parent = variant === 'retry' ? createPricedJob(fixture.repository, 'retry-parent') : null;
    const job = createPricedJob(fixture.repository, variant, {
      ...(parent ? { retryOfJobId: parent.id } : {})
    });

    fixture.setNow(new Date('2026-07-20T00:01:00.000Z'));
    if (variant === 'unknown') {
      const submission = claim(fixture.repository, job.id);
      expect(fixture.repository.markSubmissionTransmitted(job.id, submission.token)).toBe(true);
      fixture.repository.markSubmissionUnknown(job.id, submission.token, 'socket_drop');
    } else {
      acknowledge(fixture.repository, job.id, variant);
    }

    if (variant === 'failed') {
      const actionId = fixture.repository.paidActionId(job.id);
      if (!actionId) throw new Error('Expected a paid action ID.');
      expect(fixture.repository.beginCostBalanceSample(job.id, actionId, 'before')).toBe(true);
      expect(fixture.repository.recordCostBalanceFailure(job.id, actionId, 'before')).toBe(true);
      return { fixture, job };
    }

    if (variant === 'event-order') {
      fixture.setNow(new Date('2026-07-20T00:02:00.000Z'));
      terminal(fixture.repository, job.id, variant, 4);
      recordBalance(fixture.repository, job.id, 'before', 100);
      recordBalance(fixture.repository, job.id, 'after', 96);
      return { fixture, job };
    }

    fixture.setNow(
      new Date(variant === 'order' ? '2026-07-20T00:05:00.000Z' : '2026-07-20T00:02:00.000Z')
    );
    recordBalance(fixture.repository, job.id, 'before', 100);

    if (variant === 'missing') return { fixture, job };
    if (variant === 'terminal-outside') {
      fixture.setNow(new Date('2026-07-20T00:03:00.000Z'));
      recordBalance(fixture.repository, job.id, 'after', 96);
      fixture.setNow(new Date('2026-07-20T00:04:00.000Z'));
      terminal(fixture.repository, job.id, variant, 4);
      return { fixture, job };
    }

    if (variant === 'overlap' || variant === 'overlap-unknown' || variant === 'overlap-terminal') {
      fixture.setNow(new Date('2026-07-20T00:02:30.000Z'));
      const other = createPricedJob(fixture.repository, 'overlap-other');
      if (variant === 'overlap') {
        acknowledge(fixture.repository, other.id, 'overlap-other');
      } else {
        const otherClaim = claim(fixture.repository, other.id);
        if (variant === 'overlap-unknown') {
          fixture.repository.markSubmissionUnknown(other.id, otherClaim.token, 'claim_expired');
        } else {
          terminal(fixture.repository, other.id, 'overlap-other', 2);
        }
      }
    }

    if (variant !== 'terminal-missing') {
      fixture.setNow(new Date('2026-07-20T00:03:00.000Z'));
      terminal(fixture.repository, job.id, variant, 4);
    }
    if (variant === 'unrelated') {
      fixture.setNow(new Date('2026-07-20T00:03:30.000Z'));
      fixture.repository.recordBalance('studio@example.test', 99, 'manual');
    }

    fixture.setNow(
      new Date(variant === 'order' ? '2026-07-20T00:04:00.000Z' : '2026-07-20T00:04:00.000Z')
    );
    recordBalance(
      fixture.repository,
      job.id,
      'after',
      variant === 'charge' ? 95 : 96,
      variant === 'account' ? 'other@example.test' : 'studio@example.test'
    );

    const actionId = fixture.repository.paidActionId(job.id);
    if (!actionId) throw new Error('Expected a paid action ID.');
    if (variant === 'count') {
      fixture.database
        .query('INSERT INTO balance_snapshots(email,credits,source,fetched_at) VALUES (?,?,?,?)')
        .run(
          'studio@example.test',
          96,
          `cost:v1:after:${job.id}:${actionId}`,
          '2026-07-20T00:04:30.000Z'
        );
    }
    if (variant === 'dispatch') {
      fixture.database
        .query("DELETE FROM job_events WHERE job_id=? AND event_type='submission.transmitted'")
        .run(job.id);
    }
    return { fixture, job };
  }

  test('accepts only one isolated matching bracket and explains every ambiguity', async () => {
    const cases = [
      ['clean', { status: 'corroborated', reason: null }],
      ['failed', { status: 'ambiguous', reason: 'snapshot_failed' }],
      ['missing', { status: 'unavailable', reason: null }],
      ['count', { status: 'ambiguous', reason: 'snapshot_count' }],
      ['account', { status: 'ambiguous', reason: 'account_mismatch' }],
      ['order', { status: 'ambiguous', reason: 'snapshot_order' }],
      ['terminal-missing', { status: 'ambiguous', reason: 'terminal_charge_missing' }],
      ['terminal-outside', { status: 'ambiguous', reason: 'terminal_outside_bracket' }],
      ['event-order', { status: 'ambiguous', reason: 'terminal_outside_bracket' }],
      ['charge', { status: 'ambiguous', reason: 'charge_mismatch' }],
      ['unknown', { status: 'ambiguous', reason: 'unknown_intent' }],
      ['retry', { status: 'ambiguous', reason: 'retry' }],
      ['dispatch', { status: 'ambiguous', reason: 'dispatch_count' }],
      ['unrelated', { status: 'ambiguous', reason: 'unrelated_snapshot' }],
      ['overlap', { status: 'ambiguous', reason: 'overlapping_paid_action' }],
      ['overlap-unknown', { status: 'ambiguous', reason: 'overlapping_paid_action' }],
      ['overlap-terminal', { status: 'ambiguous', reason: 'overlapping_paid_action' }]
    ] as const;

    for (const [variant, expected] of cases) {
      const { fixture, job } = await setupCase(variant);
      expect(fixture.repository.balanceCorroboration(job.id)).toEqual(expected);
      expect(fixture.repository.taskCharge(job.id)?.credits ?? null).toBe(
        variant === 'failed' || variant === 'missing' || variant === 'terminal-missing' ? null : 4
      );
    }
  });
});

describe('outstanding paid-action projection and safe delivery', () => {
  test('counts every charge-risk action once across dedupe, retry, unknown and terminal-null states', async () => {
    const fixture = await createJobFixture();
    cleanups.push(fixture.cleanup);
    seedImageRegistry(fixture.database);

    const preparedAction = crypto.randomUUID();
    const prepared = createPricedJob(fixture.repository, 'prepared-dedupe', {
      actionId: preparedAction,
      credits: 1
    });
    const duplicate = createPricedJob(fixture.repository, 'prepared-dedupe', {
      actionId: preparedAction,
      credits: 1
    });
    expect(duplicate.id).toBe(prepared.id);

    const sending = createPricedJob(fixture.repository, 'sending', { credits: 2 });
    claim(fixture.repository, sending.id);

    const acknowledged = createPricedJob(fixture.repository, 'acknowledged', { credits: 3 });
    acknowledge(fixture.repository, acknowledged.id, 'acknowledged');

    const unknown = createPricedJob(fixture.repository, 'unknown-retry', { credits: 4 });
    const unknownClaim = claim(fixture.repository, unknown.id);
    expect(fixture.repository.markSubmissionTransmitted(unknown.id, unknownClaim.token)).toBe(true);
    fixture.repository.markSubmissionUnknown(unknown.id, unknownClaim.token, 'socket_drop');
    const retry = await fixture.repository.retryAmbiguous(
      unknown.id,
      crypto.randomUUID(),
      async () => {
        throw new Error('No managed sources should be refreshed.');
      }
    );

    const transmittedRejected = createPricedJob(fixture.repository, 'transmitted-rejected', {
      credits: 5
    });
    const transmittedClaim = claim(fixture.repository, transmittedRejected.id);
    expect(
      fixture.repository.markSubmissionTransmitted(transmittedRejected.id, transmittedClaim.token)
    ).toBe(true);
    fixture.repository.rejectSubmission(transmittedRejected.id, transmittedClaim.token, 'bad_ack');

    const preDispatchRejected = createPricedJob(fixture.repository, 'predispatch-rejected', {
      credits: 100
    });
    const rejectedClaim = claim(fixture.repository, preDispatchRejected.id);
    expect(
      fixture.repository.rejectUntransmittedPolicy(
        preDispatchRejected.id,
        rejectedClaim.token,
        'policy'
      )
    ).toBe(true);

    const terminalNull = createPricedJob(fixture.repository, 'terminal-null', { credits: 100 });
    acknowledge(fixture.repository, terminalNull.id, 'terminal-null');
    terminal(fixture.repository, terminalNull.id, 'terminal-null', null);

    const terminalZero = createPricedJob(fixture.repository, 'terminal-zero', { credits: 100 });
    acknowledge(fixture.repository, terminalZero.id, 'terminal-zero');
    terminal(fixture.repository, terminalZero.id, 'terminal-zero', 0);

    expect(retry.retryOfJobId).toBe(unknown.id);
    expect(fixture.repository.outstandingProjection()).toEqual({
      classification: 'estimate',
      credits: 19,
      actionCount: 6,
      availability: 'available'
    });

    const unavailable = createPricedJob(fixture.repository, 'unavailable', { credits: null });
    expect(fixture.repository.outstandingProjection()).toMatchObject({
      credits: null,
      actionCount: 7,
      availability: 'unavailable'
    });
    terminal(fixture.repository, unavailable.id, 'unavailable', null);
    expect(fixture.repository.outstandingProjection()).toMatchObject({
      credits: 19,
      actionCount: 6,
      availability: 'available'
    });

    const settled = createPricedJob(fixture.repository, 'late-nonterminal', { credits: 7 });
    acknowledge(fixture.repository, settled.id, 'late-nonterminal');
    terminal(fixture.repository, settled.id, 'late-nonterminal', 7);
    const settledCharge = fixture.repository.taskCharge(settled.id);
    fixture.repository.applyStatus(
      settled.id,
      {
        taskId: 'task-late-nonterminal',
        statusRaw: 'running',
        status: 'running',
        creditsAmount: 0,
        files: [],
        createdTime: '2026-07-20T00:00:00.000Z',
        progress: 50,
        errorMessage: null
      },
      1_000
    );
    expect(fixture.repository.taskCharge(settled.id)).toEqual(settledCharge);
    expect(fixture.repository.get(settled.id)?.remoteStatus).toBe('failed');
    expect(fixture.repository.outstandingProjection()).toMatchObject({
      credits: 19,
      actionCount: 6
    });
  });

  test('publishes exact charges only for terminal Poyo truth and omits private accounting inputs', async () => {
    const fixture = await createJobFixture();
    cleanups.push(fixture.cleanup);
    seedImageRegistry(fixture.database);
    const job = createPricedJob(fixture.repository, 'safe-delivery', { credits: 6 });
    acknowledge(fixture.repository, job.id, 'safe-delivery');
    fixture.repository.applyStatus(
      job.id,
      {
        taskId: 'task-safe-delivery',
        statusRaw: 'running',
        status: 'running',
        creditsAmount: 99,
        files: [],
        createdTime: '2026-07-20T00:00:00.000Z',
        progress: 50,
        errorMessage: null
      },
      1_000
    );
    expect(safeJobDto(fixture.repository.get(job.id) ?? job)).toMatchObject({
      actualCredits: 99,
      taskCharge: null
    });

    terminal(fixture.repository, job.id, 'safe-delivery', 6, 'cancelled');
    const dto = safeJobDto(fixture.repository.get(job.id) ?? job);
    expect(dto.taskCharge).toMatchObject({
      classification: 'task-charge',
      credits: 6,
      source: 'poyo-task',
      terminalStatus: 'cancelled'
    });
    expect(dto.taskCharge).toEqual(fixture.repository.taskCharge(job.id));
    expect(dto).not.toHaveProperty('guidedRequest');
    expect(dto).not.toHaveProperty('normalizedPayload');

    const encoded = new TextDecoder().decode(initialJobEvents(fixture.repository, null).chunks[0]);
    expect(encoded).toContain('"outstandingProjection"');
    expect(encoded).toContain('"taskCharge"');
    expect(encoded).not.toContain('priced safe-delivery');
    expect(encoded).not.toContain('studio@example.test');
    expect(encoded).not.toContain('cost:v1:');

    fixture.repository.recordBalance('studio@example.test', 50, 'manual');
    recordBalance(fixture.repository, job.id, 'before', 50);
    expect(latestBalance(fixture.database)).toEqual({
      email: 'studio@example.test',
      credits: 50,
      source: 'manual',
      fetchedAt: expect.any(String)
    });
  });
});
