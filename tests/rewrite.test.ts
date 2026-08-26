import { describe, expect, it, vi } from 'vitest';

import { AnthropicProvider } from '../src/providers/anthropic.js';
import { buildRewriteRequest, rewrite } from '../src/rewrite.js';
import type { RewriteProvider, RewriteProviderRequest } from '../src/types.js';

interface PromptSegment {
  id: string;
  text: string;
  findings?: Array<{
    ruleId: string;
    suggestions: Array<{ replacement?: string; message: string; risk: string }>;
  }>;
  approvedStyleCandidates?: Array<{ after: string }>;
  reason?: string;
  ruleIds?: string[];
}

function segmentsFromPrompt(prompt: string): PromptSegment[] {
  const body = prompt.split('독립적으로 다듬을 한국어 segment:\n')[1]?.split('\n\n다음 스키마')[0];
  if (!body) throw new Error('segment payload not found');
  return JSON.parse(body) as PromptSegment[];
}

function providerWith(transform: (segments: PromptSegment[], request: RewriteProviderRequest) => PromptSegment[]): RewriteProvider {
  return {
    name: 'mock',
    async complete(request) {
      const segments = segmentsFromPrompt(request.prompt).map(({ id, text }) => ({ id, text }));
      return JSON.stringify({ segments: transform(segments, request) });
    },
  };
}

describe('guarded rewrite', () => {
  const learnedStyle = {
    styleId: 'gounseon',
    promptContext: '승인 기반 문체 기억(JSON 데이터)\n{"kind":"munche-approved-style-memory"}',
    approvedExamples: [
      {
        before: '교정은 같은 의사를 만나는 일입니다.',
        after: '처음 상담한 의사가 교정이 끝날 때까지 진료합니다.',
        reasonTags: ['은유 줄이기', '직접적'],
        lockedClaims: ['동일한 담당의'],
      },
    ],
  };

  it('sends exact local suggestions under a minimum-copyedit contract', () => {
    const source = '가지런한 치아는 서두르지 않고 만듭니다.';
    const { request } = buildRewriteRequest(source, { profile: 'web' });
    const payload = segmentsFromPrompt(request.prompt);

    expect(request.system).toContain('카피라이터가 아니라 한국어 최소 교정자');
    expect(request.system).toContain('원문에 없는 속성, 효과, 혜택');
    expect(request.system).toContain('조사 역할, 서술어 논항');
    expect(request.system).toContain('고유명사, 제품·모델·기관명');
    expect(request.system).toContain('억지로 변주하지 않는다');
    expect(payload[0]?.findings?.[0]?.ruleId).toBe('KO-ATTACH-001');
    expect(payload[0]?.findings?.[0]?.suggestions[0]?.replacement).toBe('치아를 만들기 위해 서두르지 않습니다');
  });

  it('keeps minimal prompts unchanged by style memory and requires memory for natural mode', () => {
    const source = '교정은 같은 의사를 만나는 일입니다.';
    const minimal = buildRewriteRequest(source, { styleMemory: learnedStyle });
    expect(minimal.request.prompt).not.toContain('승인 기반 문체 기억');
    expect(minimal.request.prompt).not.toContain('approvedStyleCandidates');
    expect(() => buildRewriteRequest(source, { mode: 'natural' })).toThrow(/styleMemory/u);
  });

  it('replays an exact user-approved natural edit while keeping it review-only', async () => {
    const source = '교정은 같은 의사를 만나는 일입니다.';
    const approved = learnedStyle.approvedExamples[0]?.after;
    if (!approved) throw new Error('expected an approved example');
    const request = buildRewriteRequest(source, { mode: 'natural', styleMemory: learnedStyle });
    expect(request.request.prompt).toContain('승인 기반 문체 기억');
    expect(request.request.prompt).toContain('approvedStyleCandidates');
    const provider = providerWith((segments) => segments.map((segment) => ({
      id: segment.id,
      text: approved,
      reason: '승인 문장 재사용',
    })));
    const result = await rewrite(source, {
      provider,
      mode: 'natural',
      styleMemory: learnedStyle,
      maxChangedCharsRatio: 1,
    });

    expect(result.accepted).toBe(true);
    expect(result.text).toBe(approved);
    expect(result.changes[0]).toMatchObject({
      before: source,
      after: approved,
      segmentId: expect.stringMatching(/^SEG_/u),
      range: { start: 0, end: source.length },
    });
  });

  it('keeps an exact approved candidate available even when it is absent from bounded prompt context', () => {
    const source = '교정은 같은 의사를 만나는 일입니다.';
    const approved = learnedStyle.approvedExamples[0];
    if (!approved) throw new Error('expected an approved example');
    const memory = {
      ...learnedStyle,
      promptContext: '승인 기반 문체 기억(JSON 데이터)\n{"approvedExamples":[]}',
      approvedExamples: [
        ...Array.from({ length: 20 }, (_, index) => ({
          before: `관련 없는 원문 ${String(index)}`,
          after: `관련 없는 승인문 ${String(index)}`,
        })),
        approved,
      ],
    };
    const { request } = buildRewriteRequest(source, { mode: 'natural', styleMemory: memory });
    const payload = segmentsFromPrompt(request.prompt);

    expect(payload[0]?.approvedStyleCandidates).toMatchObject([{ after: approved.after }]);
  });

  it('treats similar approved examples as guidance, not permission to copy their claims', async () => {
    const source = '교정 상담에서 의사를 만납니다.';
    const approved = learnedStyle.approvedExamples[0]?.after;
    if (!approved) throw new Error('expected an approved example');
    const provider = providerWith((segments) => segments.map((segment) => ({ id: segment.id, text: approved })));
    const result = await rewrite(source, {
      provider,
      mode: 'natural',
      styleMemory: learnedStyle,
      maxChangedCharsRatio: 1,
    });

    expect(result.accepted).toBe(false);
    expect(result.text).toBe(source);
    expect(result.violations.join(' ')).toMatch(/내용어|상대 순서/u);
  });

  it('rejects terminal control sequences and oversized metadata from provider output', async () => {
    const source = '치료 계획을 설명합니다.';
    const escaped = providerWith((segments) => segments.map((segment) => ({
      id: segment.id,
      text: segment.text,
      reason: '\u001B]8;;https://evil.example\u0007가짜 검토',
    })));
    const tooManyRules = providerWith((segments) => segments.map((segment) => ({
      id: segment.id,
      text: segment.text,
      ruleIds: Array.from({ length: 201 }, (_, index) => `RULE-${String(index)}`),
    })));

    const escapedResult = await rewrite(source, { provider: escaped });
    const oversizedResult = await rewrite(source, { provider: tooManyRules });
    expect(escapedResult.accepted).toBe(false);
    expect(escapedResult.violations.join(' ')).toMatch(/reason|제어 문자/u);
    expect(oversizedResult.accepted).toBe(false);
    expect(oversizedResult.violations.join(' ')).toMatch(/ruleIds|200/u);
  });

  it('sends each HTML prose range once and accepts a no-op provider response', async () => {
    const source = [
      '<main>',
      '  <h1>',
      '    가지런한 치아는<br>서두르지 않고 만듭니다',
      '  </h1>',
      '  <p>',
      '    교정은 짧아도 1년입니다.',
      '  </p>',
      '</main>',
    ].join('\n');
    const { segments } = buildRewriteRequest(source, { format: 'html', profile: 'web' });
    const ranges = segments.map((segment) => `${String(segment.start)}:${String(segment.end)}`);
    const provider = providerWith((items) => items);
    const result = await rewrite(source, { provider, format: 'html', profile: 'web' });

    expect(new Set(ranges).size).toBe(ranges.length);
    expect(segments.every((segment, index, items) => (
      index === 0 || (items[index - 1]?.end ?? 0) <= segment.start
    ))).toBe(true);
    expect(result.accepted).toBe(true);
    expect(result.text).toBe(source);
    expect(result.violations).toEqual([]);
  });

  it('accepts the intended minimal repair and canonicalizes negation inflection', async () => {
    const source = '가지런한 치아는 서두르지 않고 만듭니다.';
    const provider = providerWith((segments) => segments.map((segment) => ({
      id: segment.id,
      text: segment.text.replace(source, '가지런한 치아를 만들기 위해 서두르지 않습니다.'),
      reason: '조사와 절 관계만 바로잡음',
      ruleIds: ['KO-ATTACH-001'],
    })));
    const result = await rewrite(source, { provider, profile: 'web' });

    expect(result.accepted).toBe(true);
    expect(result.text).toBe('가지런한 치아를 만들기 위해 서두르지 않습니다.');
    expect(result.changedCharsRatio).toBeLessThanOrEqual(0.35);
    expect(result.violations).toEqual([]);
  });

  it('never lets an exact suggestion override an explicitly supplied change limit', async () => {
    const source = '치아는 서두르지 않고 만듭니다.';
    const provider = providerWith((segments) => segments.map((segment) => ({
      id: segment.id,
      text: '치아를 만들기 위해 서두르지 않습니다.',
      ruleIds: ['KO-ATTACH-001'],
    })));
    const result = await rewrite(source, { provider, profile: 'web', maxChangedCharsRatio: 0 });

    expect(result.accepted).toBe(false);
    expect(result.violations.join(' ')).toMatch(/수정 비율/u);
  });

  it('rejects invented claims even when the character-change budget is fully open', async () => {
    const source = '가지런한 치아는 서두르지 않고 만듭니다.';
    const candidates = [
      '건강한 치아는 서두르지 않고 만듭니다.',
      '가지런한 치아는 안전하게 만듭니다.',
      '정밀한 진단을 바탕으로 가지런한 치아를 교정합니다.',
      '오래 유지되는 가지런한 치아를 만듭니다.',
      '서두르지 않기에 보다 가지런한 치아가 완성됩니다.',
      'premium 치아는 서두르지 않고 만듭니다.',
    ];

    for (const candidate of candidates) {
      const provider = providerWith((segments) => segments.map((segment) => ({ id: segment.id, text: candidate })));
      const result = await rewrite(source, { provider, profile: 'web', maxChangedCharsRatio: 1 });
      expect(result.accepted, candidate).toBe(false);
      expect(result.text).toBe(source);
      expect(result.violations.join(' ')).toMatch(/내용어/u);
    }
  });

  it('rejects deletion of negation instead of treating it as a harmless ending change', async () => {
    const source = '가지런한 치아는 서두르지 않고 만듭니다.';
    const provider = providerWith((segments) => segments.map((segment) => ({
      id: segment.id,
      text: '가지런한 치아를 만들기 위해 서두릅니다.',
    })));
    const result = await rewrite(source, { provider, profile: 'web', maxChangedCharsRatio: 1 });

    expect(result.accepted).toBe(false);
    expect(result.violations.join(' ')).toMatch(/부정·양태/u);
  });

  it('does not treat every content word inside a broad finding as removable', async () => {
    const source = '가지런한 치아는 서두르지 않고 만듭니다.';
    for (const candidate of ['가지런한 치아는 서두르지 않습니다.', '가지런한 않습니다.']) {
      const provider = providerWith((segments) => segments.map((segment) => ({
        id: segment.id,
        text: candidate,
      })));
      const result = await rewrite(source, { provider, profile: 'web', maxChangedCharsRatio: 1 });

      expect(result.accepted, candidate).toBe(false);
      expect(result.violations.join(' ')).toMatch(/내용어를 삭제/u);
    }
  });

  it('rejects a rewrite that introduces a new lint finding', async () => {
    const source = '가지런한 치아를 서두르지 않고 만듭니다.';
    const provider = providerWith((segments) => segments.map((segment) => ({
      id: segment.id,
      text: '가지런한 치아는 서두르지 않고 만듭니다.',
    })));
    const result = await rewrite(source, { provider, profile: 'web', maxChangedCharsRatio: 1 });

    expect(result.accepted).toBe(false);
    expect(result.violations.join(' ')).toContain('KO-ATTACH-001');
  });

  it('preserves register unless a local register finding authorizes a change', async () => {
    const source = '가지런한 치아는 서두르지 않고 만듭니다.';
    const provider = providerWith((segments) => segments.map((segment) => ({
      id: segment.id,
      text: '가지런한 치아를 서두르지 않고 만든다.',
    })));
    const result = await rewrite(source, { provider, profile: 'web', maxChangedCharsRatio: 1 });

    expect(result.accepted).toBe(false);
    expect(result.violations.join(' ')).toMatch(/종결 말투/u);
  });

  it('does not treat a sentence-level register finding as permission to delete facts', async () => {
    const source = '제품은 빠르다. 서비스는 안전합니다. 결과는 정확합니다.';
    const provider = providerWith((segments) => segments.map((segment) => ({
      id: segment.id,
      text: '서비스는 안전합니다. 결과는 정확합니다.',
    })));
    const result = await rewrite(source, { provider, profile: 'web', maxChangedCharsRatio: 1 });

    expect(result.accepted).toBe(false);
    expect(result.violations.join(' ')).toMatch(/내용어를 삭제/u);
  });

  it('detects removal of one repeated content-word occurrence', async () => {
    const source = '중요 중요';
    const provider = providerWith((segments) => segments.map((segment) => ({ id: segment.id, text: '중요' })));
    const result = await rewrite(source, { provider, maxChangedCharsRatio: 1 });

    expect(result.accepted).toBe(false);
    expect(result.violations.join(' ')).toMatch(/내용어를 삭제/u);
  });

  it('binds negation to its neighboring predicate instead of comparing only global counts', async () => {
    const source = '저는 안 가고 그는 옵니다.';
    const provider = providerWith((segments) => segments.map((segment) => ({
      id: segment.id,
      text: '저는 가고 그는 안 옵니다.',
    })));
    const result = await rewrite(source, { provider, maxChangedCharsRatio: 1 });

    expect(result.accepted).toBe(false);
    expect(result.violations.join(' ')).toMatch(/부정·양태/u);
  });

  it('rejects an unapproved change from a manner relation to a causal relation', async () => {
    const source = '가지런한 치아는 서두르지 않고 만듭니다.';
    const provider = providerWith((segments) => segments.map((segment) => ({
      id: segment.id,
      text: '서두르지 않기에 가지런한 치아를 만듭니다.',
    })));
    const result = await rewrite(source, { provider, profile: 'web', maxChangedCharsRatio: 1 });

    expect(result.accepted).toBe(false);
    expect(result.violations.join(' ')).toMatch(/부정·양태/u);
  });

  it.each([
    ['문제가 없어서 진행합니다.', '문제가 없으면 진행합니다.'],
    ['사실이 아니어서 보류합니다.', '사실이 아니면 보류합니다.'],
    ['검토가 필요해서 기다립니다.', '검토가 필요하면 기다립니다.'],
    ['지금 확인할 수 있어서 진행합니다.', '지금 확인할 수 있으면 진행합니다.'],
    ['문제가 없으니 진행합니다.', '문제가 없거든 진행합니다.'],
  ])('preserves causal and conditional relations: %s', async (source, candidate) => {
    const provider = providerWith((segments) => segments.map((segment) => ({ id: segment.id, text: candidate })));
    const result = await rewrite(source, { provider, maxChangedCharsRatio: 1 });

    expect(result.accepted).toBe(false);
    expect(result.violations.join(' ')).toMatch(/부정·양태/u);
  });

  it.each([
    ['문서를 검토한다.', '문서를 검토했다.'],
    ['제품을 설계한다.', '제품을 설계하였다.'],
  ])('preserves tense: %s', async (source, candidate) => {
    const provider = providerWith((segments) => segments.map((segment) => ({ id: segment.id, text: candidate })));
    const result = await rewrite(source, { provider, maxChangedCharsRatio: 1 });

    expect(result.accepted).toBe(false);
    expect(result.violations.join(' ')).toMatch(/시제/u);
  });

  it.each([
    ['의사가 환자를 치료합니다.', '의사를 환자가 치료합니다.'],
    ['사용자가 문서를 찾습니다.', '사용자를 문서가 찾습니다.'],
  ])('preserves subject and object particle roles: %s', async (source, candidate) => {
    const provider = providerWith((segments) => segments.map((segment) => ({ id: segment.id, text: candidate })));
    const result = await rewrite(source, { provider, maxChangedCharsRatio: 1 });

    expect(result.accepted).toBe(false);
    expect(result.violations.join(' ')).toMatch(/조사 역할/u);
  });

  it.each(['치료를 시작합니다?', '치료를 시작합니다!'])(
    'preserves sentence force: %s',
    async (candidate) => {
      const source = '치료를 시작합니다.';
      const provider = providerWith((segments) => segments.map((segment) => ({ id: segment.id, text: candidate })));
      const result = await rewrite(source, { provider, maxChangedCharsRatio: 1 });

      expect(result.accepted).toBe(false);
      expect(result.violations.join(' ')).toMatch(/종결 부호/u);
    },
  );

  it('allows adding a declarative full stop without changing sentence force', async () => {
    const source = '치료를 시작합니다';
    const provider = providerWith((segments) => segments.map((segment) => ({ id: segment.id, text: `${segment.text}.` })));
    const result = await rewrite(source, { provider, maxChangedCharsRatio: 1 });

    expect(result.accepted).toBe(true);
    expect(result.text).toBe('치료를 시작합니다.');
  });

  it('treats a regular past form and its contraction as the same tense', async () => {
    const source = '보았습니다.';
    const provider = providerWith((segments) => segments.map((segment) => ({ id: segment.id, text: '봤습니다.' })));
    const result = await rewrite(source, { provider, maxChangedCharsRatio: 1 });

    expect(result.accepted).toBe(true);
    expect(result.text).toBe('봤습니다.');
  });

  it('allows only the two exact local candidates when KO-ATTACH-001 is present', async () => {
    const source = '가지런한 치아는 서두르지 않고 만듭니다.';
    const candidates = [
      '치아는 가지런한 서두르지 않고 만듭니다.',
      '치아는 서두르지 않고 가지런한 만듭니다.',
    ];
    for (const candidate of candidates) {
      const provider = providerWith((segments) => segments.map((segment) => ({ id: segment.id, text: candidate })));
      const result = await rewrite(source, { provider, profile: 'web' });
      expect(result.accepted, candidate).toBe(false);
      expect(result.violations.join(' ')).toContain('KO-ATTACH-001');
    }
  });

  it('preserves shared content-word order for non-deterministic edits', async () => {
    const source = '가지런한 치아를 서두르지 않고 만듭니다.';
    const provider = providerWith((segments) => segments.map((segment) => ({
      id: segment.id,
      text: '치아를 가지런한 서두르지 않고 만듭니다.',
    })));
    const result = await rewrite(source, { provider, maxChangedCharsRatio: 1 });

    expect(result.accepted).toBe(false);
    expect(result.violations.join(' ')).toMatch(/상대 순서/u);
  });

  it('allows purpose markers only when an exact local suggestion introduces them', async () => {
    const source = '가지런한 치아를 서두르지 않고 만듭니다.';
    const provider = providerWith((segments) => segments.map((segment) => ({
      id: segment.id,
      text: '가지런한 치아를 위해 서두르지 않고 만듭니다.',
    })));
    const result = await rewrite(source, { provider, maxChangedCharsRatio: 1 });

    expect(result.accepted).toBe(false);
    expect(result.violations.join(' ')).toMatch(/내용어를 추가/u);
  });

  it('does not erase restrictive or additive particles during lexical validation', async () => {
    const cases: Array<[string, string]> = [
      ['가지런한 치아는 서두르지 않고 만듭니다.', '가지런한 치아만 서두르지 않고 만듭니다.'],
      ['모든 환자를 진료합니다.', '모든 환자만 진료합니다.'],
      ['환자를 진료합니다.', '환자도 진료합니다.'],
    ];
    for (const [source, candidate] of cases) {
      const provider = providerWith((segments) => segments.map((segment) => ({ id: segment.id, text: candidate })));
      const result = await rewrite(source, { provider, maxChangedCharsRatio: 1 });
      expect(result.accepted, candidate).toBe(false);
      expect(result.violations.join(' ')).toMatch(/내용어/u);
    }
  });

  it('composes an exact attachment repair with a conservative edit in the next sentence', async () => {
    const source = '가지런한 치아는 서두르지 않고 만듭니다. 매우 강력한 기능입니다.';
    const provider = providerWith((segments) => segments.map((segment) => ({
      id: segment.id,
      text: segment.text
        .replace('가지런한 치아는 서두르지 않고 만듭니다.', '가지런한 치아를 만들기 위해 서두르지 않습니다.')
        .replace('매우 강력한 기능입니다.', '기능입니다.'),
      ruleIds: segment.text.includes('치아는') ? ['KO-ATTACH-001'] : [],
    })));
    const result = await rewrite(source, { provider, profile: 'web', maxChangedCharsRatio: 1 });

    expect(result.accepted).toBe(true);
    expect(result.text).toBe('가지런한 치아를 만들기 위해 서두르지 않습니다. 기능입니다.');
  });

  it('accepts conservative segment edits while reconstructing protected source locally', async () => {
    const provider = providerWith((segments) => segments.map((segment) => ({
      ...segment,
      text: segment.text.replace('매우 강력한 검색 기능을 통해서', '검색 기능으로'),
      reason: '과장과 번역투를 줄임',
      ruleIds: ['KO-VAGUE-001', 'KO-CALQUE-002'],
    })));
    const source = '매우 강력한 검색 기능을 통해서 `displayName` 3개를 확인했습니다.';
    const result = await rewrite(source, { provider, preserveTerms: ['displayName'], maxChangedCharsRatio: 0.8 });

    expect(result.accepted).toBe(true);
    expect(result.text).toBe('검색 기능으로 `displayName` 3개를 확인했습니다.');
    expect(result.changes).toHaveLength(1);
  });

  it('rejects missing, duplicated, or reordered segment IDs', async () => {
    const provider = providerWith((segments) => [...segments.slice(1), ...segments.slice(0, 1)]);
    const source = '매우 강력한 기능이다. `displayName` 또한 혁신적인 기능이다.';
    const result = await rewrite(source, { provider, maxChangedCharsRatio: 1 });

    expect(result.accepted).toBe(false);
    expect(result.text).toBe(source);
    expect(result.violations.join(' ')).toMatch(/segment.*ID|순서/u);
  });

  it('rejects source syntax injection and malformed structured output', async () => {
    const htmlProvider = providerWith((segments) => segments.map((segment, index) => ({
      ...segment,
      text: index === 0 ? `${segment.text}<script src="https://evil.example/x.js"></script>` : segment.text,
    })));
    const markdown = '# 제목\n\n매우 강력한 기능입니다.';
    const injected = await rewrite(markdown, { provider: htmlProvider, format: 'markdown', maxChangedCharsRatio: 1 });
    expect(injected.accepted).toBe(false);
    expect(injected.violations.join(' ')).toMatch(/구조|URL|코드/u);

    const jsonProvider = providerWith((segments) => segments.map((segment) => ({ ...segment, text: `${segment.text}"` })));
    const json = '{"message":"매우 강력한 기능입니다."}';
    const malformed = await rewrite(json, { provider: jsonProvider, format: 'json', maxChangedCharsRatio: 1 });
    expect(malformed.accepted).toBe(false);
    expect(malformed.violations.join(' ')).toMatch(/파싱|구조/u);
  });

  it('does not expose protected values in the provider prompt', () => {
    const source = '공식 주소 https://private.example/path와 secret-alpha를 확인합니다.';
    const { request, segments } = buildRewriteRequest(source, {
      preservePatterns: ['secret-[a-z]+'],
    });

    expect(request.prompt).not.toContain('https://private.example/path');
    expect(request.prompt).not.toContain('secret-alpha');
    expect(segments.every((segment) => !segment.original.includes('private.example'))).toBe(true);
  });

  it('keeps semantic anchors editable in the provider segment', () => {
    const source = '가지런한 치아는 서두르지 않고 만듭니다.';
    const { request, segments } = buildRewriteRequest(source, {});

    expect(request.prompt).toContain('않고');
    expect(segments[0]?.original).toContain('않고');
  });

  it('rejects newly invented numbers, negation, modality, or protected tokens', async () => {
    const provider = providerWith((segments) => segments.map((segment, index) => ({
      ...segment,
      text: index === 0 ? `${segment.text} 40명은 안 할 수 있습니다.` : segment.text,
    })));
    const source = '참석자는 삼십 명이었다. 결과를 설명합니다.';
    const result = await rewrite(source, { provider, maxChangedCharsRatio: 1 });

    expect(result.accepted).toBe(false);
    expect(result.violations.join(' ')).toMatch(/수치|부정|양태|구조/u);
  });

  it('rejects a whole-segment duplication under the default change budget', async () => {
    const provider = providerWith((segments) => segments.map((segment) => ({ ...segment, text: `${segment.text}${segment.text}` })));
    const source = '이 문장은 매우 길고 구체적인 설명을 담고 있지만 그대로 한 번 더 복제하면 안 됩니다.';
    const result = await rewrite(source, { provider });

    expect(result.accepted).toBe(false);
    expect(result.violations.join(' ')).toMatch(/수정 비율/u);
  });

  it('rejects duplicated content even when the character-change budget is fully open', async () => {
    const source = '가지런한 치아는 서두르지 않고 만듭니다.';
    const provider = providerWith((segments) => segments.map((segment) => ({
      id: segment.id,
      text: `${segment.text} ${segment.text}`,
    })));
    const result = await rewrite(source, { provider, maxChangedCharsRatio: 1 });

    expect(result.accepted).toBe(false);
    expect(result.violations.join(' ')).toMatch(/내용어를 추가/u);
  });

  it('rejects fenced, prose-wrapped, and extra-field model output', async () => {
    const source = '가지런한 치아는 서두르지 않고 만듭니다.';
    const rawProviders: RewriteProvider[] = [
      { name: 'fenced', async complete() { return '```json\n{"segments":[]}\n```'; } },
      { name: 'wrapped', async complete() { return '결과: {"segments":[]}'; } },
      { name: 'extra', async complete() { return '{"segments":[],"note":"ok"}'; } },
    ];
    for (const provider of rawProviders) {
      const result = await rewrite(source, { provider, maxChangedCharsRatio: 1 });
      expect(result.accepted).toBe(false);
      expect(result.violations.join(' ')).toMatch(/JSON|허용되지 않은/u);
    }
  });

  it('calls the Anthropic Messages API with redirect and response guards', async () => {
    let captured: RequestInit | undefined;
    const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      captured = init;
      return new Response(JSON.stringify({ content: [{ type: 'text', text: '{"segments":[]}' }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    const provider = new AnthropicProvider({ apiKey: 'secret', model: 'model-from-user', fetch: fetchMock });
    const response = await provider.complete({ system: 'system', prompt: 'prompt', maxTokens: 1234 });

    expect(response).toContain('segments');
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(String(captured?.body)).toContain('model-from-user');
    expect(captured?.redirect).toBe('error');
    expect(captured?.signal).toBeInstanceOf(AbortSignal);
    expect((captured?.headers as Record<string, string>)['anthropic-version']).toBe('2023-06-01');
  });

  it('rejects insecure endpoints and oversized or non-JSON responses', async () => {
    expect(() => new AnthropicProvider({ apiKey: 'x', model: 'm', baseUrl: 'http://example.com' })).toThrow(/https/u);

    const wrongType = new AnthropicProvider({
      apiKey: 'x',
      model: 'm',
      fetch: vi.fn(async () => new Response('ok', { headers: { 'content-type': 'text/plain' } })),
    });
    await expect(wrongType.complete({ system: 's', prompt: 'p', maxTokens: 10 })).rejects.toThrow(/content type/u);

    const tooLarge = new AnthropicProvider({
      apiKey: 'x',
      model: 'm',
      maxResponseBytes: 10,
      fetch: vi.fn(async () => new Response('{"content":[]}', { headers: { 'content-type': 'application/json' } })),
    });
    await expect(tooLarge.complete({ system: 's', prompt: 'p', maxTokens: 10 })).rejects.toThrow(/size limit/u);
  });
});
