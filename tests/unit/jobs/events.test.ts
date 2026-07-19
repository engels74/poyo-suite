import { afterEach, describe, expect, test } from 'bun:test';
import {
  createJobEventStream,
  decodeEventChunk,
  initialJobEvents
} from '../../../src/lib/server/jobs/events';
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
});
