import { TEST_MEDIA_ORIGIN } from '../../src/lib/server/jobs/runtime-settings';

export type MockTaskOutcome = 'success' | 'failed' | 'held';

export interface RecordedPoyoRequest {
  method: string;
  pathname: string;
  authorizationScheme: string | null;
  json: unknown;
  multipart: {
    file: { name: string; size: number; type: string; checksum: string };
    fileName: string | null;
  } | null;
}

interface MockTask {
  id: string;
  model: string;
  mediaKind: 'image' | 'video';
  outcome: MockTaskOutcome;
  released: boolean;
  polls: number;
  outputCount: number;
}

const createdTime = '2026-07-15T12:00:00.000Z';

export async function startStudioMockPoyoServer(): Promise<{
  baseUrl: string;
  requests: RecordedPoyoRequest[];
  tasks: Map<string, MockTask>;
  queueOutcome: (outcome: MockTaskOutcome) => void;
  releaseHeldTasks: () => void;
  stop: () => Promise<void>;
}> {
  const requests: RecordedPoyoRequest[] = [];
  const tasks = new Map<string, MockTask>();
  const outcomes: MockTaskOutcome[] = [];
  const image = await Bun.file('tests/fixtures/media/tiny.png').bytes();
  const video = await Bun.file('tests/fixtures/media/tiny.mp4').bytes();

  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: async (request) => {
      const url = new URL(request.url);
      if (url.pathname.startsWith('/media/')) {
        const isVideo = url.pathname.endsWith('.mp4');
        const body = isVideo ? video : image;
        return new Response(body, {
          headers: {
            'content-length': String(body.byteLength),
            'content-type': isVideo ? 'video/mp4' : 'image/png'
          }
        });
      }

      let json: unknown = null;
      let multipart: RecordedPoyoRequest['multipart'] = null;
      const contentType = request.headers.get('content-type') ?? '';
      if (contentType.includes('application/json')) json = await request.json();
      if (contentType.includes('multipart/form-data')) {
        const form = await request.formData();
        const file = form.get('file');
        if (file instanceof File) {
          const bytes = new Uint8Array(await file.arrayBuffer());
          const checksum = new Bun.CryptoHasher('sha256').update(bytes).digest('hex');
          multipart = {
            file: { name: file.name, size: file.size, type: file.type, checksum },
            fileName:
              typeof form.get('file_name') === 'string' ? String(form.get('file_name')) : null
          };
        }
      }
      const authorization = request.headers.get('authorization');
      requests.push({
        method: request.method,
        pathname: url.pathname,
        authorizationScheme: authorization?.split(' ', 1)[0] ?? null,
        json,
        multipart
      });

      if (url.pathname === '/api/user/balance') {
        return Response.json({
          code: 200,
          data: { email: 'browser-suite@example.test', credits_amount: 1200 }
        });
      }

      if (url.pathname === '/api/generate/submit' && request.method === 'POST') {
        const body = json as { model?: unknown; input?: { n?: unknown } };
        const model = typeof body?.model === 'string' ? body.model : 'unknown';
        const requestedOutputCount = Number(body.input?.n);
        const outputCount =
          Number.isSafeInteger(requestedOutputCount) && requestedOutputCount >= 1
            ? Math.min(4, requestedOutputCount)
            : 1;
        const mediaKind = /grok|hailuo|kling|video|veo|wan-2\.[126]|seedance|omni/i.test(model)
          ? 'video'
          : 'image';
        const id = `mock-task-${tasks.size + 1}`;
        tasks.set(id, {
          id,
          model,
          mediaKind,
          outcome: outcomes.shift() ?? 'success',
          released: false,
          polls: 0,
          outputCount
        });
        return Response.json({
          code: 200,
          data: { task_id: id, status: 'not_started', created_time: createdTime }
        });
      }

      const statusMatch = /^\/api\/generate\/status\/(.+)$/.exec(url.pathname);
      if (statusMatch) {
        const taskId = decodeURIComponent(statusMatch[1] ?? '');
        const task = tasks.get(taskId);
        if (!task) return Response.json({ detail: 'Unknown task' }, { status: 404 });
        task.polls += 1;
        const held = task.outcome === 'held' && !task.released;
        const running = held || (task.outcome === 'success' && task.polls === 1);
        if (task.outcome === 'failed') {
          return Response.json({
            code: 200,
            data: {
              task_id: task.id,
              status: 'failed',
              credits_amount: 0,
              files: [],
              created_time: createdTime,
              progress: 18,
              error_message: 'Mock provider rejected the generation.'
            }
          });
        }
        if (running) {
          return Response.json({
            code: 200,
            data: {
              task_id: task.id,
              status: 'running',
              credits_amount: 0,
              files: [],
              created_time: createdTime,
              progress: 42
            }
          });
        }
        const extension = task.mediaKind === 'video' ? 'mp4' : 'png';
        const bytes = task.mediaKind === 'video' ? video : image;
        return Response.json({
          code: 200,
          data: {
            task_id: task.id,
            status: 'finished',
            credits_amount: task.mediaKind === 'video' ? 12 : 3,
            files: Array.from({ length: task.outputCount }, (_, index) => ({
              file_url: `${TEST_MEDIA_ORIGIN}/media/${task.id}-${index + 1}.${extension}`,
              file_type: task.mediaKind,
              format: extension,
              content_type: task.mediaKind === 'video' ? 'video/mp4' : 'image/png',
              file_name: `${task.id}-${index + 1}.${extension}`,
              file_size: bytes.byteLength
            })),
            created_time: createdTime,
            progress: 100
          }
        });
      }

      if (url.pathname === '/api/common/upload/stream' && request.method === 'POST') {
        return Response.json({
          success: true,
          code: 200,
          data: {
            file_id: `upload-${requests.length}`,
            file_name: 'source.png',
            original_name: 'source.png',
            file_size: image.byteLength,
            mime_type: 'image/png',
            upload_path: 'mock/uploads',
            file_url: `${url.origin}/media/source.png`,
            download_url: `${url.origin}/media/source.png`,
            upload_time: createdTime,
            expires_at: '2026-07-18T12:00:00.000Z'
          }
        });
      }

      return Response.json({ detail: `Unhandled mock route ${url.pathname}` }, { status: 404 });
    }
  });

  return {
    baseUrl: `http://${server.hostname}:${server.port}`,
    requests,
    tasks,
    queueOutcome: (outcome) => outcomes.push(outcome),
    releaseHeldTasks: () => {
      for (const task of tasks.values()) task.released = true;
    },
    stop: async () => server.stop(true)
  };
}
