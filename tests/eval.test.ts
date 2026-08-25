import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { analyze } from '../src/engine.js';
import { ruleCatalog } from '../src/rules.js';
import type { ProfileName } from '../src/types.js';

interface Fixture {
  id: string;
  text: string;
  profile?: ProfileName;
  expect: string[];
  reject: string[];
}

const fixturePath = fileURLToPath(new URL('../eval/minimal-pairs.jsonl', import.meta.url));
const fixtures = readFileSync(fixturePath, 'utf8')
  .trim()
  .split(/\r?\n/gu)
  .map((line) => JSON.parse(line) as Fixture);

describe('public minimal-pair evaluation fixtures', () => {
  it('contains a positive and hard negative for every initial rule', () => {
    expect(fixtures).toHaveLength(50);
    for (const rule of ruleCatalog.filter((item) => item.category !== 'parser')) {
      expect(fixtures.some((fixture) => fixture.expect.includes(rule.id)), `${rule.id} positive`).toBe(true);
      expect(fixtures.some((fixture) => fixture.reject.includes(rule.id)), `${rule.id} hard negative`).toBe(true);
    }
  });

  for (const fixture of fixtures) {
    it(fixture.id, () => {
      const ids = analyze(fixture.text, fixture.profile ? { profile: fixture.profile } : {}).diagnostics.map(
        (diagnostic) => diagnostic.ruleId,
      );
      for (const expected of fixture.expect) expect(ids).toContain(expected);
      for (const rejected of fixture.reject) expect(ids).not.toContain(rejected);
    });
  }
});
