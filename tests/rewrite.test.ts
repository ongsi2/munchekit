import { describe, expect, it, vi } from 'vitest';

import { AnthropicProvider } from '../src/providers/anthropic.js';
import { buildRewriteRequest, rewrite } from '../src/rewrite.js';
import type { RewriteProvider, RewriteProviderRequest } from '../src/types.js';

interface PromptSegment {
  id: string;
  text: string;
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
      const segments = segmentsFromPrompt(request.prompt);
      return JSON.stringify({ segments: transform(segments, request) });
    },
  };
}

describe('guarded rewrite', () => {
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
