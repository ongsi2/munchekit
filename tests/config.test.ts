import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { mergeConfig, validateConfig } from '../src/config.js';
import { compileUserPattern } from '../src/patterns.js';
import { ruleCatalog } from '../src/rules.js';

describe('configuration validation', () => {
  it('keeps configurable rule IDs aligned with the published schema', () => {
    const schema = JSON.parse(readFileSync(new URL('../schema/munche.schema.json', import.meta.url), 'utf8')) as {
      properties: { rules: { properties: Record<string, unknown> } };
    };
    const runtimeIds = ruleCatalog
      .filter((rule) => rule.category !== 'parser')
      .map((rule) => rule.id)
      .sort();
    expect(Object.keys(schema.properties.rules.properties).sort()).toEqual(runtimeIds);
  });

  it('rejects unknown rules and non-finite rewrite limits', () => {
    expect(() => validateConfig({ rules: { 'KO-FAKE-999': 'warning' } })).toThrow(/Unknown rule/u);
    expect(() => validateConfig({ rewrite: { maxChangedCharsRatio: Number.NaN } })).toThrow(/between 0 and 1/u);
  });

  it('rejects invalid or potentially catastrophic preserve patterns', () => {
    expect(() => validateConfig({ preservePatterns: ['['] })).toThrow(/Invalid preservePatterns/u);
    for (const pattern of ['(a+)+$', '((a+))+$', '(a|aa)+$', 'a+a+$', 'a*a*$', '(?<word>.+)\\k<word>']) {
      expect(() => validateConfig({ preservePatterns: [pattern] })).toThrow(/potentially unsafe/u);
    }
    expect(() => compileUserPattern('x'.repeat(201))).toThrow(/length/u);
  });

  it('accepts bounded Unicode preserve patterns', () => {
    const config = validateConfig({
      profile: 'web',
      files: ['copy.md'],
      ignore: ['vendor/**'],
      preserveTerms: ['MuncheKit'],
      preservePatterns: ['(?:제품|서비스)-[가-힣]+'],
      ignoreQuotes: false,
      rules: { 'KO-VAGUE-001': 'warning' },
      rewrite: { maxChangedCharsRatio: 0.2 },
    });
    expect(config.preservePatterns).toEqual(['(?:제품|서비스)-[가-힣]+']);
    expect(mergeConfig(config).ignore).toContain('vendor/**');
  });

  it('rejects malformed top-level and nested config values', () => {
    const invalid: unknown[] = [
      null,
      [],
      { unknown: true },
      { $schema: 1 },
      { profile: 'fiction' },
      { files: 'copy.md' },
      { ignoreQuotes: 'yes' },
      { preserveTerms: [''] },
      { rules: [] },
      { rules: { 'KO-VAGUE-001': 'loud' } },
      { rewrite: [] },
      { rewrite: { maxChangeRatio: 0.2 } },
      { rewrite: { maxChangedCharsRatio: -1 } },
      { rewrite: { maxChangedCharsRatio: 2 } },
    ];
    for (const value of invalid) expect(() => validateConfig(value)).toThrow();
  });
});
