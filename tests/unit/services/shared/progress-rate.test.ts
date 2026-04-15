import { describe, it, expect } from 'vitest';
import { calc_rate, format_duration } from '@/services/shared/progress-rate';

describe('calc_rate', () => {
  it('returns 0 when elapsed_ms is 0', () => {
    expect(calc_rate(10, 0)).toBe(0);
  });

  it('returns processed per second', () => {
    expect(calc_rate(10, 2000)).toBe(5);
  });
});

describe('format_duration', () => {
  it('returns -- for non-finite or non-positive seconds', () => {
    expect(format_duration(NaN)).toBe('--');
    expect(format_duration(Infinity)).toBe('--');
    expect(format_duration(0)).toBe('--');
    expect(format_duration(-1)).toBe('--');
  });

  it('formats seconds under one minute', () => {
    expect(format_duration(45.5)).toBe('46s');
  });

  it('formats minutes', () => {
    expect(format_duration(125)).toBe('2m 5s');
  });

  it('formats hours', () => {
    expect(format_duration(6000)).toBe('1h 40m');
  });
});
