import { safeJobEventAttention, sanitizeDurableJobEventPayload } from './event-attention';
import type { OutstandingSpendProjection } from '../../features/pricing/contracts';
import { taskChargeFromParts, type JobRepository } from './repository';
import type { JobRecord } from './types';

const encoder = new TextEncoder();
export function safeJobDto(job: JobRecord) {
  const attention = safeJobEventAttention(job.attentionCode);
  return {
    id: job.id,
    entryKey: job.entryKey,
    workflow: job.workflow,
    publicModelId: job.publicModelId,
    localPhase: job.localPhase,
    remoteStatusRaw: job.remoteStatusRaw,
    remoteStatus: job.remoteStatus,
    failureDomain: job.failureDomain,
    ...attention,
    poyoTaskId: job.poyoTaskId,
    progress: job.progress,
    estimatedCredits: job.estimatedCredits,
    actualCredits: job.actualCredits,
    taskCharge: taskChargeFromParts({
      credits: job.actualCredits,
      remoteStatus: job.remoteStatus,
      remoteStatusRaw: job.remoteStatusRaw,
      settledAt: job.lastPolledAt
    }),
    retryOfJobId: job.retryOfJobId,
    nextPollAt: job.nextPollAt,
    lastPolledAt: job.lastPolledAt,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    updatedAt: job.updatedAt,
    completedAt: job.completedAt
  };
}
function safeJobEvent(
  event: ReturnType<JobRepository['eventsAfter']>[number],
  outstandingProjection?: OutstandingSpendProjection
) {
  const sanitized = sanitizeDurableJobEventPayload(event.payload);
  const safe = sanitized.attention
    ? { ...event, ...sanitized.attention, payload: sanitized.payload }
    : { ...event, payload: sanitized.payload };
  return outstandingProjection ? { ...safe, outstandingProjection } : safe;
}
function encode(event: string, id: number, data: unknown): Uint8Array {
  return encoder.encode(`event: ${event}\nid: ${id}\ndata: ${JSON.stringify(data)}\n\n`);
}
export type InitialEventBatch = {
  mode: 'snapshot' | 'replay';
  cursor: number;
  chunks: Uint8Array[];
};
export function initialJobEvents(
  repository: JobRepository,
  lastEventId: string | null
): InitialEventBatch {
  const bounds = repository.eventBounds();
  const parsed = lastEventId === null ? null : Number(lastEventId);
  const valid =
    parsed !== null &&
    Number.isSafeInteger(parsed) &&
    parsed >= Math.max(0, bounds.min - 1) &&
    parsed <= bounds.max;
  if (!valid) {
    const snapshot = repository.snapshot();
    return {
      mode: 'snapshot',
      cursor: snapshot.watermark,
      chunks: [
        encode('snapshot', snapshot.watermark, {
          watermark: snapshot.watermark,
          connection: 'connected',
          jobs: snapshot.jobs.map(safeJobDto),
          outstandingProjection: repository.outstandingProjection()
        })
      ]
    };
  }
  const events = repository.eventsAfter(parsed);
  const projection = repository.outstandingProjection();
  return {
    mode: 'replay',
    cursor: events.at(-1)?.eventId ?? parsed,
    chunks: events.map((event, index) =>
      encode(
        'job',
        event.eventId,
        safeJobEvent(event, index === events.length - 1 ? projection : undefined)
      )
    )
  };
}
export function createJobEventStream(
  repository: JobRepository,
  lastEventId: string | null,
  signal?: AbortSignal,
  pollMs = 500
): ReadableStream<Uint8Array> {
  let timer: ReturnType<typeof setInterval> | null = null;
  return new ReadableStream({
    start(controller) {
      const initial = initialJobEvents(repository, lastEventId);
      let cursor = initial.cursor;
      if (initial.chunks.length === 0) controller.enqueue(encoder.encode(': connected\n\n'));
      for (const chunk of initial.chunks) controller.enqueue(chunk);
      const poll = () => {
        const events = repository.eventsAfter(cursor);
        const projection = events.length ? repository.outstandingProjection() : undefined;
        for (const [index, event] of events.entries()) {
          controller.enqueue(
            encode(
              'job',
              event.eventId,
              safeJobEvent(event, index === events.length - 1 ? projection : undefined)
            )
          );
          cursor = event.eventId;
        }
      };
      timer = setInterval(poll, pollMs);
      timer.unref?.();
      signal?.addEventListener(
        'abort',
        () => {
          if (timer) clearInterval(timer);
          timer = null;
          controller.close();
        },
        { once: true }
      );
    },
    cancel() {
      if (timer) clearInterval(timer);
      timer = null;
    }
  });
}
export function decodeEventChunk(chunk: Uint8Array): { event: string; id: number; data: unknown } {
  const text = new TextDecoder().decode(chunk);
  const event = /^event: (.+)$/m.exec(text)?.[1] ?? '';
  const id = Number(/^id: (.+)$/m.exec(text)?.[1]);
  const data = JSON.parse(/^data: (.+)$/m.exec(text)?.[1] ?? 'null');
  return { event, id, data };
}
