import { createDocument } from './document.js';
import { analyze } from './engine.js';
import { applyTextEdits, changedCharsRatio, changedCharsRatioForEdits } from './fixes.js';
import { compileUserPattern } from './patterns.js';
import { resolveProfile } from './profiles.js';
import type {
  RewriteChange,
  RewriteOptions,
  RewriteProviderRequest,
  RewriteResult,
  TextRange,
} from './types.js';

interface RewriteSegment extends TextRange {
  id: string;
  original: string;
}

interface ModelSegment {
  id: string;
  text: string;
  reason?: string;
  ruleIds?: string[];
}

interface ModelPayload {
  segments?: unknown;
}

function hash(value: string): string {
  let result = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    result ^= value.charCodeAt(index);
    result = Math.imul(result, 0x01000193);
  }
  return (result >>> 0).toString(16).padStart(8, '0');
}

function collectMatches(text: string, pattern: RegExp): TextRange[] {
  const flags = pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`;
  return [...text.matchAll(new RegExp(pattern.source, flags))].flatMap((match) =>
    match.index === undefined || !match[0] ? [] : [{ start: match.index, end: match.index + match[0].length }],
  );
}

function mergeRanges(ranges: TextRange[], length: number): TextRange[] {
  const sorted = ranges
    .filter((range) => range.start >= 0 && range.end > range.start && range.end <= length)
    .sort((left, right) => left.start - right.start || left.end - right.end);
  const output: TextRange[] = [];
  for (const range of sorted) {
    const previous = output.at(-1);
    if (previous && range.start <= previous.end) previous.end = Math.max(previous.end, range.end);
    else output.push({ ...range });
  }
  return output;
}

function subtractRanges(ranges: TextRange[], excluded: TextRange[], length: number): TextRange[] {
  const barriers = mergeRanges(excluded, length);
  const output: TextRange[] = [];
  let barrierIndex = 0;
  for (const range of mergeRanges(ranges, length)) {
    while ((barriers[barrierIndex]?.end ?? Number.POSITIVE_INFINITY) <= range.start) barrierIndex += 1;
    let cursor = range.start;
    for (let index = barrierIndex; index < barriers.length; index += 1) {
      const barrier = barriers[index];
      if (!barrier) break;
      if (barrier.start >= range.end) break;
      if (barrier.start > cursor) output.push({ start: cursor, end: Math.min(barrier.start, range.end) });
      cursor = Math.max(cursor, barrier.end);
      if (cursor >= range.end) break;
    }
    if (cursor < range.end) output.push({ start: cursor, end: range.end });
    while ((barriers[barrierIndex]?.end ?? Number.POSITIVE_INFINITY) <= range.end) barrierIndex += 1;
  }
  return output;
}

const invariantPatterns: RegExp[] = [
  /```[\s\S]*?```|~~~[\s\S]*?~~~/gu,
  /`[^`\n]+`/gu,
  /https?:\/\/[^\s<>"')\]]+/giu,
  /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu,
  /\]\([^\s)]+(?:\s+"[^"]*")?\)/gu,
  /<\/?[A-Za-z][^>]*>/gu,
  /\$\{[^}\n]+\}|\{\{[^}\n]+\}\}|%\([^)]+\)s|%[sd]/gu,
  /(?:[A-Za-z]:\\|\.\.?\/|\/)[^\s<>"')\]]+/gu,
  /--[a-z][a-z0-9-]*/giu,
  /\b(?:[A-Za-z]+[._-])?[A-Za-z]*[A-Z][A-Za-z0-9]*\b/gu,
  /\b[A-Za-z][A-Za-z0-9_-]*\.(?:js|jsx|ts|tsx|json|md|mdx|html|css|yml|yaml)\b/giu,
  /(?<![\p{L}\p{N}])[-+]?\d[\d,.]*(?:%|퍼센트|개|명|건|회|분|초|시간|일|주|개월|년|배|px|ms|MB|GB)?/gu,
  /(?:하나|둘|셋|넷|다섯|여섯|일곱|여덟|아홉|열|한|두|세|네|일|이|삼|사|오|육|칠|팔|구|십|백|천|만)(?=\s*(?:개|명|건|회|분|초|시간|일|주|개월|년|배)\b)/gu,
  /(?<![가-힣])안(?=$|[^가-힣])|못(?=\s*[가-힣])|않(?:다|습니다|아요|았다|았다면|으면)|아니(?:다|다만|며|면)|없(?:다|습니다|어요)/gu,
  /(?:수\s+있|수\s+없|해야|하여야|필요|가능|예정|추측|권장)(?:다|습니다|하다|합니다|된다|됩니다|이다|입니다)?/gu,
];

function customInvariantRanges(text: string, options: Omit<RewriteOptions, 'provider'>): TextRange[] {
  const ranges = invariantPatterns.flatMap((pattern) => collectMatches(text, pattern));
  for (const term of options.preserveTerms ?? []) {
    if (!term) continue;
    let cursor = 0;
    while (cursor < text.length) {
      const start = text.indexOf(term, cursor);
      if (start === -1) break;
      ranges.push({ start, end: start + term.length });
      cursor = start + term.length;
    }
  }
  for (const source of options.preservePatterns ?? []) {
    try {
      ranges.push(...collectMatches(text, compileUserPattern(source)));
    } catch {
      // Config loading reports invalid expressions. Direct API callers stay conservative here.
    }
  }
  return mergeRanges(ranges, text.length);
}

function collectInvariantValues(text: string, options: Omit<RewriteOptions, 'provider'>): string[] {
  return customInvariantRanges(text, options).map((range) => text.slice(range.start, range.end));
}

function sameMultiset(left: string[], right: string[]): boolean {
  const counts = new Map<string, number>();
  for (const value of left) counts.set(value, (counts.get(value) ?? 0) + 1);
  for (const value of right) counts.set(value, (counts.get(value) ?? 0) - 1);
  return [...counts.values()].every((count) => count === 0);
}

function buildSegments(text: string, options: Omit<RewriteOptions, 'provider'>): RewriteSegment[] {
  const document = createDocument(text, options);
  const ranges = subtractRanges(document.proseRanges, customInvariantRanges(text, options), text.length)
    .filter((range) => /[가-힣]/u.test(text.slice(range.start, range.end)));
  return ranges.map((range, index) => {
    const original = text.slice(range.start, range.end);
    return {
      ...range,
      original,
      id: `SEG_${String(index + 1).padStart(3, '0')}_${hash(`${String(range.start)}:${original}`)}`,
    };
  });
}

function structuralSignature(
  text: string,
  options: Omit<RewriteOptions, 'provider'>,
): { signature: string; errors: string[] } {
  const document = createDocument(text, options);
  let signature = text;
  for (const range of [...document.proseRanges].sort((left, right) => right.start - left.start)) {
    signature = `${signature.slice(0, range.start)}⟪PROSE⟫${signature.slice(range.end)}`;
  }
  return { signature, errors: document.parseErrors.map((error) => error.message) };
}

function extractJsonObject(raw: string): ModelPayload {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/iu)?.[1];
  const first = raw.indexOf('{');
  const last = raw.lastIndexOf('}');
  const candidate = fenced ?? (first >= 0 && last >= first ? raw.slice(first, last + 1) : undefined);
  if (!candidate) throw new Error('재작성 응답에서 JSON 객체를 찾지 못했습니다.');
  return JSON.parse(candidate) as ModelPayload;
}

function parseModelSegments(value: unknown): ModelSegment[] {
  if (!Array.isArray(value)) throw new Error('재작성 응답의 segments가 배열이 아닙니다.');
  return value.map((item, index) => {
    if (!item || typeof item !== 'object') throw new Error(`segments[${String(index)}]가 객체가 아닙니다.`);
    const record = item as Record<string, unknown>;
    if (typeof record.id !== 'string' || typeof record.text !== 'string') {
      throw new Error(`segments[${String(index)}]에는 문자열 id와 text가 필요합니다.`);
    }
    if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u.test(record.text)) {
      throw new Error(`segments[${String(index)}]에 허용되지 않은 제어 문자가 있습니다.`);
    }
    return {
      id: record.id,
      text: record.text,
      ...(typeof record.reason === 'string' ? { reason: record.reason } : {}),
      ...(Array.isArray(record.ruleIds)
        ? { ruleIds: record.ruleIds.filter((ruleId): ruleId is string => typeof ruleId === 'string') }
        : {}),
    };
  });
}

export function buildRewriteRequest(text: string, options: Omit<RewriteOptions, 'provider'>): {
  request: RewriteProviderRequest;
  segments: RewriteSegment[];
} {
  const report = analyze(text, options);
  const profile = resolveProfile(options.profile);
  const segments = buildSegments(text, options);
  const findings = report.diagnostics.map((diagnostic) => ({
    ruleId: diagnostic.ruleId,
    message: diagnostic.message,
    reason: diagnostic.rationale,
    suggestion: diagnostic.suggestions[0]?.message,
  }));
  const segmentPayload = segments.map((segment) => ({ id: segment.id, text: segment.original }));
  const system = [
    '당신은 한국어 문체 편집자다. 저자의 정체를 숨기거나 AI 탐지를 우회하지 않는다.',
    '각 segment의 뜻, 사실, 시제, 높임, 주체를 보존하면서 어색한 문장만 보수적으로 다듬는다.',
    'id를 바꾸거나 segment를 추가·삭제·재정렬하지 않는다. 소스 코드, 태그, URL, 수치, 인용문은 서버가 별도로 보존한다.',
    '원문이 이미 자연스러우면 text를 그대로 반환한다. JSON 이외의 설명이나 코드 펜스를 출력하지 않는다.',
  ].join('\n');
  const prompt = [
    `문체 프로필: ${profile.label} (${profile.description})`,
    `목표 말투: ${profile.register}`,
    '',
    '린터 진단:',
    JSON.stringify(findings, null, 2),
    '',
    '독립적으로 다듬을 한국어 segment:',
    JSON.stringify(segmentPayload, null, 2),
    '',
    '다음 스키마의 JSON만 출력:',
    '{"segments":[{"id":"SEG_...","text":"다듬은 문장","reason":"수정 이유","ruleIds":["KO-..."]}]}',
  ].join('\n');
  return {
    request: {
      system,
      prompt,
      maxTokens: Math.max(1024, Math.min(8192, Math.ceil(JSON.stringify(segmentPayload).length * 1.8))),
    },
    segments,
  };
}

export async function rewrite(text: string, options: RewriteOptions): Promise<RewriteResult> {
  const report = analyze(text, options);
  const { provider, ...providerOptions } = options;
  const violations: string[] = [];
  let candidate: string | undefined;
  let candidateRatio: number | undefined;
  let changes: RewriteChange[] = [];

  const maxRatio = options.maxChangedCharsRatio ?? 0.35;
  if (!Number.isFinite(maxRatio) || maxRatio < 0 || maxRatio > 1) {
    violations.push('maxChangedCharsRatio는 0 이상 1 이하여야 합니다.');
  }
  if (report.summary.error > 0) violations.push('원문 파싱 오류가 있어 재작성을 실행하지 않았습니다.');

  const { request, segments } = buildRewriteRequest(text, providerOptions);
  if (!violations.length && segments.length > 0) {
    try {
      const raw = await provider.complete(request);
      const payload = extractJsonObject(raw);
      const returned = parseModelSegments(payload.segments);
      const expectedIds = segments.map((segment) => segment.id);
      const returnedIds = returned.map((segment) => segment.id);
      if (expectedIds.join('|') !== returnedIds.join('|')) {
        throw new Error('재작성 segment의 개수, ID 또는 순서가 원문과 다릅니다.');
      }

      const allowedRuleIds = new Set(report.diagnostics.map((diagnostic) => diagnostic.ruleId));
      const edits = segments.map((segment, index) => {
        const result = returned[index];
        if (!result) throw new Error(`segment ${segment.id} 응답이 없습니다.`);
        const segmentRatio = changedCharsRatio(segment.original, result.text);
        if (segmentRatio > maxRatio) {
          violations.push(`segment ${segment.id} 수정 비율 ${segmentRatio.toFixed(3)}이 한도 ${maxRatio.toFixed(3)}을 넘었습니다.`);
        }
        if (segment.original !== result.text) {
          changes.push({
            before: segment.original,
            after: result.text,
            reason: result.reason ?? 'Claude segment 재작성(사람 검토 필요)',
            ruleIds: (result.ruleIds ?? []).filter((ruleId) => allowedRuleIds.has(ruleId)),
          });
        }
        return { start: segment.start, end: segment.end, replacement: result.text, safety: 'review' as const };
      });
      candidate = applyTextEdits(text, edits);
      candidateRatio = changedCharsRatioForEdits(text, candidate, edits);
    } catch (error) {
      violations.push(error instanceof Error ? error.message : String(error));
    }
  } else if (!violations.length) {
    candidate = text;
  }

  if (candidate) {
    const originalStructure = structuralSignature(text, providerOptions);
    const candidateStructure = structuralSignature(candidate, providerOptions);
    if (candidateStructure.errors.length) violations.push('재작성 후보가 원본 소스 형식으로 파싱되지 않습니다.');
    if (originalStructure.signature !== candidateStructure.signature) {
      violations.push('재작성 후보가 코드 또는 문서 구조를 바꿨습니다.');
    }
    if (!sameMultiset(collectInvariantValues(text, providerOptions), collectInvariantValues(candidate, providerOptions))) {
      violations.push('재작성 후보의 수치·부정·양태·URL·코드·보존 용어가 원문과 다릅니다.');
    }
  }

  const ratio = candidate ? (candidateRatio ?? changedCharsRatio(text, candidate)) : 0;
  if (candidate && ratio > maxRatio) {
    violations.push(`수정 비율 ${ratio.toFixed(3)}이 허용값 ${maxRatio.toFixed(3)}을 넘었습니다.`);
  }
  const accepted = Boolean(candidate) && violations.length === 0;
  return {
    original: text,
    ...(candidate ? { candidate } : {}),
    text: accepted && candidate ? candidate : text,
    accepted,
    violations,
    changes,
    report,
    provider: provider.name,
    changedCharsRatio: ratio,
  };
}
