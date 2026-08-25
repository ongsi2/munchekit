import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { analyze, ENGINE_VERSION } from '../src/engine.js';
import { jsonReport, prettyReport, sarifReport } from '../src/reporters.js';

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
