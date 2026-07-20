import { afterEach, describe, expect, test } from 'bun:test';
import {
  createJobEventStream,
  decodeEventChunk,
  initialJobEvents
} from '../../../src/lib/server/jobs/events';
import { JOB_EVENT_METADATA_KEY } from '../../../src/lib/server/jobs/event-attention';
import { createJobFixture, createTestJob } from '../../helpers/job-fixture';
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});
describe('durable job SSE protocol', () => {
  test('JOB-08/INT-10 snapshots with a watermark then replays unseen durable IDs once', async () => {
    const fixture = await createJobFixture();
    cleanups.push(fixture.cleanup);
    const first = createTestJob(fixture.repository, 'event-1');
    const initial = initialJobEvents(fixture.repository, null);
    expect(initial.mode).toBe('snapshot');
    const snapshotChunk = initial.chunks[0];
    if (!snapshotChunk) throw new Error('snapshot missing');
    const snapshot = decodeEventChunk(snapshotChunk);
    expect(snapshot.event).toBe('snapshot');
    expect(snapshot.id).toBe(initial.cursor);
    fixture.repository.transition(first.id, 'submitting');
    const second = createTestJob(fixture.repository, 'event-2');
    const replay = initialJobEvents(fixture.repository, String(initial.cursor));
    const decoded = replay.chunks.map(decodeEventChunk);
    expect(replay.mode).toBe('replay');
    expect(decoded.map((event) => event.id)).toEqual([
      ...new Set(decoded.map((event) => event.id))
    ]);
    expect(decoded.every((event) => event.id > initial.cursor)).toBe(true);
    expect(decoded.some((event) => JSON.stringify(event.data).includes(second.id))).toBe(true);
  });
  test('SSE-01 invalid and compacted cursors fall back to a fresh SQLite snapshot', async () => {
    const fixture = await createJobFixture();
    cleanups.push(fixture.cleanup);
    createTestJob(fixture.repository, 'compact-1');
    createTestJob(fixture.repository, 'compact-2');
    fixture.database
      .query('DELETE FROM job_events WHERE event_id=(SELECT MIN(event_id) FROM job_events)')
      .run();
    for (const cursor of ['invalid', '0', '999999']) {
      const result = initialJobEvents(fixture.repository, cursor);
      expect(result.mode).toBe('snapshot');
      const chunk = result.chunks[0];
      if (!chunk) throw new Error('snapshot missing');
      const decoded = decodeEventChunk(chunk);
      expect(decoded.event).toBe('snapshot');
      expect(decoded.id).toBe(result.cursor);
      expect(JSON.stringify(decoded.data)).not.toContain('normalizedPayload');
    }
  });
  test('SSE-02 live delivery follows the durable database rather than process memory', async () => {
    const fixture = await createJobFixture();
    cleanups.push(fixture.cleanup);
    const controller = new AbortController();
    const reader = createJobEventStream(fixture.repository, null, controller.signal, 5).getReader();
    const initial = await reader.read();
    expect(decodeEventChunk(initial.value ?? new Uint8Array()).event).toBe('snapshot');
    const job = createTestJob(fixture.repository, 'live-event');
    const delivered = await reader.read();
    const event = decodeEventChunk(delivered.value ?? new Uint8Array());
    expect(event.event).toBe('job');
    expect(JSON.stringify(event.data)).toContain(job.id);
    controller.abort();
  });

  test('SSE-03 current cursors receive an immediate connection comment before new events', async () => {
    const fixture = await createJobFixture();
    cleanups.push(fixture.cleanup);
    const job = createTestJob(fixture.repository, 'current-cursor');
    const cursor = fixture.repository.eventBounds().max;
    const controller = new AbortController();
    const reader = createJobEventStream(
      fixture.repository,
      String(cursor),
      controller.signal,
      5
    ).getReader();

    const connected = await reader.read();
    expect(new TextDecoder().decode(connected.value)).toBe(': connected\n\n');

    fixture.repository.transition(job.id, 'submitting');
    const delivered = await reader.read();
    expect(decodeEventChunk(delivered.value ?? new Uint8Array()).event).toBe('job');
    controller.abort();
  });

  test('PERF-04 durable event replay is bounded and resumes from the returned cursor', async () => {
    const fixture = await createJobFixture();
    cleanups.push(fixture.cleanup);
    for (let index = 0; index < 520; index += 1) {
      createTestJob(fixture.repository, `bounded-${index}`);
    }

    const first = fixture.repository.eventsAfter(0);
    expect(first).toHaveLength(500);
    const cursor = first.at(-1)?.eventId;
    if (!cursor) throw new Error('Expected a replay cursor.');
    const remainder = fixture.repository.eventsAfter(cursor);
    expect(remainder).toHaveLength(20);
    expect(remainder.every((event) => event.eventId > cursor)).toBe(true);
  });

  test('policy snapshots and replay expose only the stable address-free discriminator', async () => {
    const fixture = await createJobFixture();
    cleanups.push(fixture.cleanup);
    const job = createTestJob(fixture.repository, 'policy-safe-event');
    const cursor = fixture.repository.eventBounds().max;
    const claim = fixture.repository.claimSubmission(job.id, 'policy-worker', 1_000);
    if (!claim) throw new Error('Expected submission claim.');
    expect(
      fixture.repository.rejectUntransmittedPolicy(job.id, claim.token, 'public_ipv4_guard_match')
    ).toBe(true);
    const misconfigured = createTestJob(fixture.repository, 'policy-safe-misconfigured');
    const misconfiguredClaim = fixture.repository.claimSubmission(
      misconfigured.id,
      'policy-worker',
      1_000
    );
    if (!misconfiguredClaim) throw new Error('Expected misconfigured submission claim.');
    expect(
      fixture.repository.rejectUntransmittedPolicy(
        misconfigured.id,
        misconfiguredClaim.token,
        'public_ipv4_guard_misconfigured'
      )
    ).toBe(true);
    const snapshot = initialJobEvents(fixture.repository, null);
    const snapshotText = new TextDecoder().decode(snapshot.chunks[0]);
    expect(snapshotText).toContain('ip_guard_blocked');
    expect(snapshotText).toContain('"ipGuardReason":"match"');
    expect(snapshotText).toContain('"ipGuardReason":"misconfigured"');
    expect(snapshotText).not.toContain('public_ipv4_guard_match');
    expect(snapshotText).not.toContain('public_ipv4_guard_misconfigured');
    const replay = initialJobEvents(fixture.repository, String(cursor));
    const replayText = replay.chunks.map((chunk) => new TextDecoder().decode(chunk)).join('\n');
    expect(replayText).toContain('ip_guard_blocked');
    expect(replayText).not.toContain('public_ipv4_guard_match');
    expect(replayText).not.toContain('public_ipv4_guard_misconfigured');
  });

  test('new replay events preserve explicit attention state and payload shape in durable order', async () => {
    const fixture = await createJobFixture();
    cleanups.push(fixture.cleanup);
    const job = createTestJob(fixture.repository, 'attention-state');
    const cursor = fixture.repository.eventBounds().max;

    fixture.repository.transition(
      job.id,
      'requires_attention',
      'submission',
      'submission_unknown',
      'submission.unknown'
    );
    fixture.repository.transition(
      job.id,
      'requires_attention',
      'remote_generation',
      'malformed_output_set',
      'output_set.malformed',
      { reason: 'missing_outputs', observedCount: 0 }
    );
    fixture.repository.transition(
      job.id,
      'requires_attention',
      'poll',
      'public_ipv4_guard_unavailable',
      'poll.policy_blocked',
      { code: 'public_ipv4_guard_unavailable', marker: { retained: true } }
    );
    fixture.repository.transition(job.id, 'monitoring', 'none', null, 'status.observed');

    const rawRows = fixture.database
      .query<{ safe_payload_json: string }, [string]>(
        "SELECT safe_payload_json FROM job_events WHERE job_id=? AND event_type='submission.unknown'"
      )
      .all(job.id);
    expect(rawRows).toHaveLength(1);
    expect(JSON.parse(rawRows[0]?.safe_payload_json ?? '{}')).toMatchObject({
      [JOB_EVENT_METADATA_KEY]: {
        version: 1,
        attentionCode: 'submission_unknown',
        payloadWasNull: true
      }
    });

    const replay = initialJobEvents(fixture.repository, String(cursor));
    const events = replay.chunks.map((chunk) => decodeEventChunk(chunk).data) as Array<
      Record<string, unknown>
    >;
    expect(events.map((event) => event.eventType)).toEqual([
      'submission.unknown',
      'output_set.malformed',
      'poll.policy_blocked',
      'status.observed'
    ]);
    expect(events[0]).toMatchObject({
      attentionCode: 'submission_unknown',
      ipGuardReason: null,
      payload: null
    });
    expect(events[1]).toMatchObject({
      attentionCode: 'malformed_output_set',
      ipGuardReason: null,
      payload: { reason: 'missing_outputs', observedCount: 0 }
    });
    expect(events[2]).toMatchObject({
      attentionCode: 'ip_guard_blocked',
      ipGuardReason: 'unavailable',
      payload: {
        marker: { retained: true },
        policy: 'ip_guard_blocked',
        reason: 'unavailable'
      }
    });
    expect(events[3]).toMatchObject({ attentionCode: null, ipGuardReason: null, payload: null });
    const replayText = replay.chunks.map((chunk) => new TextDecoder().decode(chunk)).join('\n');
    expect(replayText).not.toContain(JOB_EVENT_METADATA_KEY);
    expect(replayText).not.toContain('public_ipv4_guard_unavailable');
  });

  test('legacy and malformed metadata omit attention while stripping reserved and guard data', async () => {
    const fixture = await createJobFixture();
    cleanups.push(fixture.cleanup);
    const job = createTestJob(fixture.repository, 'legacy-attention');
    const cursor = fixture.repository.eventBounds().max;
    const observedAt = '2026-07-15T12:00:01.000Z';
    const insert = fixture.database.query(
      `INSERT INTO job_events(job_id,event_type,local_phase,remote_status_raw,remote_status,failure_domain,progress,safe_payload_json,observed_at)
       VALUES (?,?,?,?,?,?,?,?,?)`
    );
    insert.run(
      job.id,
      'legacy.event',
      job.localPhase,
      job.remoteStatusRaw,
      job.remoteStatus,
      job.failureDomain,
      job.progress,
      JSON.stringify({ marker: 'legacy' }),
      observedAt
    );
    insert.run(
      job.id,
      'malformed.metadata',
      job.localPhase,
      job.remoteStatusRaw,
      job.remoteStatus,
      job.failureDomain,
      job.progress,
      JSON.stringify({
        marker: 'malformed',
        code: 'public_ipv4_guard_match',
        [JOB_EVENT_METADATA_KEY]: { version: 1, attentionCode: 42, payloadWasNull: false }
      }),
      observedAt
    );

    const replay = initialJobEvents(fixture.repository, String(cursor));
    const events = replay.chunks.map((chunk) => decodeEventChunk(chunk).data) as Array<
      Record<string, unknown>
    >;
    expect(events).toHaveLength(2);
    expect(events[0]?.payload).toEqual({ marker: 'legacy' });
    expect(events[0]).not.toHaveProperty('attentionCode');
    expect(events[0]).not.toHaveProperty('ipGuardReason');
    expect(events[1]?.payload).toEqual({
      marker: 'malformed',
      policy: 'ip_guard_blocked',
      reason: 'match'
    });
    expect(events[1]).not.toHaveProperty('attentionCode');
    expect(events[1]).not.toHaveProperty('ipGuardReason');
    const replayText = replay.chunks.map((chunk) => new TextDecoder().decode(chunk)).join('\n');
    expect(replayText).not.toContain(JOB_EVENT_METADATA_KEY);
    expect(replayText).not.toContain('public_ipv4_guard_match');
  });

  test('stripping durable metadata preserves null, empty and non-reserved payloads', async () => {
    const fixture = await createJobFixture();
    cleanups.push(fixture.cleanup);
    const job = createTestJob(fixture.repository, 'payload-shape');
    fixture.repository.transition(
      job.id,
      'requires_attention',
      'submission',
      'submission_unknown',
      'payload.object',
      { marker: 'kept', nested: { count: 1 } }
    );
    fixture.repository.transition(
      job.id,
      'requires_attention',
      'submission',
      'submission_unknown',
      'payload.empty',
      {}
    );

    const replay = initialJobEvents(fixture.repository, '0');
    const events = replay.chunks.map((chunk) => decodeEventChunk(chunk).data) as Array<
      Record<string, unknown>
    >;
    expect(events.find((event) => event.eventType === 'job.created')?.payload).toMatchObject({
      estimate: { credits: null, signature: null, registryVersion: null, pricingHash: null }
    });
    expect(events.find((event) => event.eventType === 'payload.object')?.payload).toEqual({
      marker: 'kept',
      nested: { count: 1 }
    });
    expect(events.find((event) => event.eventType === 'payload.empty')?.payload).toEqual({});
  });
});
