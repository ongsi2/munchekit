import { describe, expect, it } from 'vitest';

import { analyze } from '../src/engine.js';
import { classifyRegister } from '../src/rules.js';

function ids(text: string, options: Parameters<typeof analyze>[1] = {}): string[] {
  return analyze(text, options).diagnostics.map((diagnostic) => diagnostic.ruleId);
}

describe('rule engine', () => {
  it('flags a delayed purpose relation and offers the minimal user-intended repair', () => {
    const source = '가지런한 치아는 서두르지 않고 만듭니다.';
    const report = analyze(source, { profile: 'web' });
    const finding = report.diagnostics.find((item) => item.ruleId === 'KO-ATTACH-001');

    expect(finding?.severity).toBe('warning');
    expect(finding?.fixability).toBe('review');
    expect(finding?.fix).toBeUndefined();
    expect(source.slice(finding?.range.start, finding?.range.end)).toBe('치아는 서두르지 않고 만듭니다');
    expect(finding?.suggestions.map((item) => item.replacement)).toEqual([
      '치아를 만들기 위해 서두르지 않습니다',
      '치아를 서두르지 않고 만듭니다',
    ]);
    const first = finding?.suggestions[0];
    expect(first?.replacement).toBeDefined();
    expect(
      `${source.slice(0, finding?.range.start)}${first?.replacement}${source.slice(finding?.range.end)}`,
    ).toBe('가지런한 치아를 만들기 위해 서두르지 않습니다.');
  });

  it('keeps legitimate subjects, passives, explicit objects, and unknown topic contrasts clean', () => {
    const clean = [
      '치과의사는 서두르지 않고 치료합니다.',
      '장인은 서두르지 않고 제품을 만듭니다.',
      '치아는 서두르지 않고 움직입니다.',
      '가지런한 치아를 만들기 위해 서두르지 않습니다.',
      '가지런한 치아를 서두르지 않고 만듭니다.',
      '가지런한 치아는 하루아침에 만들어지지 않습니다.',
      '좋은 제품은 서둘러 만들지 않습니다.',
      '제품은 서두르지 않고 사용합니다.',
      '도자기는 서두르지 않고 만듭니다.',
      '미소는 서두르지 않고 만듭니다.',
      '제품은 서두르지 않고 만듭니다. 포장은 빠르게 끝냅니다.',
      '보고서는 서두르지 않고 작성해요. 이메일은 바로 보냅니다.',
      '생성 AI 서비스는 서두르지 않고 만듭니다.',
    ];
    for (const source of clean) expect(ids(source)).not.toContain('KO-ATTACH-001');
  });

  it('generalizes the attachment rule across non-agentive dental outcomes and registers', () => {
    const cases: Array<[string, string]> = [
      ['바른 치열은 서두르지 않고 만듭니다.', '치열을 만들기 위해 서두르지 않습니다'],
      ['가지런한 치아는 서두르지 않고 만들어요.', '치아를 만들기 위해 서두르지 않아요'],
      ['안정적인 교합은 서두르지 않고 만든다.', '교합을 만들기 위해 서두르지 않는다'],
    ];
    for (const [source, replacement] of cases) {
      const finding = analyze(source).diagnostics.find((item) => item.ruleId === 'KO-ATTACH-001');
      expect(finding?.suggestions[0]?.replacement).toBe(replacement);
    }
  });

  it('does not join an attachment finding across markup boundaries', () => {
    expect(ids('<p>가지런한 치아는 서두르지 않고 만듭니다.</p>', { format: 'html' })).toContain('KO-ATTACH-001');
    expect(ids('<p>가지런한 치아는 <em>서두르지 않고</em> 만듭니다.</p>', { format: 'html' })).not.toContain('KO-ATTACH-001');
    expect(ids('<p>가지런한 치아는<span>서두르지 않고</span> 만듭니다.</p>', { format: 'html' })).not.toContain('KO-ATTACH-001');
    expect(ids('<p>가지런한 치아는</p><p>서두르지 않고 만듭니다.</p>', { format: 'html' })).not.toContain('KO-ATTACH-001');
  });

  it.each(['<br>', '<br/>', '<br />', '<BR>'])(
    'joins KO-ATTACH-001 only across a layout break and preserves %s in each review candidate',
    (breakToken) => {
      const source = `<h1>가지런한 치아는${breakToken}서두르지 않고 만듭니다.</h1>`;
      const finding = analyze(source, { format: 'html', profile: 'web' }).diagnostics.find(
        (item) => item.ruleId === 'KO-ATTACH-001',
      );
      const replacement = finding?.suggestions[0]?.replacement;

      expect(replacement).toBe(`치아를 만들기 위해${breakToken}서두르지 않습니다`);
      if (!finding || !replacement) throw new Error('expected a structured attachment suggestion');
      const candidate = `${source.slice(0, finding.range.start)}${replacement}${source.slice(finding.range.end)}`;
      expect(candidate).toBe(`<h1>가지런한 치아를 만들기 위해${breakToken}서두르지 않습니다.</h1>`);
      expect(analyze(candidate, { format: 'html', profile: 'web' }).summary.error).toBe(0);
    },
  );

  it('does not build a broken full-sentence preview across structured markup', () => {
    const source = '<p>가지런한 <strong>치아는 서두르지 않고 만듭니다.</strong></p>';
    const finding = analyze(source, { format: 'html' }).diagnostics.find((item) => item.ruleId === 'KO-ATTACH-001');

    expect(finding?.suggestions[0]?.message).toContain('치아를 만들기 위해 서두르지 않습니다');
    expect(finding?.suggestions[0]?.message).not.toContain('<strong>');
  });

  it('reports explainable findings for a typical product-copy sample', () => {
    const source = '새 검색 기능을 통해서 사용자는 원하는 문서에 대해서 더욱 빠르게 찾을 수 있습니다. 또한 다양한 검색 조건을 활용할 수 있습니다.';
    const report = analyze(source, { profile: 'web' });

    expect(report.offsetEncoding).toBe('utf-16');
    expect(report.diagnostics.map((item) => item.ruleId)).toEqual(
      expect.arrayContaining(['KO-CALQUE-001', 'KO-CALQUE-002', 'KO-POSS-001', 'KO-VAGUE-002']),
    );
    expect(report.diagnostics.every((item) => item.location.start.line === 1)).toBe(true);
    expect(report.diagnostics.every((item) => item.rationale.length > 0)).toBe(true);
  });

  it('does not flag physical paths as an abstract through-construction', () => {
    expect(ids('터널을 통해서 안으로 들어왔다.')).not.toContain('KO-CALQUE-002');
  });

  it('does not generalize a nominalization rule to legitimate 진행하다 uses', () => {
    expect(ids('행사는 예정대로 진행했다.')).not.toContain('KO-NOM-001');
    expect(ids('설계 검토를 진행했다.')).toContain('KO-NOM-001');
  });

  it('ignores direct quotations by default and can opt in', () => {
    expect(ids('그는 “매우 강력한 기능입니다.”라고 말했다.')).not.toContain('KO-VAGUE-001');
    expect(ids('그는 “매우 강력한 기능입니다.”라고 말했다.', { ignoreQuotes: false })).toContain('KO-VAGUE-001');
  });

  it('keeps quotations protected when inline markup splits their text spans', () => {
    const sources: Array<[string, Parameters<typeof analyze>[1]]> = [
      ['“매우 **강력한** 기능”이라고 말했다.', { format: 'markdown' }],
      ['<p>“매우 <em>강력한</em> 기능”이라고 말했다.</p>', { format: 'html' }],
      ['export const View = () => <p>“매우 <em>강력한</em> 기능”이라고 말했다.</p>;', { format: 'tsx' }],
    ];
    for (const [source, options] of sources) {
      expect(ids(source, options)).not.toContain('KO-VAGUE-001');
      expect(ids(source, { ...options, ignoreQuotes: false })).toContain('KO-VAGUE-001');
    }
  });

  it('respects inline and ranged suppression directives', () => {
    const source = [
      '매우 강력한 기능이다. <!-- munche-ignore -->',
      '<!-- munche-disable KO-VAGUE-002 -->',
      '혁신적인 기능이다.',
      '<!-- munche-enable -->',
      '탁월한 기능이다.',
    ].join('\n');
    const report = analyze(source, { format: 'markdown' });
    const vague = report.diagnostics.filter((item) => item.ruleId.startsWith('KO-VAGUE'));

    expect(vague.some((item) => item.excerpt.includes('매우'))).toBe(false);
    expect(vague.some((item) => item.excerpt.includes('혁신적인'))).toBe(false);
    expect(vague.some((item) => item.excerpt.includes('탁월한'))).toBe(true);
  });

  it('closes the matching rule-specific suppression when directives are nested', () => {
    const source = [
      '<!-- munche-disable KO-VAGUE-001 -->',
      '<!-- munche-disable KO-VAGUE-002 -->',
      '<!-- munche-enable KO-VAGUE-001 -->',
      '매우 강력한 기능이다.',
      '<!-- munche-enable KO-VAGUE-002 -->',
    ].join('\n');
    const report = analyze(source, { format: 'markdown' });
    expect(report.diagnostics.map((item) => item.ruleId)).toContain('KO-VAGUE-001');
    expect(report.diagnostics.map((item) => item.ruleId)).not.toContain('KO-VAGUE-002');
  });

  it('ignores suppression-looking text outside real prose comments', () => {
    const markdown = [
      '```html',
      '<!-- munche-disable -->',
      '```',
      '',
      '매우 강력한 기능이다.',
    ].join('\n');
    const json = '{"example":"<!-- munche-disable -->","copy":"매우 강력한 기능"}';
    const html = '<script><!-- munche-disable --></script><p>매우 강력한 기능</p>';

    expect(ids(markdown, { format: 'markdown' })).toContain('KO-VAGUE-001');
    expect(ids(json, { format: 'json' })).toContain('KO-VAGUE-001');
    expect(ids(html, { format: 'html' })).toContain('KO-VAGUE-001');
  });

  it('detects repeated endings and register mismatch at document level', () => {
    const source = '설정을 바꿉니다. 서버를 다시 띄웁니다. 로그를 확인합니다. 결과를 기록합니다.';
    const report = analyze(source, { profile: 'tech-blog' });

    expect(report.diagnostics.map((item) => item.ruleId)).toEqual(
      expect.arrayContaining(['KO-END-001', 'KO-REGISTER-001']),
    );
  });

  it('surfaces source parse errors instead of linting code as prose', () => {
    const report = analyze('{"message": "매우 강력한 기능}', { format: 'json' });
    expect(report.diagnostics[0]?.ruleId).toBe('KO-PARSE-001');
    expect(report.summary.error).toBeGreaterThan(0);

    const html = analyze('<p title="매우 강력한><span>본문</p>', { format: 'html' });
    expect(html.diagnostics[0]?.ruleId).toBe('KO-PARSE-001');
  });

  it('extracts Korean prose from raw HTML blocks inside Markdown', () => {
    expect(ids('<div>매우 강력한 기능</div>', { format: 'markdown' })).toContain('KO-VAGUE-001');
  });

  it('recognizes broad haeyo endings and bieup hortatives', () => {
    for (const sentence of ['가요.', '와요.', '봐요.']) expect(classifyRegister(sentence)).toBe('casual');
    expect(classifyRegister('함께 봅시다.')).toBe('polite');
  });

  it('supports JSONC trailing commas and protects Markdown frontmatter', () => {
    const jsonc = analyze('{\n  // comment\n  "message": "매우 강력한 기능",\n}', { format: 'json' });
    expect(jsonc.summary.error).toBe(0);
    expect(jsonc.diagnostics.map((item) => item.ruleId)).toContain('KO-VAGUE-001');

    const markdown = analyze('---\ntitle: 매우 강력한 제목\n---\n\n본문은 구체적으로 썼다.', { format: 'markdown' });
    expect(markdown.diagnostics.map((item) => item.ruleId)).not.toContain('KO-VAGUE-001');

    const spacedFence = analyze('---   \ntitle: 매우 강력한 제목\n--- \n\n본문은 구체적으로 썼다.', { format: 'markdown' });
    expect(spacedFence.diagnostics.map((item) => item.ruleId)).not.toContain('KO-VAGUE-001');
  });

  it('runs lexical patterns independently inside each prose value', () => {
    const boilerplate = '{"a":"오늘날","b":"오늘날 문제를 살펴보겠습니다"}';
    const pair = '{"a":"단순한 기능","b":"단순한 도구를 넘어 새로운 흐름이다"}';

    expect(ids(boilerplate, { format: 'json' })).toContain('KO-BOILER-001');
    expect(ids(pair, { format: 'json' })).toContain('KO-PAIR-001');
  });

  it('does not let protection delimiters cross structured prose spans', () => {
    const sources: Array<[string, Parameters<typeof analyze>[1]]> = [
      ['{"open":"“","copy":"매우 강력한 기능","close":"”"}', { format: 'json' }],
      ['{"open":"`","copy":"매우 강력한 기능","close":"`"}', { format: 'json' }],
      ['{"open":"{{","copy":"매우 강력한 기능","close":"}}"}', { format: 'json' }],
      ['const open="“"; const copy="매우 강력한 기능"; const close="”";', { format: 'tsx' }],
      ['<script>const q="“";</script><p>매우 강력한 기능</p><i>”</i>', { format: 'html' }],
    ];
    for (const [source, options] of sources) {
      expect(ids(source, options)).toContain('KO-VAGUE-001');
    }
  });

  it('keeps real end-boundary findings in structured values', () => {
    expect(ids('{"message":"기능에 대해서"}', { format: 'json' })).toContain('KO-CALQUE-001');
    expect(ids('<p>기능에 대해서</p>', { format: 'html' })).toContain('KO-CALQUE-001');
    expect(ids('export const x = <p>기능에 대해서</p>;', { format: 'tsx' })).toContain('KO-CALQUE-001');
  });

  it('handles conditional ability, physical paths, standard based terms, and shell literals as hard negatives', () => {
    expect(ids('권한이 있어야 문서를 볼 수 있습니다.')).not.toContain('KO-POSS-001');
    expect(ids('다리를 통해서 강을 건넜다.')).not.toContain('KO-CALQUE-002');
    expect(ids('클라우드 기반한 시스템이다.')).not.toContain('KO-CALQUE-003');
    expect(ids('터미널에서 !!를 입력하면 이전 명령이 실행됩니다.')).not.toContain('KO-PUNCT-001');
    expect(ids('이중 팩토리얼은 5!!이다.')).not.toContain('KO-PUNCT-001');
    expect(ids('Bash에서 !! 명령을 실행한다.')).not.toContain('KO-PUNCT-001');
    expect(ids('C에서 !!x는 불리언 변환이다.')).not.toContain('KO-PUNCT-001');
  });

  it('finds visible MDX and TSX attributes but skips internal attributes', () => {
    expect(ids('<Card title="매우 강력한 안내" />', { format: 'mdx' })).toContain('KO-VAGUE-001');
    expect(ids('<button data-testid="매우 강력한 검색">검색</button>', { format: 'tsx' })).not.toContain('KO-VAGUE-001');
  });

  it('keeps known hard negatives clean', () => {
    const clean = [
      '그건 내 결정이 아니다.',
      '터널을 통해서 반대편으로 갔다.',
      '행사를 예정대로 진행했다.',
      '다양한 생물이 사는 숲이다.',
    ];
    for (const sentence of clean) {
      const report = analyze(sentence);
      expect(report.diagnostics.filter((item) => item.severity !== 'info')).toHaveLength(0);
    }
  });

  it('reports UTF-16 ranges after emoji exactly', () => {
    const source = '🙂 매우 빠르다.';
    const finding = analyze(source).diagnostics.find((item) => item.ruleId === 'KO-VAGUE-001');
    expect(finding?.range.start).toBe(source.indexOf('매우'));
    expect(finding?.location.start.column).toBe(4);
  });

  it('treats a lone carriage return as a source line break', () => {
    const finding = analyze('첫 문장이다.\r매우 빠르다.').diagnostics.find((item) => item.ruleId === 'KO-VAGUE-001');
    expect(finding?.location.start.line).toBe(2);
    expect(finding?.location.start.column).toBe(1);
  });
});
