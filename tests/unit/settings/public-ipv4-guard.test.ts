import { describe, expect, test } from 'bun:test';
import {
  normalizePublicIpv4GuardSettings,
  parsePublicIpv4,
  parsePublicIpv4GuardSettings,
  publicIpv4Status
} from '../../../src/lib/features/settings/public-ipv4-guard';

describe('public IPv4 guard settings', () => {
  test('canonicalizes valid public dotted-decimal IPv4 values', () => {
    expect(parsePublicIpv4(' 8.8.4.4\n')).toBe('8.8.4.4');
    expect(parsePublicIpv4('1.1.1.1')).toBe('1.1.1.1');
    for (const value of [
      '192.0.0.9',
      '192.0.0.10',
      '192.31.196.1',
      '192.52.193.1',
      '192.175.48.1'
    ]) {
      expect(parsePublicIpv4(value)).toBe(value);
    }
  });

  test.each([
    '',
    '1.2.3',
    '1.2.3.4.5',
    '01.2.3.4',
    '+1.2.3.4',
    '1.2.3.256',
    '1.2. 3.4',
    '::1',
    '0.0.0.0',
    '10.0.0.1',
    '100.64.0.1',
    '127.0.0.1',
    '169.254.1.1',
    '172.16.0.1',
    '192.0.0.1',
    '192.0.0.8',
    '192.0.0.11',
    '192.0.0.170',
    '192.0.2.1',
    '192.168.1.1',
    '198.18.0.1',
    '198.51.100.1',
    '203.0.113.1',
    '224.0.0.1',
    '240.0.0.1',
    '255.255.255.255'
  ])('rejects malformed or non-public address %s', (value) => {
    expect(() => parsePublicIpv4(value)).toThrow();
  });

  test('defaults disabled and refuses enablement without a saved valid address', () => {
    expect(normalizePublicIpv4GuardSettings(undefined)).toEqual({
      enabled: false,
      homeIpv4: null
    });
    expect(() => normalizePublicIpv4GuardSettings({ enabled: true, homeIpv4: null })).toThrow(
      'Save a valid home public IPv4'
    );
    expect(normalizePublicIpv4GuardSettings({ enabled: true, homeIpv4: '8.8.4.4' })).toEqual({
      enabled: true,
      homeIpv4: '8.8.4.4'
    });
  });

  test('strictly rejects malformed write shapes', () => {
    for (const value of [
      null,
      [],
      'disabled',
      {},
      { enabled: false },
      { homeIpv4: null },
      { enabled: false, homeIpv4: null, extra: true },
      { enabled: 'false', homeIpv4: null },
      { enabled: false, homeIpv4: '' }
    ]) {
      expect(() => parsePublicIpv4GuardSettings(value)).toThrow();
    }
  });

  test('strict write parsing accepts only the complete canonical settings shape', () => {
    expect(parsePublicIpv4GuardSettings({ enabled: false, homeIpv4: null })).toEqual({
      enabled: false,
      homeIpv4: null
    });
    expect(() => parsePublicIpv4GuardSettings({ enabled: true, homeIpv4: null })).toThrow(
      'Save a valid home public IPv4'
    );
    expect(parsePublicIpv4GuardSettings({ enabled: true, homeIpv4: ' 8.8.4.4 ' })).toEqual({
      enabled: true,
      homeIpv4: '8.8.4.4'
    });
  });

  test('represents the full status decision matrix without exposing the home address', () => {
    const disabled = publicIpv4Status(
      { enabled: false, homeIpv4: '8.8.4.4' },
      { currentIpv4: '8.8.4.4', checkedAt: '2026-07-19T00:00:00.000Z' }
    );
    expect(disabled.state).toBe('guard-disabled');
    expect(JSON.stringify(disabled)).not.toContain('homeIpv4');
    expect(
      publicIpv4Status(
        { enabled: true, homeIpv4: '8.8.4.4' },
        { currentIpv4: '1.1.1.1', checkedAt: null }
      ).state
    ).toBe('protected');
    expect(
      publicIpv4Status(
        { enabled: true, homeIpv4: '8.8.4.4' },
        { currentIpv4: '8.8.4.4', checkedAt: null }
      ).state
    ).toBe('blocked');
    expect(
      publicIpv4Status(
        { enabled: true, homeIpv4: '8.8.4.4' },
        { currentIpv4: null, checkedAt: null }
      ).state
    ).toBe('unavailable');
  });
});
