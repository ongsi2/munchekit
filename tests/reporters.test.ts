import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { analyze, ENGINE_VERSION } from '../src/engine.js';
import { formatRewriteChanges } from '../src/index.js';
import { jsonReport, prettyReport, sarifReport } from '../src/reporters.js';

describe('rewrite change formatter', () => {
  it('shows each exact before/after pair with its reason and rule IDs', () => {
    const output = formatRewriteChanges([
      {
        before: '가지런한 치아는\n서두르지 않고 만듭니다',
        after: '가지런한 치아를 만들기 위해 서두르지 않습니다.',
        reason: '수식 관계를 분명히 함',
        ruleIds: ['KO-ATTACH-001', 'KO-REGISTER-001'],
      },
    ]);

    expect(output).toContain('변경 내역 (1개)');
    expect(output).toContain('"가지런한 치아는\\n서두르지 않고 만듭니다" → "가지런한 치아를 만들기 위해 서두르지 않습니다."');
    expect(output).toContain('이유: 수식 관계를 분명히 함');
    expect(output).toContain('규칙: KO-ATTACH-001, KO-REGISTER-001');
  });

  it('reports empty changes and sanitizes terminal control sequences', () => {
    expect(formatRewriteChanges([])).toBe('변경 내역: 없음');

    const output = formatRewriteChanges([
      {
        before: '\u001B[31m원문',
        after: '수정문',
        reason: '\u001B]8;;bad\u0007이유',
        ruleIds: [],
      },
    ]);
    expect(output).not.toContain('\u001B');
    expect(output).toContain('"원문" → "수정문"');
    expect(output).toContain('규칙: 없음');
  });
});

describe('pretty reporter', () => {
  it('keeps the engine and package versions aligned', () => {
    const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };
    expect(ENGINE_VERSION).toBe(packageJson.version);
  });

  it('shows rationale, confidence, and a suggestion by default', () => {
    const output = prettyReport(analyze('매우 강력한 기능입니다.', { filePath: 'copy.txt' }), { color: false });

    expect(output).toContain('근거 (');
    expect(output).toContain('제안:');
    expect(output).toContain('KO-VAGUE-001');
  });

  it('prints an exact replacement when a review suggestion provides one', () => {
    const output = prettyReport(analyze('가지런한 치아는 서두르지 않고 만듭니다.', { profile: 'web' }), { color: false });

    expect(output).toContain('KO-ATTACH-001');
    expect(output).toContain('제안 1:');
    expect(output).toContain('이 범위를 “치아를 만들기 위해 서두르지 않습니다”로 바꿔');
    expect(output).toContain('범위 교체 1: 치아를 만들기 위해 서두르지 않습니다');
    expect(output).toContain('제안 2:');
    expect(output).toContain('범위 교체 2: 치아를 서두르지 않고 만듭니다');
  });

  it('strips terminal control sequences from paths and excerpts', () => {
    const output = prettyReport(analyze('\u001B[31m매우 빠르다.', { filePath: '\u001B]8;;bad\u0007copy.txt' }), { color: false });

    expect(output).not.toContain('\u001B');
    expect(output).toContain('copy.txt');
  });

  it('renders clean, colored, JSON, and SARIF reports with stable metadata', () => {
    const clean = analyze('응답 시간은 120ms다.', { filePath: 'clean.txt' });
    expect(prettyReport(clean, { color: false })).toContain('문제 없음');

    const warning = analyze('매우 강력한 기능입니다.', { profile: 'web', filePath: 'copy.txt' });
    expect(prettyReport(warning, { color: true })).toContain('KO-VAGUE-001');

    const parseError = analyze('{"message":"닫히지 않음}', { format: 'json', filePath: 'broken.json' });
    expect(prettyReport(parseError, { color: true })).toContain('KO-PARSE-001');

    const json = JSON.parse(jsonReport([warning, clean])) as { schemaVersion: string; summary: { warning: number } };
    expect(json.schemaVersion).toBe('1.0');
    expect(json.summary.warning).toBeGreaterThan(0);

    const sarif = JSON.parse(sarifReport([warning, parseError])) as {
      version: string;
      runs: Array<{
        tool: { driver: { rules: Array<{ id: string }> } };
        results: Array<{ level: string; properties: { confidence: number } }>;
      }>;
    };
    expect(sarif.version).toBe('2.1.0');
    expect(sarif.runs[0]?.tool.driver.rules.some((rule) => rule.id === 'KO-PARSE-001')).toBe(true);
    expect(sarif.runs[0]?.results.some((result) => result.level === 'error')).toBe(true);
    expect(sarif.runs[0]?.results.every((result) => result.properties.confidence > 0)).toBe(true);
  });
});
