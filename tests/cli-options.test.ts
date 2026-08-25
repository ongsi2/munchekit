import { describe, expect, it } from 'vitest';

import { numberOption } from '../src/cli-options.js';

describe('CLI numeric options', () => {
  it('uses a fallback and accepts bounded values', () => {
    expect(numberOption(undefined, '--ratio', 0.35, { min: 0, max: 1 })).toBe(0.35);
    expect(numberOption('0', '--ratio', 0.35, { min: 0, max: 1 })).toBe(0);
    expect(numberOption('1', '--ratio', 0.35, { min: 0, max: 1 })).toBe(1);
  });

  it('rejects non-finite, out-of-range, and fractional integer values', () => {
    expect(() => numberOption('NaN', '--ratio', 0, { min: 0, max: 1 })).toThrow(/finite/u);
    expect(() => numberOption('-0.1', '--ratio', 0, { min: 0, max: 1 })).toThrow(/at least/u);
    expect(() => numberOption('2', '--ratio', 0, { min: 0, max: 1 })).toThrow(/at most/u);
    expect(() => numberOption('1.5', '--count', 0, { min: 0, integer: true })).toThrow(/integer/u);
  });
});
