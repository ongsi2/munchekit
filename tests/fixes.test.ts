import { describe, expect, it } from 'vitest';

import { analyze } from '../src/engine.js';
import { applyFixes, applyTextEdits, changedCharsRatio } from '../src/fixes.js';

describe('safe fixes', () => {
  it('applies only high-confidence fixes', () => {
    const source = '사전에 미리 검토를 진행했고, 약 10개 정도가 되어지는지 확인했다!!';
    const report = analyze(source);
    const result = applyFixes(source, report);

    expect(result.limitExceeded).toBe(false);
    expect(result.text).toBe('사전에 미리 검토를 진행했고, 약 10개 정도가 되는지 확인했다!');
    expect(result.applied.every((item) => item.fixability === 'safe')).toBe(true);
  });

  it('is idempotent', () => {
    const source = '결과가 저장되어진다!!';
    const first = applyFixes(source, analyze(source));
    const second = applyFixes(first.text, analyze(first.text));

    expect(second.text).toBe(first.text);
    expect(second.applied).toHaveLength(0);
  });

  it('refuses an unexpectedly large batch of edits', () => {
    const source = `${'결과가 저장되어지고 다시 공유되어진다!! '.repeat(20)}이 문장은 길이 제한 검증을 위한 꼬리 문장이다.`;
    const result = applyFixes(source, analyze(source), { maxChangedCharsRatio: 0.01 });

    expect(result.limitExceeded).toBe(true);
    expect(result.text).toBe(source);
  });

  it('rejects overlapping raw text edits', () => {
    expect(() =>
      applyTextEdits('abcdef', [
        { start: 1, end: 4, replacement: 'x', safety: 'safe' },
        { start: 3, end: 5, replacement: 'y', safety: 'safe' },
      ]),
    ).toThrow(/Overlapping/u);
  });

  it('fixes high-confidence spacing without matching arbitrary 수 syllables', () => {
    const source = '문서를 찾을수있다. 함수있음과 실수없음, 철수없이 진행한다.';
    const result = applyFixes(source, analyze(source));

    expect(result.text).toBe('문서를 찾을 수 있다. 함수있음과 실수없음, 철수없이 진행한다.');
  });

  it('honors an explicit change limit even for a short snippet', () => {
    const source = '지금 시작하세요!!';
    const result = applyFixes(source, analyze(source), { maxChangedCharsRatio: 0 });

    expect(result.limitExceeded).toBe(true);
    expect(result.text).toBe(source);
  });

  it('uses a bounded conservative ratio for large repetitive inputs', () => {
    const before = '가!'.repeat(20_000);
    const after = '가?'.repeat(20_000);
    expect(changedCharsRatio(before, after)).toBeGreaterThan(0.9);
  });

  it('never auto-fixes context-sensitive nominalizations or redundant-looking phrases', () => {
    const source = '요청에 대한 검토를 진행했다. 그 단어를 사전에 미리 표시했다. 약 10개 정도를 샀다.';
    const result = applyFixes(source, analyze(source));

    expect(result.text).toBe(source);
    expect(result.applied).toHaveLength(0);
  });

  it('downgrades fixes in opaque JSON and program strings to review-only', () => {
    const sources: Array<[string, Parameters<typeof analyze>[1]]> = [
      ['{"status":"결과가 저장되어진다!!"}', { format: 'json' }],
      ['const value = cache.get("찾을수있다");', { format: 'tsx' }],
      ['const pattern = new RegExp("오류!!");', { format: 'tsx' }],
      ['const body = { status: "결과가 저장되어진다!!" };', { format: 'tsx' }],
    ];

    for (const [source, options] of sources) {
      const report = analyze(source, options);
      const proposed = report.diagnostics.filter((diagnostic) => diagnostic.fix);
      expect(proposed.length).toBeGreaterThan(0);
      expect(proposed.every((diagnostic) => diagnostic.fix?.safety === 'review')).toBe(true);
      expect(applyFixes(source, report).text).toBe(source);
    }
  });

  it('keeps safe fixes enabled on explicit user-facing JSX text', () => {
    const source = 'export const View = () => <p>결과가 저장되어진다!!</p>;';
    const result = applyFixes(source, analyze(source, { format: 'tsx' }));

    expect(result.text).toBe('export const View = () => <p>결과가 저장된다!</p>;');
    expect(result.applied.length).toBeGreaterThan(0);
  });

  it('protects TSX meta refresh targets from content-attribute fixes', () => {
    const sources = [
      'const x = <meta httpEquiv="refresh" content="0; URL=/오류!!" />;',
      'const x = <meta http-equiv="refresh" content="0; URL=/오류!!" />;',
    ];
    for (const source of sources) {
      const report = analyze(source, { format: 'tsx' });
      expect(report.diagnostics).toHaveLength(0);
      expect(applyFixes(source, report).text).toBe(source);
    }
  });

  it('protects URL-bearing HTML and TSX metadata', () => {
    const sources: Array<[string, Parameters<typeof analyze>[1]]> = [
      ['<meta property="og:image" content="/오류!!">', { format: 'html' }],
      ['const x = <meta property="og:image" content="/오류!!" />;', { format: 'tsx' }],
      ['<meta property="og:image" content="/오류!!" />', { format: 'mdx' }],
      ['<meta httpEquiv="refresh" content="0; URL=/오류!!" />', { format: 'mdx' }],
    ];
    for (const [source, options] of sources) {
      const report = analyze(source, options);
      expect(report.diagnostics).toHaveLength(0);
      expect(applyFixes(source, report).text).toBe(source);
    }
  });

  it('never applies a safe edit across syntax, protected tokens, values, or paragraphs', () => {
    const cases: Array<[string, Parameters<typeof analyze>[1]]> = [
      ['미리 ${name} 사전에', { format: 'plain' }],
      ['미리\n\n사전에', { format: 'plain' }],
      ['검토를 `dryRun` 진행했다.', { format: 'markdown' }],
      ['{"a":"미리","b":"사전에"}', { format: 'json' }],
      ['<p>미리 <strong>사전에</strong></p>', { format: 'html' }],
      ['const a = "미리"; const b = "사전에";', { format: 'tsx' }],
    ];

    for (const [source, options] of cases) {
      const report = analyze(source, options);
      const result = applyFixes(source, report);
      expect(result.text).toBe(source);
      expect(result.applied).toHaveLength(0);
      expect(report.diagnostics.filter((diagnostic) => ['KO-RED-001', 'KO-NOM-001'].includes(diagnostic.ruleId))).toHaveLength(0);
    }
  });
});
