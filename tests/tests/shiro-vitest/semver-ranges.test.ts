import { describe, it, expect } from 'vitest';
import { maxSatisfying, satisfiesRange } from '@shiro/utils/semver-utils';

const TS = ['5.6.3', '5.7.0', '5.7.2', '5.7.3', '5.8.2', '5.9.3', '5.10.0-beta', '6.0.0-dev.20260101'];

describe('npm semver ranges', () => {
  it('partial versions are x-ranges (issue 74: typescript@5.7 installed 5.9.3)', () => {
    expect(maxSatisfying(TS, '5.7')).toBe('5.7.3');
    expect(maxSatisfying(TS, '5')).toBe('5.9.3');
    expect(maxSatisfying(TS, '5.7.x')).toBe('5.7.3');
    expect(maxSatisfying(TS, '5.x')).toBe('5.9.3');
    expect(maxSatisfying(TS, '5.7.2')).toBe('5.7.2');
  });

  it('caret and tilde, including partial versions', () => {
    expect(maxSatisfying(TS, '^5.7.0')).toBe('5.9.3');
    expect(maxSatisfying(TS, '~5.7.0')).toBe('5.7.3');
    expect(maxSatisfying(TS, '^5.7')).toBe('5.9.3');
    expect(maxSatisfying(TS, '~5')).toBe('5.9.3');
    expect(satisfiesRange('0.2.5', '^0.2.3')).toBe(true);
    expect(satisfiesRange('0.3.0', '^0.2.3')).toBe(false);
    expect(satisfiesRange('0.0.4', '^0.0.3')).toBe(false);
  });

  it('comparator sets, hyphen ranges, and ||', () => {
    expect(maxSatisfying(TS, '>=5.7.0 <5.9.0')).toBe('5.8.2');
    expect(maxSatisfying(TS, '>= 5.7.0 < 5.9.0')).toBe('5.8.2');
    expect(maxSatisfying(TS, '5.6.0 - 5.7')).toBe('5.7.3');
    expect(maxSatisfying(TS, '^4.0.0 || ~5.6.0')).toBe('5.6.3');
    expect(satisfiesRange('1.5.0', '>1.2')).toBe(true);
    expect(satisfiesRange('1.2.9', '>1.2')).toBe(false);
    expect(satisfiesRange('1.2.9', '<=1.2')).toBe(true);
  });

  it('prereleases only match ranges that name them', () => {
    expect(maxSatisfying(TS, '*')).toBe('5.9.3');
    expect(maxSatisfying(TS, '>=5.0.0')).toBe('5.9.3');
    expect(satisfiesRange('5.10.0-beta', '>=5.10.0-alpha')).toBe(true);
    expect(satisfiesRange('2.0.0-rc.10', '>=2.0.0-rc.2')).toBe(true);
    expect(satisfiesRange('2.0.0-rc.1', '>=2.0.0-rc.2')).toBe(false);
  });
});
