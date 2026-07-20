import { describe, expect, test } from 'bun:test';
import {
  parseBalanceResponse,
  parseStatusResponse,
  parseSubmitResponse,
  parseUploadResponse
} from '../../../src/lib/server/poyo/parsers';

describe('Poyo response parsing', () => {
  test('PYO-03 parses authoritative task states and preserves forward-compatible output types', () => {
    const status = parseStatusResponse({
      code: 200,
      data: {
        task_id: 'task-1',
        status: 'finished',
        credits_amount: 4.5,
        files: [
          { file_url: 'https://media.example/audio.mp3', file_type: 'audio' },
          {
            file_url: 'https://media.example/result.bin',
            file_type: 'future_media',
            label: 'auxiliary',
            format: 'bin',
            content_type: 'application/octet-stream',
            file_name: 'result.bin',
            file_size: 42
          }
        ],
        created_time: '2026-07-15T10:00:00Z',
        progress: 100,
        error_message: null
      }
    });

    expect(status.status).toBe('finished');
    expect(status.files.map((file) => file.fileType)).toEqual(['audio', 'future_media']);
    expect(status.files[1]).toMatchObject({ fileName: 'result.bin', fileSize: 42 });

    const states = [
      ['not_started', 'not_started'],
      ['running', 'running'],
      ['failed', 'failed'],
      ['cancelled', 'failed'],
      ['canceled', 'failed'],
      ['new_upstream_state', 'unknown']
    ] as const;
    for (const [raw, expected] of states) {
      const parsed = parseStatusResponse({
        task_id: 'task-2',
        status: raw,
        credits_amount: 0,
        files: [],
        created_time: '2026-07-15T10:00:00Z',
        progress: null,
        error_message: raw === 'failed' ? 'Provider declined generation' : null
      });
      expect(parsed.status).toBe(expected);
    }
    expect(
      parseStatusResponse({
        task_id: 'task-null-charge',
        status: 'cancelled',
        credits_amount: null,
        files: [],
        created_time: '2026-07-15T10:00:00Z',
        progress: 100,
        error_message: 'Cancelled before a charge was reported'
      })
    ).toMatchObject({ status: 'failed', statusRaw: 'cancelled', creditsAmount: null });
  });

  test('PYO-02 parses balance, submit, and upload envelopes', () => {
    expect(
      parseBalanceResponse(
        { code: 200, data: { email: 'studio@example.test', credits_amount: 9765 } },
        new Date('2026-07-15T12:00:00Z')
      )
    ).toEqual({
      email: 'studio@example.test',
      creditsAmount: 9765,
      fetchedAt: '2026-07-15T12:00:00.000Z'
    });
    expect(
      parseSubmitResponse({
        code: 200,
        data: {
          task_id: 'task-submit',
          status: 'not_started',
          created_time: '2026-07-15T12:00:00Z'
        }
      })
    ).toMatchObject({ taskId: 'task-submit', status: 'not_started' });
    expect(
      parseUploadResponse(
        {
          success: true,
          code: 200,
          data: {
            file_id: 'file-1',
            file_name: 'image.png',
            original_name: 'source.png',
            file_size: 4,
            mime_type: 'image/png',
            upload_path: 'temp/images',
            file_url: 'https://media.example/image.png',
            download_url: 'https://media.example/image.png',
            upload_time: '2026-07-15T12:00:00Z',
            expires_at: '2026-07-18T12:00:00Z'
          }
        },
        'upload_stream'
      )
    ).toMatchObject({ fileId: 'file-1', mimeType: 'image/png' });
  });

  test('PYO-03 rejects invalid progress and malformed required fields', () => {
    expect(() =>
      parseStatusResponse({
        task_id: 'task',
        status: 'running',
        credits_amount: 1,
        files: [],
        created_time: 'now',
        progress: 101
      })
    ).toThrow('0-100');
    expect(() => parseSubmitResponse({ code: 200, data: {} })).toThrow('status');
    expect(() =>
      parseStatusResponse({
        task_id: 'task',
        status: 'running',
        credits_amount: -1,
        files: [],
        created_time: 'now',
        progress: 10
      })
    ).toThrow('negative credits_amount');
  });
});
