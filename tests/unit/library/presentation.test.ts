import { describe, expect, test } from 'bun:test';
import {
  byteSizeLabel,
  dateLabel,
  dateTimeLabel,
  elapsedLabel,
  mediaFrameAspectRatio,
  parseJobFilters,
  parseLibraryFilters,
  statusLabel
} from '../../../src/lib/features/library/presentation';

describe('jobs and library presentation contracts', () => {
  test('bounds and normalizes untrusted query filters', () => {
    const jobs = parseJobFilters(
      new URLSearchParams({
        status: 'not-a-status',
        q: 'x'.repeat(500),
        from: '2026-02-30',
        to: 'invalid',
        cursor: 'y'.repeat(900)
      })
    );
    expect(jobs.status).toBe('all');
    expect(jobs.q).toHaveLength(200);
    expect(jobs.dateTo).toBe('');
    expect(jobs.cursor).toHaveLength(512);

    const library = parseLibraryFilters(
      new URLSearchParams({ kind: 'audio', status: 'remote-only', favorite: 'true', view: 'list' })
    );
    expect(library).toMatchObject({
      mediaKind: '',
      status: 'remote-only',
      favorite: true,
      view: 'list'
    });
  });

  test('uses honest elapsed, byte and orthogonal status labels', () => {
    expect(
      elapsedLabel('2026-07-15T10:00:00.000Z', null, new Date('2026-07-15T11:02:03.000Z'))
    ).toBe('1h 2m');
    expect(byteSizeLabel(1536)).toBe('1.5 KB');
    expect(dateLabel('2026-07-15T23:30:00-07:00')).toBe('16 Jul 2026');
    expect(dateTimeLabel('2026-07-15T10:02:00.000Z')).toBe('15 Jul 2026 at 10:02');
    expect(statusLabel('requires_attention', 'unknown', 'submission_unknown')).toBe(
      'Submission outcome unknown'
    );
    expect(statusLabel('monitoring', 'running', null)).toBe('Generating');
  });

  test('keeps mixed-aspect media recognizable without allowing extreme frames', () => {
    expect(mediaFrameAspectRatio(1200, 1200)).toBe('1');
    expect(mediaFrameAspectRatio(1920, 1080)).toBe(String(Number((16 / 9).toFixed(6))));
    expect(mediaFrameAspectRatio(1080, 1920)).toBe('0.75');
    expect(mediaFrameAspectRatio(null, null)).toBe('4 / 3');
    expect(mediaFrameAspectRatio(0, 100)).toBe('4 / 3');
    expect(mediaFrameAspectRatio(null, null, '9:16')).toBe('0.75');
    expect(mediaFrameAspectRatio(null, null, '16:9')).toBe(String(Number((16 / 9).toFixed(6))));
    expect(mediaFrameAspectRatio(null, null, 'auto')).toBe('4 / 3');
  });
});
